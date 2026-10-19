// Read-only repository-wide guard. The REST pagination boundary, rather than
// a racing total_count scalar, establishes the complete active-run inventory.
export async function requireBenchmarkIsolation(
  { token, runId, fetchImpl = fetch, now = () => new Date().toISOString() },
  ledger,
) {
  if (!token || !/^[1-9][0-9]*$/.test(String(runId)))
    throw Error("Benchmark isolation requires an Actions read token and run ID");
  const entry = { at: now(), runId: String(runId), verified: false, peers: [], pages: [] };
  ledger.push(entry);
  const inventory = new Map();
  let exhausted = false;
  for (let page = 1; page <= 4; page++) {
    let body;
    const attempts = [];
    entry.pages.push({ page, attempts });
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(
          `https://api.github.com/repos/JibrilMohamud/cove/actions/runs?status=in_progress&per_page=100&page=${page}`,
          {
            headers: {
              Authorization: "Bearer " + token,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Cache-Control": "no-cache",
            },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (response.ok) {
          body = await response.json();
          if (
            !Number.isSafeInteger(body.total_count) ||
            body.total_count < 0 ||
            !Array.isArray(body.workflow_runs) ||
            body.workflow_runs.length > 100
          )
            throw Error("invalid inventory schema");
          attempts.push({
            attempt,
            status: response.status ?? 200,
            reportedCount: body.total_count,
            returnedCount: body.workflow_runs.length,
          });
          break;
        }
      } catch {
        attempts.push({ attempt, error: "inventory response unavailable" });
        if (attempt === 3)
          throw Error("Cannot verify benchmark isolation: inventory unavailable after 3 attempts");
        continue;
      }
      attempts.push({ attempt, status: response.status });
      if (![502, 503, 504].includes(response.status) || attempt === 3)
        throw Error("Cannot verify benchmark isolation: Actions status " + response.status);
    }
    for (const run of body.workflow_runs) {
      if (
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.status !== "string" ||
        typeof run.name !== "string"
      )
        throw Error("Cannot verify benchmark isolation: malformed run inventory");
      inventory.set(String(run.id), run);
    }
    // Fetch through an EMPTY page even after a short page. This independently
    // confirms exhaustion if total_count includes a run that changed status
    // while GitHub assembled its count and list. No unseen page is skipped.
    if (body.workflow_runs.length === 0) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) throw Error("Cannot verify complete benchmark inventory within 4 pages");
  if (!inventory.has(String(runId)))
    throw Error("Cannot verify benchmark isolation: current run missing from inventory");
  entry.peers = [...inventory.values()]
    .filter(
      (run) =>
        String(run.id) !== String(runId) &&
        run.status === "in_progress" &&
        (/^cloudflare-.*-paired$/.test(run.name) ||
          /^(fullsite-performance|production-storefront-performance)$/.test(run.name)),
    )
    .map((run) => ({ id: run.id, name: run.name, sha: run.head_sha, branch: run.head_branch }));
  if (entry.peers.length)
    throw Error(
      "Competing performance campaign active: " + entry.peers.map((run) => run.id).join(", "),
    );
  entry.verified = true;
}
