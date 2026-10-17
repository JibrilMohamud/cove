import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-native-worker-d1-"));
try {
  await build({
    entryPoints: ["src/lib/cloudflare-native-bindings.server.ts"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    outfile: path.join(root, "bindings.mjs"),
    logLevel: "silent",
  });
  const { resolveNativeWorkerBindings } = await import(path.join(root, "bindings.mjs"));
  const d1 = { prepare: () => ({}) };
  const worker = { DB: d1, BUCKET: { name: "r2" }, COVE_SSR_STAGING_GATE_KEY: "native-only" };
  const plain = new Request("https://cove.example/", {
    headers: { "cf-ipcountry": "US", "x-cove-client-country": "US" },
  });
  let calls = 0;
  const getter = async () => {
    calls += 1;
    return worker;
  };
  const unsupported = await resolveNativeWorkerBindings(plain, { FORE_ENVIRONMENT: "production" }, getter);
  assert.equal(unsupported.DB, undefined);
  assert.equal(calls, 0, "Untrusted headers never authorize binding access");

  const trusted = new Request("https://cove.example/");
  Object.defineProperty(trusted, "cf", { value: { country: "CA" } });
  const resolved = await resolveNativeWorkerBindings(
    trusted,
    { FORE_ENVIRONMENT: "production", DB: undefined, COVE_SSR_STAGING_GATE_KEY: "old" },
    getter,
  );
  assert.equal(resolved.DB, d1);
  assert.equal(resolved.BUCKET, worker.BUCKET);
  assert.equal(resolved.COVE_SSR_STAGING_GATE_KEY, "native-only");
  assert.equal(calls, 1);
  assert.equal(
    (await resolveNativeWorkerBindings(trusted, { DB: d1 }, getter)).DB,
    d1,
  );
  assert.equal(calls, 1, "Already bound Workers must not reload environment");

  const stage = await resolveNativeWorkerBindings(
    plain,
    { COVE_SSR_STAGING: "1" },
    getter,
  );
  assert.equal(stage.DB, d1);
  assert.equal(calls, 2, "Staging may recover its own Worker bindings");

  const failClosed = await resolveNativeWorkerBindings(
    trusted,
    { FORE_ENVIRONMENT: "production" },
    async () => {
      throw new Error("Cloudflare binding unavailable");
    },
  );
  assert.equal(failClosed.DB, undefined, "Never synthesize a rights database");
  console.log("Cloudflare-native D1 binding handoff and legal country isolation: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
