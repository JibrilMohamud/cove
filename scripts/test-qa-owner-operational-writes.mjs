/** Native SQLite schema and actual typed protocol; no hosted or production resources. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = mkdtempSync(join(tmpdir(), "cove-qa-operational-"));
const raw = new DatabaseSync(":memory:");
const journal = new DatabaseSync(":memory:");
const ownerSecret = "a".repeat(64);
try {
  const outfile = join(root, "ops.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./src/storefront-strangler/qa-owner-operational-protocol"; export * from "./src/storefront-strangler/qa-owner-operational-execution";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
  const {
    QA_OPERATIONAL_ROUTE,
    QA_OPERATIONAL_SCHEMA,
    bindQaOperationalOwner,
    dispatchQaOperationalWrite,
    serveQaOperationalWrite,
  } = await import(pathToFileURL(outfile).href);
  for (const name of readdirSync("drizzle")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    raw.exec(readFileSync(join("drizzle", name), "utf8"));
  const db = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      const bind = (...params) => ({
        bind,
        async first() {
          return statement.get(...params) || null;
        },
        async all() {
          return { results: statement.all(...params) };
        },
        async run() {
          return statement.run(...params);
        },
      });
      return bind();
    },
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storage = {
    sql: {
      exec(sql, ...params) {
        if (/^CREATE TABLE/.test(sql)) {
          journal.exec(sql);
          return { toArray: () => [] };
        }
        const statement = journal.prepare(sql);
        if (/^SELECT/.test(sql)) return { toArray: () => statement.all(...params) };
        statement.run(...params);
        return { toArray: () => [] };
      },
    },
    transactionSync(fn) {
      journal.exec("BEGIN");
      try {
        const result = fn();
        journal.exec("COMMIT");
        return result;
      } catch (e) {
        journal.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const primary = "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
  const flags = {
    COVE_QA_OPERATIONAL_OWNER_ENABLED: "1",
    COVE_QA_OWNER_UNBOUND_READ_ENABLED: "1",
    FORE_ENVIRONMENT: "staging",
    COVE_SSR_STAGING: "1",
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
    COVE_LEGAL_WRITER_PRIMARY_ID: primary,
    COVE_PUBLICATION_COMMAND_TERRITORY: "US",
    COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
    COVE_RIGHTS_OWNER_SECRET: ownerSecret,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 600000),
  };
  const env = { ...flags, PRIMARY_DB: db };
  const port = { fetch: (request) => serveQaOperationalWrite(request, env, storage) };
  const readOnlyCaller = Object.freeze({
    prepare() {
      throw Error("borrower_has_no_native_writes");
    },
  });
  const caller = bindQaOperationalOwner(readOnlyCaller, port, flags);
  const dispatch = (action) => dispatchQaOperationalWrite(caller, action);
  const key = "search-counts:v1:" + "b".repeat(64);
  assert.equal(
    await dispatch({
      kind: "cache.write",
      key,
      body: "17",
      expiresAt: Date.now() + 300000,
      prefix: "search-counts:v1:",
      limit: 128,
    }),
    true,
  );
  assert.equal(raw.prepare("SELECT body FROM api_cache WHERE key=?").get(key).body, "17");
  const refresh = "taxonomy-counts-refresh:v1:global",
    lease = crypto.randomUUID();
  const other = crypto.randomUUID();
  assert.equal(
    await dispatch({
      kind: "cache.lease-acquire",
      key: refresh,
      owner: lease,
      expiresAt: Date.now() + 20000,
    }),
    true,
  );
  assert.equal(
    await dispatch({
      kind: "cache.lease-acquire",
      key: refresh,
      owner: other,
      expiresAt: Date.now() + 20000,
    }),
    false,
  );
  await dispatch({ kind: "cache.lease-release", key: refresh, owner: other });
  assert.equal(raw.prepare("SELECT body FROM api_cache WHERE key=?").get(refresh).body, lease);
  const taxkey = "taxonomy-counts:v1:" + "c".repeat(64);
  const projection = JSON.stringify([{ node_id: "fiction", product_count: 2 }]);
  await dispatch({
    kind: "cache.write",
    key: taxkey,
    body: projection,
    expiresAt: Date.now() + 300000,
    prefix: "taxonomy-counts:v1:",
    limit: 128,
    guard: { key: refresh, owner: other, nowMs: Date.now() },
  });
  assert.equal(raw.prepare("SELECT body FROM api_cache WHERE key=?").get(taxkey), undefined);
  await dispatch({
    kind: "cache.write",
    key: taxkey,
    body: projection,
    expiresAt: Date.now() + 300000,
    prefix: "taxonomy-counts:v1:",
    limit: 128,
    guard: { key: refresh, owner: lease, nowMs: Date.now() },
  });
  assert.equal(raw.prepare("SELECT body FROM api_cache WHERE key=?").get(taxkey).body, projection);
  await dispatch({ kind: "cache.lease-release", key: refresh, owner: lease });
  assert.equal(raw.prepare("SELECT body FROM api_cache WHERE key=?").get(refresh), undefined);
  const at = new Date().toISOString(),
    id = crypto.randomUUID();
  const action = {
    kind: "search.impression",
    id,
    query: "Pride",
    normalizedQuery: "pride",
    filtersJson: "{}",
    sort: "relevance",
    count: 1,
    backend: "d1-fts5",
    duration: 1,
    correctedQuery: null,
    impressionsJson: JSON.stringify([{ productId: "fixture-product", position: 1 }]),
    at,
  };
  const command = { schema: QA_OPERATIONAL_SCHEMA, operationId: crypto.randomUUID(), action };
  const send = (body, overrides = {}, envOverride = env) =>
    serveQaOperationalWrite(
      new Request("https://legal-authority.internal" + QA_OPERATIONAL_ROUTE, {
        method: "POST",
        headers: {
          authorization: "Bearer " + ownerSecret,
          "content-type": "application/json",
          ...overrides,
        },
        body: JSON.stringify(body),
      }),
      envOverride,
      storage,
    );
  const first = await send(command),
    replay = await send(command);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(await first.json(), await replay.json());
  assert.equal(raw.prepare("SELECT count(*) n FROM search_query_events WHERE id=?").get(id).n, 1);
  assert.equal((await send({ ...command, action: { ...action, query: "changed" } })).status, 409);
  await dispatch({
    kind: "audit.http",
    requestId: "request-fixture-0001",
    traceId: "b".repeat(32),
    spanId: "c".repeat(16),
    parentSpanId: null,
    startedAt: at,
    endedAt: at,
    duration: 0,
    method: "GET",
    route: "/api/fore/catalog",
    status: 503,
    actorKind: "anonymous",
    storefrontCountry: null,
    errorClass: null,
  });
  for (const table of ["ops_http_requests", "ops_trace_spans", "ops_metric_points"])
    assert.equal(raw.prepare("SELECT count(*) n FROM " + table).get().n, 1);
  const invalid = [
    {
      ...command,
      operationId: crypto.randomUUID(),
      action: { kind: "sql", sql: "DELETE FROM entitlements" },
    },
    { ...command, operationId: crypto.randomUUID(), action: { ...action, userId: "someone-else" } },
    {
      ...command,
      operationId: crypto.randomUUID(),
      action: {
        kind: "cache.write",
        key: "entitlements",
        body: "[]",
        expiresAt: Date.now() + 1000,
        prefix: "search-counts:v1:",
        limit: 128,
      },
    },
  ];
  for (const bad of invalid) assert.equal((await send(bad)).status, 400);
  assert.equal((await send(command, { authorization: "Bearer wrong" })).status, 401);
  for (const bad of [
    { FORE_ENVIRONMENT: "production" },
    { COVE_RIGHTS_OWNER_ENABLED: "0" },
    { STRIPE_LIVEMODE: "true" },
    { COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() - 1) },
    { OTHER_DB: db },
    { COVE_QA_OPERATIONAL_OWNER_ENABLED: "0" },
    { COVE_PUBLICATION_COMMANDS_ENABLED: "1" },
  ])
    assert.equal((await send(command, {}, { ...env, ...bad })).status, 503);
  assert.throws(() => bindQaOperationalOwner({}, port, { ...flags, DB: db }), /not_enrolled/);
  assert.throws(
    () => bindQaOperationalOwner({}, port, { ...flags, FORE_ENVIRONMENT: "production" }),
    /not_enrolled/,
  );
  assert.equal(dispatchQaOperationalWrite({}, action), null);
  console.log(
    "PASS: five closed owner commands, native transactions, lease takeover fencing, exact replay, audit preservation, unknown/production/identity/native-caller denials.",
  );
} finally {
  raw.close();
  journal.close();
  rmSync(root, { recursive: true, force: true });
}
