import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Ignored build step contract: exit 0 skips Vercel build; exit 1 builds.
 * Never skip a production build unless a reliable Git diff proves the commit
 * contains ONLY documentation or GitHub CI configuration, not app files.
 */
export function isNonRuntimeChange(file) {
  if (typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\"))
    return false;
  if (file.split("/").includes("..")) return false;
  return (
    file.startsWith(".github/workflows/") ||
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file.startsWith("docs/") ||
    file.startsWith("documentation/") ||
    [
      "README.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "VERCEL_DEPLOY.md",
    ].includes(file)
  );
}

export function shouldIgnoreVercelBuild({ environment, ref, changedFiles }) {
  if (environment !== "production" || ref !== "main") return false;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every(isNonRuntimeChange);
}

export function changedFilesForCurrentCommit(
  git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1_000_000 }),
) {
  // git checkouts may be shallow or lack HEAD^: fail OPEN instead of skipping
  // a real change. Rename/copy/deletion paths are included in the diff.
  try {
    const raw = git(["diff", "--name-only", "-z", "HEAD^", "HEAD", "--"]);
    if (typeof raw !== "string" || !raw.includes("\0")) return null;
    return raw.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

export function vercelBuildDecision(env, git) {
  if (env.VERCEL_ENV !== "production" || env.VERCEL_GIT_COMMIT_REF !== "main")
    return { ignore: false, reason: "preview_or_unknown_branch" };
  const changedFiles = changedFilesForCurrentCommit(git);
  if (!changedFiles) return { ignore: false, reason: "missing_git_history" };
  return shouldIgnoreVercelBuild({
    environment: env.VERCEL_ENV,
    ref: env.VERCEL_GIT_COMMIT_REF,
    changedFiles,
  })
    ? { ignore: true, reason: "docs_and_ci_only" }
    : { ignore: false, reason: "runtime_or_unknown_changes" };
}

function main() {
  const decision = vercelBuildDecision(process.env);
  console.log(
    decision.ignore
      ? "Skip Vercel build: only non-runtime documentation/CI changed."
      : `Build Vercel application: ${decision.reason}.`,
  );
  process.exitCode = decision.ignore ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
