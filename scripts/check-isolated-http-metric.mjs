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
  const prod = {
    ...env,
    COVE_SSR_STAGING: "0",
    FORE_ENVIRONMENT: "production",
    COVE_PUBLIC_ANON_HTTP_TELEMETRY: "1",
  };
  assert.equal(
    route(prod, request("/api/fore/catalog?q=private-value"), status(200), "anonymous", 8),
    true,
  );
  assert.deepEqual(written[1], {
    blobs: ["public-api-read", "/api/fore/catalog", "GET"],
    doubles: [200, 8],
    indexes: ["public-read"],
  });
  assert.equal(JSON.stringify(written).includes("private-value"), false);
  const refused = [
    [env, request("/api/fore/checkout"), status(200), "anonymous"],
    [env, request("/api/fore/books/secret"), status(200), "anonymous"],
    [env, request("/api/fore/catalog", { cookie: "session=private" }), status(200), "anonymous"],
    [
      env,
      request("/api/fore/catalog", { authorization: "Bearer private" }),
      status(200),
      "anonymous",
    ],
    [env, request("/api/fore/catalog"), status(401), "anonymous"],
    [env, request("/api/fore/catalog"), status(500), "anonymous"],
    [env, request("/api/fore/catalog"), status(200), "user"],
    [prod, request("/api/fore/catalog"), status(500), "anonymous"],
    [prod, request("/api/fore/catalog"), status(403), "anonymous"],
    [prod, request("/api/fore/catalog"), status(200), "user"],
    [prod, request("/api/fore/catalog", { cookie: "session=private" }), status(200), "anonymous"],
    [prod, request("/api/fore/catalog", { authorization: "Bearer x" }), status(200), "anonymous"],
    [
      { ...prod, COVE_PUBLIC_ANON_HTTP_TELEMETRY: "0" },
      request("/api/fore/catalog"),
      status(200),
      "anonymous",
    ],
    [
      { ...prod, FORE_ENVIRONMENT: "staging" },
      request("/api/fore/catalog"),
      status(200),
      "anonymous",
    ],
    [{ ...env, COVE_SSR_STAGING: "0" }, request("/api/fore/catalog"), status(200), "anonymous"],
    [
      { ...env, COVE_OPS_TELEMETRY_MODE: "off" },
      request("/api/fore/catalog"),
      status(200),
      "anonymous",
    ],
    [{ ...env, OPS_ANALYTICS: undefined }, request("/api/fore/catalog"), status(200), "anonymous"],
  ];
  for (const item of refused) {
    assert.equal(route(...item, 1), false);
  }
  assert.equal(
    written.length,
    4,
    "Only 2xx aggregates and two anonymous public 5xx counters are emitted",
  );
  assert.deepEqual(written.slice(2), [
    {
      blobs: ["public-api-failure", "/api/fore/catalog", "5xx"],
      doubles: [500, 1],
      indexes: ["public-failure"],
    },
    {
      blobs: ["public-api-failure", "/api/fore/catalog", "5xx"],
      doubles: [500, 1],
      indexes: ["public-failure"],
    },
  ]);
  assert.equal(
    JSON.stringify(written).includes("private"),
    false,
    "No search text, query string, identity, or error body may reach independent AE",
  );
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
    assert.equal(route(broken, request("/api/fore/taxonomy"), status(200), "anonymous", 4), true);
  } finally {
    console.warn = originalWarn;
  }
  // Fixed phase attribution is an ADDITIONAL non-authoritative data point,
  // never an excuse to skip the pre-existing D1 failure/security journal.
  const before = written.length;
  assert.equal(
    route(
      prod,
      request("/api/fore/storefront/bootstrap?secret=do-not-log"),
      status(200),
      "anonymous",
      1200,
      { auth: 50, context: 1050, unexpected_user_field: "do-not-log" },
    ),
    true,
  );
  assert.deepEqual(written.slice(before), [
    {
      blobs: ["public-api-read", "/api/fore/storefront/bootstrap", "GET"],
      doubles: [200, 1200],
      indexes: ["public-read"],
    },
    {
      blobs: ["public-api-anomaly-phase", "/api/fore/storefront/bootstrap", "context"],
      doubles: [200, 1200, 1050],
      indexes: ["public-anomaly"],
    },
  ]);
  assert.equal(
    route(
      prod,
      request("/api/fore/storefront/bootstrap?secret=do-not-log"),
      status(503),
      "anonymous",
      3100,
      { auth: 90, context: 2900 },
    ),
    false,
  );
  assert.deepEqual(written.slice(-2), [
    {
      blobs: ["public-api-failure", "/api/fore/storefront/bootstrap", "5xx"],
      doubles: [503, 3100],
      indexes: ["public-failure"],
    },
    {
      blobs: ["public-api-anomaly-phase", "/api/fore/storefront/bootstrap", "context"],
      doubles: [503, 3100, 2900],
      indexes: ["public-anomaly"],
    },
  ]);
  // Only the named, numeric stages are admitted. An unknown slow phase must
  // not be misattributed to rights, SQL or transport based on absent evidence.
  assert.equal(
    route(prod, request("/api/fore/catalog"), status(200), "anonymous", 900, {
      auth: 12,
      identity: 10,
      context: 120,
      attackerControlled: 9000,
    }),
    true,
  );
  assert.deepEqual(written.at(-1), {
    blobs: ["public-api-anomaly-phase", "/api/fore/catalog", "unattributed"],
    doubles: [200, 900, 120],
    indexes: ["public-anomaly"],
  });
  const beforePrivate = written.length;
  assert.equal(
    route(
      prod,
      request("/api/fore/storefront/bootstrap", { cookie: "session=private" }),
      status(503),
      "anonymous",
      9000,
      { context: 8000 },
    ),
    false,
  );
  assert.equal(written.length, beforePrivate, "private traffic never emits phase metrics");
  assert.equal(JSON.stringify(written).includes("do-not-log"), false);
  assert.equal(JSON.stringify(written).includes("attackerControlled"), false);
  assert.equal(
    route(prod, request("/api/fore/catalog"), status(200), "anonymous", 800),
    true,
    "previous callers without stage timings still retain original semantics",
  );
  assert.deepEqual(written.at(-1), {
    blobs: ["public-api-read", "/api/fore/catalog", "GET"],
    doubles: [200, 800],
    indexes: ["public-read"],
  });
  console.log(
    "PASS: anonymous 5xx category counters in AE, no PII; durable D1 error/security audit remains enabled.",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
