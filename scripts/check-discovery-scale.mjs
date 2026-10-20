// Local query-plan and statement-budget test, NOT Cloudflare latency certification.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-discovery-scale-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/recommendations.server.ts",
      "src/features/fore/discovery-rights.server.ts",
      "src/features/fore/d1-cost-profile.server.ts",
    ],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    outdir: root,
    logLevel: "silent",
    outExtension: { ".js": ".mjs" },
  });
  const rec = await import(path.join(root, "recommendations.server.mjs"));
  const rights = await import(path.join(root, "discovery-rights.server.mjs"));
  const { profileD1 } = await import(path.join(root, "d1-cost-profile.server.mjs"));
  const env = localBindings(root);
  const rawDB = env.DB;
  let largestBind = 0;
  const wrap = (statement) =>
    new Proxy(statement, {
      get(target, key) {
        const value = target[key];
        if (key === "bind")
          return (...args) => {
            largestBind = Math.max(largestBind, args.length);
            assert.ok(args.length <= 100, `D1 parameter budget exceeded: ${args.length}`);
            return wrap(value.apply(target, args));
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  env.DB = {
    ...rawDB,
    prepare(query) {
      return wrap(rawDB.prepare(query));
    },
  };
  const fixtureDir = path.join(root, "fixture");
  const gen = spawnSync(
    process.execPath,
    ["scripts/performance/generate-synthetic-d1-fixture.mjs", fixtureDir],
    { env: { ...process.env, COVE_SYNTHETIC_BOOKS: "50000" }, encoding: "utf8" },
  );
  assert.equal(gen.status, 0, gen.stderr);
  const sqlite = new DatabaseSync(path.join(root, ".sites-runtime/fore.sqlite"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(fs.readFileSync(path.join(fixtureDir, file), "utf8"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM catalog_search_documents").get().n, 50000);
  sqlite.exec("BEGIN");
  for (let group = 1; group <= 1000; group++) {
    sqlite
      .prepare(
        "INSERT INTO series(id,name,created_at,updated_at) VALUES(?,?,'2026-10-01','2026-10-01')",
      )
      .run(`perf-series-${group}`, `Synthetic Series ${group}`);
    for (let volume = 1; volume <= 20; volume++)
      sqlite
        .prepare("INSERT INTO series_memberships(series_id,edition_id,position) VALUES(?,?,?)")
        .run(
          `perf-series-${group}`,
          `perf-synth-${String((group - 1) * 20 + volume).padStart(6, "0")}`,
          volume,
        );
  }
  sqlite.exec("COMMIT");

  const objects = new Map();
  env.DISCOVERY_MODELS = {
    async get(k) {
      const s = objects.get(k);
      return s === undefined ? null : { size: Buffer.byteLength(s), text: async () => s };
    },
    async put(k, s) {
      objects.set(k, s);
    },
  };
  const opts = {
    userId: null,
    visitorId: "00000000-0000-4000-8000-000000000001",
    territory: "US",
    limit: 20,
  };
  const baselineCost = profileD1(env.DB);
  const baseline = await rec.homeRecommendations({ ...env, DB: baselineCost.db }, opts);
  await rec.publishAnonymousHomeCandidates(env, "US");
  const cost = profileD1(env.DB);
  const projected = await rec.homeRecommendations(
    { ...env, DB: cost.db, FORE_DISCOVERY_READ_MODE: "required" },
    opts,
  );
  const ids = (v) =>
    v.rails.map((r) => ({
      key: r.key,
      books: r.books.map((b) => b.productId),
      reasons: r.items.map((i) => i.reason),
    }));
  assert.deepEqual(ids(projected), ids(baseline));
  assert.equal(projected.rails[0].books.length, 20);
  const boundedCost = profileD1(env.DB);
  const bounded = await rec.homeRecommendations(
    {
      ...env,
      DB: boundedCost.db,
      FORE_DISCOVERY_READ_MODE: "required",
      FORE_ANONYMOUS_DELIVERY: "snapshot",
    },
    opts,
  );
  assert.deepEqual(
    ids(bounded),
    ids(baseline),
    "Final-display authorization must preserve exact ranking at 50k scale with 20k series memberships",
  );
  const evidenceRows = sqlite
    .prepare("SELECT position FROM recommendation_impressions WHERE request_id=? ORDER BY position")
    .all(projected.rails[0].requestId);
  assert.deepEqual(
    evidenceRows.map((row) => row.position),
    Array.from({ length: 20 }, (_, i) => i + 1),
    "Chunking must retain every impression exactly once in order",
  );
  const sql = [];
  const traceDB = {
    ...env.DB,
    prepare(query) {
      sql.push(query);
      return env.DB.prepare(query);
    },
  };
  const candidates = projected.rails.flatMap((r) => r.books).map((b) => b.productId);
  await rights.authorizeDiscoveryCandidates(traceDB, candidates, "US", true);
  assert.equal(sql.length, 1);
  const plan = sqlite
    .prepare("EXPLAIN QUERY PLAN " + sql[0])
    .all(JSON.stringify([...new Set(candidates)]), "US");
  assert.ok(
    plan.some((p) => /SEARCH p USING INDEX.*\(id=\?\)/.test(p.detail)),
    "Product lookup must be indexed",
  );
  assert.ok(
    !plan.some((p) => /^SCAN (p|e|d|sm|previous)$/.test(p.detail)),
    "No full product/edition/catalog scan for bounded authorization",
  );
  const displayReads = [];
  const displayDB = {
    ...env.DB,
    prepare(query) {
      const statement = env.DB.prepare(query);
      return {
        ...statement,
        bind(...values) {
          displayReads.push({ query, values });
          return statement.bind(...values);
        },
      };
    },
  };
  const display = await rights.authorizeDiscoveryDisplay(displayDB, candidates, "US", true);
  assert.equal(display.size, new Set(candidates).size);
  assert.equal(displayReads.length, 3);
  const hydration = displayReads.find((read) => read.query.includes("contributors_json"));
  const hydrationPlan = sqlite
    .prepare("EXPLAIN QUERY PLAN " + hydration.query)
    .all(...hydration.values);
  assert.ok(
    hydrationPlan.some((row) => /SEARCH p USING INDEX.*\(id=\?\)/.test(row.detail)),
    "Batched canonical hydration must retain indexed product lookup",
  );
  assert.ok(
    !hydrationPlan.some((row) => /^SCAN (p|e|d)$/.test(row.detail)),
    "JSON binding must not introduce a catalog scan",
  );
  console.log(
    JSON.stringify(
      {
        fixtureDocuments: 50000,
        largestBind,
        baselineStatements: baselineCost.samples.length,
        projectedStatements: cost.samples.length,
        boundedStatements: boundedCost.samples.length,
        rails: ids(projected).map((r) => ({ key: r.key, books: r.books.length })),
        rightsQueryPlan: plan.map((p) => p.detail),
      },
      null,
      2,
    ),
  );
  sqlite.exec(`CREATE TRIGGER fail_second_impression_chunk BEFORE INSERT ON recommendation_impressions
    WHEN NEW.position=13 BEGIN SELECT RAISE(ABORT,'injected second chunk failure'); END`);
  const failedVisitor = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(
    rec.homeRecommendations(
      { ...env, FORE_DISCOVERY_READ_MODE: "required" },
      { ...opts, visitorId: failedVisitor },
    ),
    /injected second chunk failure/,
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) n FROM recommendation_requests WHERE visitor_id=?")
      .get(failedVisitor).n,
    0,
    "A later impression-chunk failure must roll back the complete request record",
  );
  sqlite.exec("DROP TRIGGER fail_second_impression_chunk");
  sqlite.close();
  console.log(
    "PASS: actual 50k synthetic schema, 20-item rails, ranking/reason parity and indexed bounded authorization; local execution only",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
