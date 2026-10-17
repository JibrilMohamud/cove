import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/** Check the exact pushed commit, not an unrelated successful preview deployment. */
export function vercelCommitStatus(payload) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  const status = statuses.find((entry) => entry?.context === "Vercel");
  return ["success", "pending", "error", "failure"].includes(status?.state)
    ? status.state
    : "pending";
}

export async function waitForVercelProduction({
  repository,
  sha,
  token,
  fetcher = fetch,
  timeoutMs = 240_000,
  pollMs = 10_000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.match(repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  if (!token) throw new Error("Read-only GitHub workflow token is required.");
  const deadline = Date.now() + timeoutMs;
  let last = "pending";
  while (Date.now() <= deadline) {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/commits/${sha}/status`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub deployment status unavailable (${response.status}).`);
    last = vercelCommitStatus(await response.json());
    if (last === "success") return "success";
    if (last === "failure" || last === "error")
      throw new Error("The Vercel deployment for this commit did not succeed.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(remaining, pollMs));
  }
  throw new Error(`Vercel production status remained ${last} for the pushed commit.`);
}

async function main() {
  await waitForVercelProduction({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  // Allow the newly ready deployment's production alias to propagate before
  // making claims about the next release. This is not a warm-cache guarantee.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  console.log("Exact Vercel commit deployment is ready; production probing may begin.");
}

if (process.argv[1] && import.meta.url === new URL("file://" + fileURLToPath(new URL("file://" + process.argv[1]))).href) await main();
