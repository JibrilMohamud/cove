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

function main() {
  const service = process.argv[2];
  const changedFiles = changedSinceLastSuccess();
  const build = shouldBuildService(service, process.env.VERCEL_ENV, changedFiles);
  console.log(
    `Cove Vercel build guard: service=${service}, environment=${process.env.VERCEL_ENV || "unknown"}, decision=${build ? "build" : "skip"}, changed=${changedFiles?.length ?? "unknown"}`,
  );
  process.exitCode = build ? 1 : 0; // Vercel: exit 0 skips; exit 1 builds.
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
