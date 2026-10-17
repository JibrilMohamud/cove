import assert from "node:assert/strict";
import test from "node:test";
import {
  affectedServices,
  changedSinceLastSuccess,
  shouldBuildService,
} from "./vercel-ignore-build.mjs";

test("production, missing context and unknown services always rebuild", () => {
  assert.equal(shouldBuildService("app", "production", ["docs/readme.md"]), true);
  assert.equal(shouldBuildService("audio", "production", []), true);
  assert.equal(shouldBuildService("app", undefined, [".github/workflows/verify.yml"]), true);
  assert.equal(shouldBuildService("unknown", "preview", []), true);
  assert.equal(shouldBuildService("audio", "preview", null), true);
  assert.equal(shouldBuildService("app", "preview", [null]), true);
});

test("irrelevant documentation or workflow changes skip both preview service builds", () => {
  const files = [".github/workflows/security.yml", "docs/ARCHITECTURE.md", "README.md"];
  assert.equal(shouldBuildService("app", "preview", files), false);
  assert.equal(shouldBuildService("audio", "preview", files), false);
  assert.equal(shouldBuildService("app", "preview", []), false);
});

test("storefront revisions don't rebuild the FastAPI audio service", () => {
  const paths = ["src/features/fore/Store.tsx", "public/manifest.json", "vite.config.ts"];
  for (const file of paths) {
    assert.equal(affectedServices(file), "app");
    assert.equal(shouldBuildService("app", "preview", [file]), true);
    assert.equal(shouldBuildService("audio", "preview", [file]), false);
  }
  assert.equal(
    shouldBuildService("audio", "preview", ["src/server.ts", "scripts/check-store.mjs"]),
    false,
  );
});

test("audio-only changes don't rebuild unrelated app service", () => {
  for (const file of [
    "scripts/audio_pipeline/service.py",
    "scripts/audio_pipeline/requirements.txt",
    "scripts/Dockerfile.vercel",
    "scripts/requirements.txt",
  ]) {
    assert.equal(affectedServices(file), "audio");
    assert.equal(shouldBuildService("audio", "preview", [file]), true);
    assert.equal(shouldBuildService("app", "preview", [file]), false);
  }
});

test("shared and unrecognized changes fail open for both services", () => {
  for (const file of [
    "vercel.json",
    "scripts/unknown-build-helper.mjs",
    "new-root-file",
    "../escape",
  ]) {
    assert.equal(affectedServices(file), "both");
    assert.equal(shouldBuildService("app", "preview", [file]), true);
    assert.equal(shouldBuildService("audio", "preview", [file]), true);
  }
  const changed = ["src/routes/index.tsx", "scripts/audio_pipeline/worker.py"];
  assert.equal(shouldBuildService("app", "preview", changed), true);
  assert.equal(shouldBuildService("audio", "preview", changed), true);
});

test("diff covers all changes since previous successful deployment, not only HEAD^", () => {
  const prev = "a".repeat(40);
  const head = "b".repeat(40);
  const calls = [];
  const git = (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === "rev-parse") return head + "\n";
    if (args[0] === "diff") return "src/routes/index.tsx\nscripts/audio_pipeline/worker.py\n";
    throw new Error("unexpected command");
  };
  assert.deepEqual(changedSinceLastSuccess({ VERCEL_GIT_PREVIOUS_SHA: prev }, git), [
    "src/routes/index.tsx",
    "scripts/audio_pipeline/worker.py",
  ]);
  assert.deepEqual(calls[1][1], ["diff", "--no-ext-diff", "--name-only", prev, head, "--"]);
});

test("missing or shallow git history fails open rather than skipping an unbuilt revision", () => {
  assert.equal(
    changedSinceLastSuccess({}, () => {
      throw new Error("should not run");
    }),
    null,
  );
  assert.equal(
    changedSinceLastSuccess({ VERCEL_GIT_PREVIOUS_SHA: "a".repeat(40) }, () => {
      throw new Error("previous commit not present in shallow checkout");
    }),
    null,
  );
  assert.equal(shouldBuildService("audio", "preview", changedSinceLastSuccess({})), true);
});
