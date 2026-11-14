import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-synthetic-audit-stage-"));
try {
  await build({
    entryPoints: ["src/features/fore/synthetic-failure-audit-r2.stage.ts"],
    outfile: path.join(directory, "audit.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { syntheticFailureAuditEligible, persistSyntheticFailureAudit } = await import(
    path.join(directory, "audit.mjs")
  );
  const records = [];
  const env = {
    COVE_SYNTHETIC_FAILURE_AUDIT_R2: "1",
    COVE_SYNTHETIC_FAILURE_AUDIT_D1_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    COVE_SYNTHETIC_FAILURE_AUDIT_BUCKET: "cove-synthetic-http-audit-stage-20261114",
    SYNTHETIC_FAILURE_AUDIT_R2: {
      async put(key, value, options) {
        records.push({ key, json: JSON.parse(value), options });
      },
    },
  };
  const request = (p = "/api/fore/catalog", headers = {}, method = "GET") =>
    new Request("https://cove.invalid" + p, { headers, method });
  const response = (status) => new Response(null, { status });
  const safe = request("/api/fore/catalog?private=do-not-persist");
  assert.equal(syntheticFailureAuditEligible(env, safe, response(503), "anonymous"), true);
  assert.equal(
    await persistSyntheticFailureAudit(env, safe, response(503), "anonymous", 153),
    true,
  );
  assert.equal(records.length, 1);
  assert.match(records[0].key, /^synthetic-catalog-failures\/\d{4}-\d\d-\d\d\/[0-9a-f-]+\.json$/);
  assert.deepEqual(records[0].json, {
    schema: "cove.synthetic-anonymous-catalog-failure.v1",
    kind: "synthetic-stage-only",
    route: "/api/fore/catalog",
    method: "GET",
    status: 503,
    durationMs: 153,
    at: records[0].json.at,
  });
  assert.equal(records[0].options.httpMetadata.contentType, "application/json");
  assert.equal(JSON.stringify(records).includes("do-not-persist"), false);
  const refused = [
    [env, request(), response(200), "anonymous"],
    [env, request(), response(401), "anonymous"],
    [env, request(), response(403), "anonymous"],
    [env, request(), response(429), "anonymous"],
    [env, request(), response(503), "user"],
    [env, request("/api/fore/books/sensitive"), response(503), "anonymous"],
    [env, request("/api/fore/cart"), response(503), "anonymous"],
    [env, request("/api/fore/catalog", { cookie: "private=1" }), response(503), "anonymous"],
    [env, request("/api/fore/catalog", { authorization: "Bearer x" }), response(503), "anonymous"],
    [
      env,
      request("/api/fore/catalog", { "x-fore-authenticated-user-id": "user" }),
      response(503),
      "anonymous",
    ],
    [{ ...env, COVE_SYNTHETIC_FAILURE_AUDIT_R2: "0" }, request(), response(503), "anonymous"],
    [
      {
        ...env,
        COVE_SYNTHETIC_FAILURE_AUDIT_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
      },
      request(),
      response(503),
      "anonymous",
    ],
    [{ ...env, SYNTHETIC_FAILURE_AUDIT_R2: undefined }, request(), response(503), "anonymous"],
  ];
  for (const [settings, req, resp, actor] of refused) {
    assert.equal(syntheticFailureAuditEligible(settings, req, resp, actor), false);
    assert.equal(await persistSyntheticFailureAudit(settings, req, resp, actor, 1), false);
  }
  assert.equal(records.length, 1, "Only the eligible synthetic 503 can write R2");
  const originalWarn = console.warn;
  try {
    console.warn = () => {};
    const broken = {
      ...env,
      SYNTHETIC_FAILURE_AUDIT_R2: {
        async put() {
          throw Error("unavailable");
        },
      },
    };
    assert.equal(
      await persistSyntheticFailureAudit(broken, safe, response(503), "anonymous", 1),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
  const handler = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
  assert.match(handler, /persistSyntheticFailureAudit\(/);
  assert.match(handler, /else if \(syntheticFailureAuditPersisted\)/);
  assert.match(handler, /else if \(env\.DB\)/);
  assert.match(handler, /recordHttpRequest\(env\.DB/);
  console.log(
    "PASS: isolated synthetic 503 R2 evidence, production/identity exclusions, and durable-failure D1 fallback",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
