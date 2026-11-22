import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./paid-qa-fixture.worker.mjs";
import {
  QA_ACCOUNT,
  QA_DATABASE,
  QA_BUCKET,
  QA_SCHEMA_SOURCE,
  QA_SCHEMA_SQL,
  QA_WORKERS,
  QA_PARKED_VERSIONS,
  paidQaCredentials,
  paidQaRole,
  paidQaDeployEnvironment,
  assertPaidQaConfig,
  createPaidQaControlPlane,
} from "./paid-qa-isolation.mjs";
import { restorePaidQa } from "./park-paid-qa.mjs";
const env = {
  CLOUDFLARE_ACCOUNT_ID: QA_ACCOUNT,
  COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: "w".repeat(40),
  COVE_CF_STAGE_D1_READ_TOKEN: "r".repeat(40),
  COVE_CF_WORKERS_METADATA_READ_TOKEN: "m".repeat(40),
  COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN: "i".repeat(40),
};
test("no broad fallback, distinct roles, and deploy subprocess secret isolation", () => {
  assert.throws(() =>
    paidQaCredentials({ CLOUDFLARE_ACCOUNT_ID: QA_ACCOUNT, CLOUDFLARE_API_TOKEN: "b".repeat(40) }),
  );
  assert.throws(() =>
    paidQaCredentials({
      ...env,
      COVE_CF_STAGE_D1_READ_TOKEN: env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN,
    }),
  );
  const clean = paidQaDeployEnvironment({
    ...env,
    PATH: "/usr/bin",
    CLOUDFLARE_API_TOKEN: "b".repeat(40),
    STRIPE_SECRET_KEY: "secret",
    GH_TOKEN: "secret",
  });
  assert.equal(clean.CLOUDFLARE_API_TOKEN, env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN);
  assert.equal(clean.PATH, "/usr/bin");
  assert.deepEqual(
    Object.keys(clean).filter((k) => /TOKEN|SECRET/.test(k)),
    ["CLOUDFLARE_API_TOKEN"],
  );
});
test("control plane permits schema-only read and fixed QA operations; no D1 writes or production deployment", () => {
  assert.equal(
    paidQaRole("POST", `/d1/database/${QA_SCHEMA_SOURCE}/query`, { sql: QA_SCHEMA_SQL }),
    "schema",
  );
  assert.equal(paidQaRole("PUT", `/workers/scripts/${QA_WORKERS.fixture}`), "deploy");
  assert.equal(paidQaRole("GET", `/workers/scripts/${QA_WORKERS.owner}/settings`), "metadata");
  for (const [method, resource, body] of [
    ["POST", `/d1/database/${QA_DATABASE}/query`, { sql: "SELECT 1" }],
    ["POST", `/d1/database/${QA_SCHEMA_SOURCE}/query`, { sql: "DELETE FROM products" }],
    ["POST", `/d1/database/${QA_SCHEMA_SOURCE}/query`, { sql: QA_SCHEMA_SQL, params: [] }],
    ["PUT", "/workers/scripts/cove-legal-authority-production"],
    ["DELETE", `/workers/scripts/${QA_WORKERS.owner}`],
    ["GET", "/tokens"],
    ["POST", "/r2/buckets"],
    ["GET", `/workers/scripts/${QA_WORKERS.owner}/settings?extra=1`],
  ])
    assert.throws(() => paidQaRole(method, resource, body));
});
test("transport selects the reader and rejects redirects and API errors", async () => {
  let calls = 0;
  const transport = createPaidQaControlPlane(env, async (url, options) => {
    calls++;
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${QA_ACCOUNT}/d1/database/${QA_SCHEMA_SOURCE}/query`,
    );
    assert.equal(options.headers.authorization, "Bearer " + env.COVE_CF_STAGE_D1_READ_TOKEN);
    assert.equal(options.redirect, "error");
    return Response.json(
      { success: false, errors: [{ message: "private provider detail" }] },
      { status: 403 },
    );
  });
  await assert.rejects(
    transport.api("POST", `/d1/database/${QA_SCHEMA_SOURCE}/query`, { sql: QA_SCHEMA_SQL }),
    /^Error: paid_qa_control_plane_failed_403$/,
  );
  assert.throws(() => transport.api("PUT", "/workers/scripts/cove"));
  assert.equal(calls, 1);
});
test("QA config cannot bind production databases, buckets or services", () => {
  const c = {
    name: QA_WORKERS.caller,
    routes: [],
    preview_urls: false,
    d1_databases: [{ database_id: QA_DATABASE }],
    r2_buckets: [{ bucket_name: QA_BUCKET }],
    services: [{ service: QA_WORKERS.owner }],
  };
  assertPaidQaConfig(c);
  for (const patch of [
    { name: "cove" },
    { routes: ["covereads.com/*"] },
    { preview_urls: true },
    { d1_databases: [{ database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" }] },
    { r2_buckets: [{ bucket_name: "cove-production-media" }] },
    { services: [{ service: "cove-persistence-backend" }] },
  ])
    assert.throws(() => assertPaidQaConfig({ ...c, ...patch }));
});
function nativeFixture() {
  const db = new DatabaseSync(":memory:");
  const objects = new Map();
  const key = "a".repeat(64);
  let queries = 0;
  const scope = {
    QA_DATABASE_ID: QA_DATABASE,
    QA_BUCKET_NAME: QA_BUCKET,
    QA_GATE: key,
    QA_EXPIRES_AT: String(Date.now() + 60_000),
    QA_DB: {
      prepare(sql) {
        queries++;
        const stmt = db.prepare(sql);
        return {
          bind(...params) {
            return {
              async all() {
                return { success: true, results: stmt.all(...params) };
              },
            };
          },
        };
      },
    },
    QA_MEDIA: {
      async put(k, v) {
        objects.set(k, v);
      },
      async delete(k) {
        objects.delete(k);
      },
    },
  };
  const call = (route, body, patch = {}, token = key) =>
    worker.fetch(
      new Request("https://qa.example" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { ...scope, ...patch },
    );
  return {
    db,
    objects,
    call,
    get queries() {
      return queries;
    },
  };
}
test("native helper executes full QA schema SQL and fixed private media without API tokens", async () => {
  const f = nativeFixture();
  try {
    for (const sql of [
      "CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)",
      "INSERT INTO example VALUES(1, 'synthetic')",
    ]) {
      const response = await f.call("/query", { sql, params: [] });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
    }
    assert.deepEqual(
      (await (await f.call("/query", { sql: "SELECT * FROM example", params: [] })).json()).results,
      [{ id: 1, value: "synthetic" }],
    );
    assert.equal(
      (await f.call("/media/put", { key: "qa/book.epub", base64: btoa("original QA") })).status,
      200,
    );
    assert.equal(new TextDecoder().decode(f.objects.get("qa/book.epub")), "original QA");
    assert.equal((await f.call("/media/delete", { key: "qa/book.epub" })).status, 200);
    assert.equal(f.objects.size, 0);
  } finally {
    f.db.close();
  }
});
test("bad credentials, expired leases, alternate resources and malformed queries fail before SQL", async () => {
  const f = nativeFixture();
  try {
    for (const patch of [
      { QA_DATABASE_ID: "production" },
      { QA_BUCKET_NAME: "production" },
      { QA_EXPIRES_AT: "0" },
      { QA_EXPIRES_AT: String(Date.now() + 31 * 60_000) },
      { QA_GATE: "weak" },
    ])
      assert.equal((await f.call("/query", { sql: "SELECT 1", params: [] }, patch)).status, 503);
    assert.equal(
      (await f.call("/query", { sql: "SELECT 1", params: [] }, {}, "wrong")).status,
      401,
    );
    for (const body of [
      { sql: "SELECT 1", params: [], database: "production" },
      { sql: "SELECT 1", params: [{}] },
      { sql: "", params: [] },
    ])
      assert.equal((await f.call("/query", body)).status, 400);
    assert.equal(
      (await f.call("/media/put", { key: "customer/book.epub", base64: btoa("bad") })).status,
      400,
    );
    assert.equal(f.queries, 0);
    assert.equal(f.objects.size, 0);
  } finally {
    f.db.close();
  }
});
test("parking attempts every worker even after failure, and rejects stale/cross-resource receipts", async () => {
  const parked = QA_PARKED_VERSIONS;
  const runtime = {
    GITHUB_RUN_ID: "45034087743",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
  };
  const snapshot = { runId: "45034087743-1", sha: runtime.GITHUB_SHA, parked };
  const writes = [];
  let failOwner = true;
  const api = async (method, path) => {
    if (method === "POST") {
      writes.push(path);
      if (failOwner && path.includes(QA_WORKERS.owner)) throw Error("unavailable");
      return {};
    }
    if (path.endsWith("/deployments"))
      return {
        deployments: [{ versions: [{ version_id: parked[path.split("/")[3]], percentage: 100 }] }],
      };
    return { enabled: false, previews_enabled: false };
  };
  await assert.rejects(restorePaidQa(snapshot, api, runtime));
  assert.equal(writes.length, 10);
  failOwner = false;
  assert.equal((await restorePaidQa(snapshot, api, runtime)).parked, true);
  for (const patch of [
    { sha: "b".repeat(40) },
    { runId: "45034087743-2" },
    { parked: { ...parked, "cove-persistence-backend": QA_PARKED_VERSIONS[QA_WORKERS.owner] } },
  ]) {
    writes.length = 0;
    await assert.rejects(restorePaidQa({ ...snapshot, ...patch }, api, runtime));
    assert.equal(writes.length, 0);
  }
});
test("workflow never exposes broad credentials and restores parked versions independently", () => {
  const workflow = readFileSync(".github/workflows/paid-legal-full-schema-private-qa.yml", "utf8");
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /environment: cove-production-release-audit/);
  assert.match(workflow, /run: node scripts\/staging\/park-paid-qa.mjs/);
  const runner = readFileSync("scripts/staging/prove-private-paid-owner.mjs", "utf8");
  assert.doesNotMatch(
    runner,
    /process\.env\.CLOUDFLARE_API_TOKEN|cli\(\["r2"|api\("POST","\/d1\/database\/"\+primary/,
  );
  assert.match(runner, /await control.preflight\(\)/);
});
