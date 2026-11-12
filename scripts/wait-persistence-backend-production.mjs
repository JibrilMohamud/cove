import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workflow = "deploy-persistence-backend.yml";
const requiredSteps = [
  "Deploy persistence Worker",
  "Verify production persistence binding after deployment",
];

export function deployedBackendRun(runs, sha) {
  if (!Array.isArray(runs)) throw new Error("GitHub backend run list is malformed.");
  return (
    runs
      .filter((run) => run?.head_sha === sha && run?.event === "push")
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
  );
}

export function verifiedBackendDeployment(run, jobs) {
  if (run?.status !== "completed" || run.conclusion !== "success") return false;
  if (!Array.isArray(jobs)) return false;
  return jobs.some((job) => {
    if (job?.name !== "deploy" || job?.conclusion !== "success") return false;
    return requiredSteps.every((name) =>
      job.steps?.some((step) => step.name === name && step.conclusion === "success"),
    );
  });
}

/**
 * Vercel may promote a new frontend while the same SHA's production D1
 * migration/Worker deploy is still running. A healthy storefront can then
 * return an empty SSR shelf to its strict performance probe. Verify BOTH
 * exact deployments before testing. Never turn an empty/error page into a
 * passing latency sample, and never inspect or print secret values.
 *
 * A frontend-only commit has no deploy-persistence-backend run: in that case
 * no extra D1 release is required. The short second lookup closes the
 * GitHub Actions indexing window immediately after the push.
 */
export async function waitForBackendProduction({
  repository,
  sha,
  token,
  fetcher = fetch,
  timeoutMs = 22 * 60_000,
  pollMs = 10_000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  if (!token) throw new Error("Read-only GitHub Actions token is required.");
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function getJson(url) {
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok)
      throw new Error(`GitHub backend release evidence unavailable (HTTP ${response.status}).`);
    return response.json();
  }
  const listUrl = `${base}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=20`;
  const deadline = Date.now() + timeoutMs;
  let run = null;
  for (let discovery = 0; discovery < 2; discovery += 1) {
    run = deployedBackendRun((await getJson(listUrl)).workflow_runs, sha);
    if (run) break;
    if (discovery === 0) await pause(2_000);
  }
  if (!run) return "not-required";
  while (Date.now() <= deadline) {
    // A rerun/updated conclusion is authoritative, never an old PR check.
    const current = await getJson(`${base}/actions/runs/${run.id}`);
    if (current.head_sha !== sha || current.event !== "push")
      throw new Error("Production backend run changed its target commit.");
    if (current.status === "completed") {
      if (current.conclusion !== "success")
        throw new Error("Production persistence backend failed its deployment gate.");
      const jobs = (await getJson(`${base}/actions/runs/${run.id}/jobs?per_page=100`)).jobs;
      if (!verifiedBackendDeployment(current, jobs))
        throw new Error("Backend run completed without a verified production Worker deploy.");
      return "verified";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(remaining, pollMs));
  }
  throw new Error("Production backend deployment did not settle before the release gate.");
}

async function main() {
  const outcome = await waitForBackendProduction({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(
    outcome === "verified"
      ? "Exact commit's production persistence Worker was deployed and verified."
      : "Frontend-only push; no persistence backend deployment required.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
