// Read-only repository-wide guard: concurrency groups on old branches may differ.
export async function requireBenchmarkIsolation(
  { token, runId, fetchImpl = fetch, now = () => new Date().toISOString() },
  ledger,
) {
  if (!token || !/^[1-9][0-9]*$/.test(String(runId)))
    throw Error("Benchmark isolation requires an Actions read token and run ID");
  const entry = { at: now(), runId: String(runId), verified: false, peers: [] };
  ledger.push(entry);
  const response = await fetchImpl(
    "https://api.github.com/repos/JibrilMohamud/cove/actions/runs?status=in_progress&per_page=100",
    {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw Error("Cannot verify benchmark isolation: Actions status " + response.status);
  const body = await response.json();
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
