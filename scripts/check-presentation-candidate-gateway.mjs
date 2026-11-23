import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";
const config = JSON.parse(
  fs
    .readFileSync("wrangler.presentation-gateway.stage.jsonc", "utf8")
    .replace(/,\s*([}\]])/g, "$1"),
);
assert.equal(config.name, "cove-presentation-r2-proof-20261114");
assert.deepEqual(config.services, [
  { binding: "CANDIDATE", service: "cove-presentation-r2-candidate-stage" },
]);
assert.equal(config.vars.COVE_SSR_STAGING, "1");
assert.equal(config.preview_urls, false);
assert.equal(config.workers_dev, false);
for (const capability of [
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "routes",
  "triggers",
  "kv_namespaces",
])
  assert.equal(config[capability], undefined, "The disposable gateway cannot hold " + capability);
const bundle = await build({
  entryPoints: ["scripts/staging/presentation-candidate-gateway.worker.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const { default: worker } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const gate = "a".repeat(64),
  backend = "b".repeat(64);
let calls = 0;
const env = {
  COVE_SSR_STAGING: "1",
  COVE_SSR_STAGING_GATE_KEY: gate,
  FORE_BACKEND_TOKEN: backend,
  CANDIDATE: {
    async fetch(request) {
      calls++;
      assert.equal(request.headers.get("x-cove-backend-token"), backend);
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("oai-authenticated-user-id"), null);
      assert.equal(request.headers.get("x-cove-public-url"), null);
      assert.equal(request.headers.get("x-cove-client-country"), "US");
      assert.equal(request.headers.get("x-cove-client-ip"), "192.0.2.1");
      return new Response("{}", { headers: { "cache-control": "public, max-age=100" } });
    },
  },
};
function request(path = "/api/fore/catalog", options = {}) {
  const r = new Request("https://candidate.invalid" + path, {
    ...options,
    headers: { "cf-connecting-ip": "192.0.2.1", ...options.headers },
  });
  Object.defineProperty(r, "cf", { value: { country: "US" } });
  return r;
}
const authenticated = { authorization: "Bearer " + gate };
assert.equal((await worker.fetch(request(), env)).status, 401);
assert.equal(
  (
    await worker.fetch(
      request("/api/fore/catalog", { headers: { authorization: "Bearer " + "c".repeat(64) } }),
      env,
    )
  ).status,
  401,
);
assert.equal((await worker.fetch(request(), { ...env, COVE_SSR_STAGING: "0" })).status, 503);
assert.equal((await worker.fetch(request("/admin", { headers: authenticated }), env)).status, 404);
assert.equal(
  (
    await worker.fetch(
      request("/api/fore/catalog", { method: "POST", headers: authenticated }),
      env,
    )
  ).status,
  405,
);
assert.equal(
  (
    await worker.fetch(
      request("/api/fore/catalog", { headers: { ...authenticated, cookie: "session=fake" } }),
      env,
    )
  ).status,
  403,
);
assert.equal(calls, 0, "Denied requests must never reach the isolated backend");
const response = await worker.fetch(
  request("/api/fore/catalog", {
    headers: {
      ...authenticated,
      "x-cove-client-country": "CA",
      "x-cove-client-ip": "forged",
      "x-cove-backend-token": "forged",
      "oai-authenticated-user-id": "forged",
      "x-cove-public-url": "https://forged.invalid",
    },
  }),
  env,
);
assert.equal(calls, 1);
assert.equal(response.headers.get("cache-control"), "no-store");
console.log(
  "PASS: isolated gateway denies missing/forged keys, disabled gate, cookies, writes and unknown routes; strips identity and uses provider geography",
);
