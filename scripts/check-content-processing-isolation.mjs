import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-content-processing-"));
try {
  await build({
    entryPoints: ["src/content-processing.worker.ts"],
    outfile: path.join(root, "content.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { runContentProcessingTick, default: worker } = await import(
    path.join(root, "content.mjs")
  );
  const calls = [];
  const runners = {
    assets: async () => {
      calls.push("assets");
      return { stored: 2 };
    },
    literary: async () => {
      calls.push("literary");
      return { analyzed: 2 };
    },
  };
  let canRead = true;
  const env = {
    FORE_CONTENT_PROCESSOR_ENABLED: "0",
    FORE_CONTENT_PROCESSOR_ROLE: "assets",
    FORE_CONTENT_D1_ADMISSION_MAX_MS: "300",
    BUCKET: {},
    AI: {},
    DB: {
      prepare(sql) {
        assert.equal(sql, "SELECT 1 AS ok", "Admission must not write to D1");
        return {
          async first() {
            if (!canRead) throw Error("D1 unavailable");
            return { ok: 1 };
          },
        };
      },
    },
  };

  assert.deepEqual(await runContentProcessingTick(env, runners), { skipped: "disabled" });
  env.FORE_CONTENT_PROCESSOR_ENABLED = "1";
  env.FORE_CONTENT_PROCESSOR_ROLE = "invalid";
  assert.deepEqual(await runContentProcessingTick(env, runners), { skipped: "invalid_role" });
  env.FORE_CONTENT_PROCESSOR_ROLE = "assets";
  const missing = { ...env, BUCKET: undefined };
  assert.equal((await runContentProcessingTick(missing, runners)).skipped, "missing_private_r2");
  assert.equal((await runContentProcessingTick(env, runners)).role, "assets");
  assert.deepEqual(calls, ["assets"], "Role must not execute any other job class");
  env.FORE_CONTENT_PROCESSOR_ROLE = "literary";
  assert.equal(
    (await runContentProcessingTick({ ...env, AI: undefined }, runners)).skipped,
    "missing_ai",
  );
  assert.equal((await runContentProcessingTick(env, runners)).role, "literary");
  assert.deepEqual(calls, ["assets", "literary"]);
  canRead = false;
  assert.equal((await runContentProcessingTick(env, runners)).skipped, "primary_unavailable");
  assert.deepEqual(calls, ["assets", "literary"], "Unavailable D1 defers work safely");
  assert.equal((await worker.fetch()).status, 404, "No remote mutation endpoint is exposed");

  const backend = fs.readFileSync("src/persistence-backend.worker.ts", "utf8");
  assert.match(backend, /FORE_CONTENT_PIPELINE_EXTERNAL === "1"/);
  assert.match(backend, /\(\) => runStoredAssetTick\(env\)/);
  assert.match(backend, /\(\) => runLiteraryProfileTick\(env\)/);
  assert.ok(
    backend.indexOf("const external =") < backend.indexOf("for (const run of work)"),
    "Old and new content cron execution must be gated by one operator-controlled switch",
  );
  console.log("Content Worker role, fail-closed admission, and handoff gates passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
