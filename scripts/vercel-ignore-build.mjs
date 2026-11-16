import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const VALID_SHA = /^[a-f0-9]{40}$/i;

/**
 * Vercel Services build independently. Conservatively classify the files
 * changed since the last successful deployment of THIS branch. Unknown files
 * always rebuild both services; never infer permissions from a commit title.
 */
export function affectedServices(file) {
  if (typeof file !== "string" || !file || file.startsWith("/") || file.includes(".."))
    return "both";
  const name = file.replaceAll("\\", "/");
  if (
    name.startsWith(".github/") ||
    name.startsWith("docs/") ||
    ["README.md", "CONTRIBUTING.md", "CHANGELOG.md", "LICENSE", "LICENSE.md"].includes(name)
  )
    return "neither";
  if (
    name.startsWith("scripts/audio_pipeline/") ||
    name === "scripts/Dockerfile.vercel" ||
    name === "scripts/pyproject.toml" ||
    name === "scripts/requirements.txt" ||
    name === "scripts/soundtracks/profile-requirements.txt"
  )
    return "audio";
  if (
    name.startsWith("src/") ||
    name.startsWith("public/") ||
    name.startsWith("drizzle/") ||
    name.startsWith("scripts/check-") ||
    name === "scripts/local-api.mjs" ||
    name === "scripts/build-offline-reader.mjs" ||
    name === "scripts/stage-sites.mjs" ||
    ["package.json", "package-lock.json", "vite.config.ts", "index.html"].includes(name) ||
    name.startsWith("tsconfig") ||
    name.startsWith("eslint") ||
    name.startsWith("postcss") ||
    name.startsWith("components.")
  )
    return "app";
  // In particular vercel.json, this guard, Vercel settings, new file types
  // and unidentified build helpers must never silently suppress a release.
  return "both";
}

export function shouldBuildService(service, environment, changedFiles) {
  if (!["app", "audio"].includes(service)) return true;
  // Never interfere with production or manually requested deployments.
  if (environment !== "preview") return true;
  if (!Array.isArray(changedFiles) || !changedFiles.every((f) => typeof f === "string"))
    return true;
  return changedFiles.some((file) => {
    const target = affectedServices(file);
    return target === "both" || target === service;
  });
}

/**
 * If history is missing (Vercel's shallow Git clone), build instead of
 * guessing from HEAD^ or accidentally dropping a prior change on a PR.
 */
export function changedSinceLastSuccess(env = process.env, git = execFileSync) {
  const previous = env.VERCEL_GIT_PREVIOUS_SHA;
  if (!VALID_SHA.test(previous || "")) return null;
  try {
    const options = { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 };
    const head = git("git", ["rev-parse", "HEAD"], options).trim();
    if (!VALID_SHA.test(head)) return null;
    const result = git(
      "git",
      ["diff", "--no-ext-diff", "--name-only", previous, head, "--"],
      options,
    );
    return result.split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}


/**
 * Single-use audit-release exemption. Vercel's automatic `main` deployment
 * would otherwise rebuild customer services for a GitHub Actions workflow
 * plus a READ-ONLY legal-audit script. To avoid an automatic customer
 * deployment, reject unless this is exactly the pre-reviewed four-file
 * change immediately after the CURRENT deployed production commit.
 *
 * This exemption cannot be reused after that one parent commit. Any unknown
 * history, merge commit, extra path, changed production baseline, preview,
 * or manual deployment falls back to BUILD. A check failure NEVER skips.
 */
const PINNED_AUDIT_PRODUCTION_PARENT =
  "c959eaed64c58f7d9675c0c8b6852c70f4914dec";
const AUDIT_FILES = new Set([
  ".github/workflows/cove-protected-real-rights-spot-readonly.yml",
  "scripts/release/check-protected-production-rights-spot.mjs",
  "scripts/vercel-ignore-build.mjs",
  "scripts/check-vercel-one-shot-audit-no-deploy.mjs",
]);

export function shouldSkipPinnedProductionAudit(
  env = process.env,
  git = execFileSync,
) {
  if (env.VERCEL_ENV !== "production" || env.VERCEL_GIT_COMMIT_REF !== "main")
    return false;
  try {
    const opts = { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 };
    const root = git("git", ["rev-parse", "--show-toplevel"], opts).trim();
    if (!root || root.includes("\u0000")) return false;
    const run = (args) => git("git", ["-C", root, ...args], opts).trim();
    const parents = run(["show", "-s", "--format=%P", "HEAD"])
      .split(/\s+/)
      .filter(Boolean);
    if (parents.length !== 1 || parents[0] !== PINNED_AUDIT_PRODUCTION_PARENT)
      return false;
    const head = run(["rev-parse", "HEAD"]);
    if (!VALID_SHA.test(head) || head === PINNED_AUDIT_PRODUCTION_PARENT)
      return false;
    const changed = run([
      "diff",
      "--no-ext-diff",
      "--name-only",
      PINNED_AUDIT_PRODUCTION_PARENT,
      head,
      "--",
    ])
      .split(/\r?\n/)
      .filter(Boolean);
    return (
      changed.length === AUDIT_FILES.size &&
      new Set(changed).size === AUDIT_FILES.size &&
      changed.every((file) => AUDIT_FILES.has(file))
    );
  } catch {
    return false;
  }
}

function main() {
  const service = process.argv[2];
  if (shouldSkipPinnedProductionAudit()) {
    console.log(
      `Cove Vercel build guard: service=${service}, environment=production, decision=skip, reason=pinned-readonly-audit-only-merge`,
    );
    process.exitCode = 0;
    return;
  }
  const changedFiles = changedSinceLastSuccess();
  const build = shouldBuildService(service, process.env.VERCEL_ENV, changedFiles);
  console.log(
    `Cove Vercel build guard: service=${service}, environment=${process.env.VERCEL_ENV || "unknown"}, decision=${build ? "build" : "skip"}, changed=${changedFiles?.length ?? "unknown"}`,
  );
  process.exitCode = build ? 1 : 0; // Vercel: exit 0 skips; exit 1 builds.
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
