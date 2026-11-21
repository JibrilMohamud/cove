import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

// Exercise the ACTUAL Vercel proxy with a 503 upstream that sends headers but
// never completes the body. No live URL, network, D1 or credentials are used.
const bundle = await build({
  entryPoints: ["src/lib/persistence-backend.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  write: false,
});
assert.equal(bundle.outputFiles.length, 1);
const dataUrl =
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const { proxyPersistenceApi } = await import(dataUrl);

const priorFetch = globalThis.fetch;
const priorWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args);
let upstreamCancelled = false;
try {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start() {
          // Deliberately never enqueue bytes or close. Headers exist.
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
      {
        status: 503,
        headers: {
          "x-cove-persistence": "d1-r2",
          "x-cove-backend-cache": "MISS",
          "server-timing": "cove_auth;dur=12, cove_api;dur=24",
          "cf-ray": "8ae2b9362ddfafe0-IAD",
          "content-type": "application/json",
        },
      },
    );

  const request = new Request("https://covereads.com/api/fore/storefront/bootstrap", {
    method: "GET",
    headers: { "x-vercel-ip-country": "US" },
  });
  const env = {
    FORE_ENVIRONMENT: "production",
    FORE_BACKEND_URL: "https://mock-gateway.invalid",
    FORE_BACKEND_TOKEN: "synthetic-unit-test-only",
  };
  const started = performance.now();
  let timer;
  let result;
  try {
    result = await Promise.race([
      proxyPersistenceApi(request, env),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Gateway blocked beyond 800ms on upstream 503 body")),
          800,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const elapsed = performance.now() - started;
  assert.ok(result instanceof Response);
  assert.equal(result.status, 503, "Rights-preserving production failure must stay 503");
  assert.match(result.headers.get("cache-control") || "", /no-store/);
  assert.ok(elapsed < 550, "A known upstream 503 must not inherit a stalled stream deadline");
  assert.deepEqual(await result.json(), {
    error: "The live Cove catalog is temporarily unavailable. Please retry.",
  });
  assert.ok(upstreamCancelled, "Upstream body must be discarded without awaiting its cleanup");
  assert.equal(warnings.length, 1, "Exactly one fixed production warning is expected");
  assert.equal(warnings[0].length, 1, "No raw upstream header object may be logged");
  assert.ok(
    warnings[0][0].endsWith(" ray=8ae2b9362ddfafe0-IAD"),
    "Validated Ray should correlate this bounded upstream 503",
  );
  assert.doesNotMatch(JSON.stringify(warnings), /Authorization|Cookie:|private-token|https:/);
  console.log(
    "PASS: live-shaped production gateway preserves 503/no-store with stalled upstream body",
  );
} finally {
  globalThis.fetch = priorFetch;
  console.warn = priorWarn;
}
