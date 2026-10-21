import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-isolated-http-metric-"));
try {
  await build({
    entryPoints: ["src/features/fore/anonymous-http-metric.server.ts"],
    outfile: path.join(directory, "metric.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { emitIsolatedAnonymousHttpMetric: route } = await import(
    path.join(directory, "metric.mjs")
  );
  const written = [];
  const env = {
    COVE_SSR_STAGING: "1",
    COVE_OPS_TELEMETRY_MODE: "analytics-engine",
    OPS_ANALYTICS: {
      writeDataPoint(value) {
        written.push(value);
      },
    },
  };
  const request = (path, headers = {}, method = "GET") =>
    new Request("https://cove.test" + path, { headers, method });
  const status = (value) => new Response(null, { status: value });
  assert.equal(
    route(env, request("/api/fore/catalog?search=private-query"), status(200), "anonymous", 14),
    true,
  );
  assert.deepEqual(written[0], {
    blobs: ["public-api-read", "/api/fore/catalog", "GET"],
    doubles: [200, 14],
    indexes: ["public-read"],
  });
  assert.equal(JSON.stringify(written).includes("private-query"), false);
  const refused = [
    [env, request("/api/fore/checkout"), status(200), "anonymous"],
    [env, request("/api/fore/books/secret"), status(200), "anonymous"],
    [env, request("/api/fore/catalog", { cookie: "session=private" }), status(200), "anonymous"],
    [env, request("/api/fore/catalog", { authorization: "Bearer private" }), status(200), "anonymous"],
    [env, request("/api/fore/catalog"), status(401), "anonymous"],
    [env, request("/api/fore/catalog"), status(500), "anonymous"],
    [env, request("/api/fore/catalog"), status(200), "user"],
    [{ ...env, COVE_SSR_STAGING: "0" }, request("/api/fore/catalog"), status(200), "anonymous"],
    [{ ...env, COVE_OPS_TELEMETRY_MODE: "off" }, request("/api/fore/catalog"), status(200), "anonymous"],
    [{ ...env, OPS_ANALYTICS: undefined }, request("/api/fore/catalog"), status(200), "anonymous"],
  ];
  for (const item of refused) {
    assert.equal(route(...item, 1), false);
  }
  assert.equal(written.length, 1, "Rejected telemetry cannot be written");
  const broken = {
    ...env,
    OPS_ANALYTICS: {
      writeDataPoint() {
        throw Error("independent metric sink unavailable");
      },
    },
  };
  const originalWarn = console.warn;
  try {
    console.warn = () => {};
    assert.equal(
      route(broken, request("/api/fore/taxonomy"), status(200), "anonymous", 4),
      true,
    );
  } finally {
    console.warn = originalWarn;
  }
  console.log("PASS: isolated anonymous API metrics; PII exclusions, errors and authenticated requests preserved on existing D1 path.");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
