import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  changedFilesForCurrentCommit,
  isNonRuntimeChange,
  shouldIgnoreVercelBuild,
  vercelBuildDecision,
} from "./vercel-ignore-build.mjs";

test("docs and GitHub CI-only changes can skip a redundant production build", () => {
  for (const path of [
    "docs/architecture.md",
    "README.md",
    ".github/workflows/browser-qa.yml",
    ".github/ISSUE_TEMPLATE/bug.md",
    "VERCEL_DEPLOY.md",
  ]) {
    assert.equal(isNonRuntimeChange(path), true, path);
  }
  assert.equal(
    shouldIgnoreVercelBuild({
      environment: "production",
      ref: "main",
      changedFiles: ["docs/architecture.md", ".github/workflows/security.yml"],
    }),
    true,
  );
});

test("real runtime, production build configuration and public content always build", () => {
  for (const file of [
    "src/routes/index.tsx",
    "src/features/fore/api.server.ts",
    "scripts/build-persistence-backend.mjs",
    "scripts/stage-sites.mjs",
    "vercel.json",
    "vite.config.ts",
    "package-lock.json",
    "public/robots.txt",
    "public/manual.md",
    "drizzle/0071_epub_frontier_query_plan.sql",
    "wrangler.frontend.pilot.toml",
    "../README.md",
    "",
  ]) {
    assert.equal(isNonRuntimeChange(file), false, file);
    assert.equal(
      shouldIgnoreVercelBuild({
        environment: "production",
        ref: "main",
        changedFiles: ["README.md", file],
      }),
      false,
      file,
    );
  }
});

test("preview, unknown branch and empty commit always build", () => {
  for (const environment of ["preview", "development", undefined]) {
    assert.equal(
      shouldIgnoreVercelBuild({ environment, ref: "main", changedFiles: ["README.md"] }),
      false,
    );
  }
  assert.equal(
    shouldIgnoreVercelBuild({
      environment: "production",
      ref: "fix/staging",
      changedFiles: ["README.md"],
    }),
    false,
  );
  assert.equal(
    shouldIgnoreVercelBuild({ environment: "production", ref: "main", changedFiles: [] }),
    false,
  );
});

test("missing shallow Git history fails open, never suppresses production release", () => {
  const production = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" };
  assert.deepEqual(
    vercelBuildDecision(production, () => {
      throw new Error("shallow clone did not fetch parent");
    }),
    { ignore: false, reason: "missing_git_history" },
  );
  assert.equal(changedFilesForCurrentCommit(() => ""), null);
  assert.deepEqual(
    vercelBuildDecision(production, () => "README.md\0.github/workflows/security.yml\0"),
    { ignore: true, reason: "docs_and_ci_only" },
  );
  assert.deepEqual(
    vercelBuildDecision(production, () => "README.md\0src/routes/index.tsx\0"),
    { ignore: false, reason: "runtime_or_unknown_changes" },
  );
  assert.equal(
    vercelBuildDecision(
      { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "cost/preview" },
      () => {
        throw new Error("Preview should not need git");
      },
    ).ignore,
    false,
  );
});

test("repository Vercel config wires skip command and protects diagnostics previews", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.ignoreCommand, "node scripts/vercel-ignore-build.mjs");
  assert.equal(config.git.deploymentEnabled["diagnostics/**"], false);
  assert.equal(config.git.deploymentEnabled["docs/**"], false);
  assert.equal(config.fluid, true, "Never change runtime semantics to reduce build charges");
  assert.equal(config.services.app.framework, "tanstack-start");
});
