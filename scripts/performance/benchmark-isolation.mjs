// Read-only repository-wide guard: concurrency groups on old branches may differ.
export async function requireBenchmarkIsolation(
  { token, runId, fetchImpl = fetch, now = () => new Date().toISOString() },
  ledger,
) {
  if (!token || !/^[1-9][0-9]*$/.test(String(runId)))
    throw Error("Benchmark isolation requires an Actions read token and run ID");
  const entry = { at: now(), runId: String(runId), verified: false, peers: [] };
  ledger.push(entry);
  // Retry only inventory transport/temporary service failures, never a peer,
  // authorization denial or incomplete inventory. No benchmark starts until a
  // complete successful inventory has been verified.
  let body;
  entry.attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(
        "https://api.github.com/repos/JibrilMohamud/cove/actions/runs?status=in_progress&per_page=100",
        {
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (response.ok) {
        body = await response.json();
        entry.attempts.push({ attempt, status: response.status ?? 200 });
        break;
      }
    } catch {
      // Do not log arbitrary transport messages: they may contain headers.
      entry.attempts.push({ attempt, error: "inventory transport failure" });
      if (attempt === 3)
        throw Error(
          "Cannot verify benchmark isolation: inventory transport failed after 3 attempts",
        );
      continue;
    }
    entry.attempts.push({ attempt, status: response.status });
    if (![502, 503, 504].includes(response.status) || attempt === 3)
      throw Error("Cannot verify benchmark isolation: Actions status " + response.status);
  }
  if (
    !Number.isSafeInteger(body.total_count) ||
    body.total_count > 100 ||
    !Array.isArray(body.workflow_runs) ||
    body.workflow_runs.length !== body.total_count
  )
    throw Error("Cannot verify complete benchmark run inventory");
  entry.peers = body.workflow_runs
    .filter(
      (run) =>
        String(run.id) !== String(runId) &&
        run.status === "in_progress" &&
        /^cloudflare-.*-paired$/.test(run.name || ""),
    )
    .map((run) => ({ id: run.id, name: run.name, sha: run.head_sha, branch: run.head_branch }));
  if (entry.peers.length)
    throw Error(
      "Competing performance campaign active: " + entry.peers.map((run) => run.id).join(", "),
    );
  entry.verified = true;
}
