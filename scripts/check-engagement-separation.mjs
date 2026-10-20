import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-engagement-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  const ledgerRoot = path.join(root, "ledger");
  fs.mkdirSync(path.join(ledgerRoot, "drizzle"), { recursive: true });
  fs.copyFileSync(
    "engagement-migrations/0001_engagement.sql",
    path.join(ledgerRoot, "drizzle/0001.sql"),
  );
  await build({
    entryPoints: [
      "api.server",
      "recommendations.server",
      "recommendation-engagement.server",
      "discovery-intelligence.server",
      "account-management.server",
      "d1-cost-profile.server",
      "operations.server",
      "search.server",
    ].map((n) => `src/features/fore/${n}.ts`),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(root, "api.server.mjs"));
  const rec = await import(path.join(root, "recommendations.server.mjs"));
  const engagement = await import(path.join(root, "recommendation-engagement.server.mjs"));
  const intelligence = await import(path.join(root, "discovery-intelligence.server.mjs"));
  const accounts = await import(path.join(root, "account-management.server.mjs"));
  const ops = await import(path.join(root, "operations.server.mjs"));
  const search = await import(path.join(root, "search.server.mjs"));
  const { profileD1 } = await import(path.join(root, "d1-cost-profile.server.mjs"));
  const raw = localBindings(root),
    ledger = localBindings(ledgerRoot).DB;
  assert.equal(
    (
      await ledger
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('products','rights_grants','recommendation_privacy')",
        )
        .all()
    ).results.length,
    0,
    "Independent schema must not import catalog/rights/consent",
  );
  assert.throws(
    () =>
      engagement
        .engagementDatabase(
          engagement.scopeEngagementEnv({ ...raw, FORE_ENGAGEMENT_STORAGE: "separate" }).DB,
        )
        .prepare("SELECT 1"),
    /unavailable/,
  );
  assert.throws(() => engagement.attachEngagementDatabase(raw.DB, raw.DB), /independent/);
  for (const table of [
    "recommendation_requests",
    "recommendation_impressions",
    "recommendation_events",
    "recommendation_jobs",
  ]) {
    const cols = async (db) =>
      (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name).sort();
    assert.deepEqual(
      await cols(ledger),
      await cols(raw.DB),
      `${table} columns must match application contract`,
    );
  }
  const seed = await api.handleCoveApi(
    new Request("https://test/api/fore/storefront/bootstrap"),
    raw,
  );
  assert.equal(seed.status, 200, await seed.text());
  const readCounters = [];
  const edgeReads = {
    ...raw,
    FORE_DISCOVERY_READ_RATE_LIMIT_MODE: "edge",
    COVE_STOREFRONT_READ_LIMITER: {
      async limit({ key }) {
        readCounters.push({ cap: 180, key });
        return { success: true };
      },
    },
    COVE_DISCOVERY_READ_LIMITER_240: {
      async limit({ key }) {
        readCounters.push({ cap: 240, key });
        return { success: true };
      },
    },
  };
  const readRequest = new Request("https://test/api/fore/recommendations/home", {
    headers: { "cf-connecting-ip": "192.0.2.88" },
  });
  const countersBefore = (await raw.DB.prepare("SELECT COUNT(*) n FROM rate_limits").first()).n;
  await api.rateLimitSearchRequest(readRequest, edgeReads, null, "recommend-home", 180);
  await api.rateLimitSearchRequest(readRequest, edgeReads, null, "suggest", 240);
  assert.deepEqual(
    readCounters.map((entry) => entry.cap),
    [180, 240],
  );
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM rate_limits").first()).n,
    countersBefore,
    "Public edge read counters must not write primary D1",
  );
  await assert.rejects(
    api.rateLimitSearchRequest(
      readRequest,
      { ...edgeReads, COVE_STOREFRONT_READ_LIMITER: undefined },
      null,
      "recommend-home",
      180,
    ),
    (error) => error.status === 503,
  );
  await assert.rejects(
    api.rateLimitSearchRequest(
      readRequest,
      {
        ...edgeReads,
        COVE_STOREFRONT_READ_LIMITER: {
          async limit() {
            return { success: false };
          },
        },
      },
      null,
      "recommend-home",
      180,
    ),
    (error) => error.status === 429,
  );
  await assert.rejects(
    api.rateLimitSearchRequest(
      new Request("https://test/api/fore/recommendations/home"),
      edgeReads,
      null,
      "recommend-home",
      180,
    ),
    (error) => error.status === 503,
  );
  const durableCounterCost = profileD1(raw.DB);
  await api.rateLimitSearchRequest(
    new Request(readRequest, { method: "POST" }),
    { ...edgeReads, DB: durableCounterCost.db },
    null,
    "click",
    240,
  );
  assert.equal(
    durableCounterCost.snapshot().writeStatements,
    1,
    "Write accounting must recognize metadata-free .first() writes",
  );
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM rate_limits").first()).n,
    countersBefore + 1,
    "POST event abuse controls must retain their durable primary counter",
  );
  const objects = new Map();
  const store = {
    async get(k) {
      const s = objects.get(k);
      return s === undefined ? null : { size: Buffer.byteLength(s), text: async () => s };
    },
    async put(k, s) {
      objects.set(k, s);
    },
  };
  const env = { ...raw, DISCOVERY_MODELS: store };
  await rec.publishAnonymousHomeCandidates(env, "US");
  const options = {
    userId: null,
    visitorId: "00000000-0000-4000-8000-000000000001",
    territory: "US",
    limit: 20,
  };
  const expected = await rec.homeRecommendations(
    { ...env, FORE_DISCOVERY_READ_MODE: "required" },
    options,
  );
  const primaryCount = await raw.DB.prepare(
    "SELECT COUNT(*) n FROM recommendation_requests",
  ).first();
  const primaryReadSql = [];
  const readOnlyPrimary = {
    ...raw.DB,
    prepare(sql) {
      assert.ok(
        !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql),
        "Delivery must prepare only primary reads",
      );
      primaryReadSql.push(sql);
      return raw.DB.prepare(sql);
    },
  };
  const primary = profileD1(readOnlyPrimary),
    separate = profileD1(ledger);
  const serving = {
    ...env,
    DB: primary.db,
    ENGAGEMENT_DB: separate.db,
    FORE_ENGAGEMENT_STORAGE: "separate",
    FORE_DISCOVERY_READ_MODE: "required",
    FORE_ANONYMOUS_DELIVERY: "snapshot",
  };
  const actual = await rec.homeRecommendations(serving, options);
  const shape = (v) =>
    v.rails.map((r) => ({
      key: r.key,
      ids: r.books.map((b) => b.productId),
      items: r.items,
      title: r.title,
      subtitle: r.subtitle,
    }));
  assert.deepEqual(
    shape(actual),
    shape(expected),
    "Independent storage must preserve ranking and content",
  );
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM recommendation_requests").first()).n,
    primaryCount.n,
  );
  assert.ok(
    primaryReadSql.length > 0 &&
      primary.samples.every((s) => ["all", "first", "batch"].includes(s.operation)),
    "Anonymous delivery must not write primary D1",
  );
  assert.ok(
    separate.samples.some((s) => s.operation === "batch"),
    "Attribution must actually be persisted independently",
  );
  const deliveryCost = {
    primaryStatements: primary.snapshot().statements,
    engagementStatements: separate.snapshot().statements,
    primaryDeliveryWrites: 0,
  };
  const db = engagement.scopeEngagementEnv({ ...serving, DB: raw.DB, ENGAGEMENT_DB: ledger }).DB;
  const rail = actual.rails[0],
    productId = rail.books[0].productId;
  const input = { requestId: rail.requestId, productId, visitorId: options.visitorId };
  await assert.rejects(
    rec.recordRecommendationEvent(db, null, { ...input, type: "recommendation_click" }),
    /preceding visible/,
  );
  await assert.rejects(
    rec.recordRecommendationEvent(db, null, {
      ...input,
      type: "recommendation_impression",
      visitorId: crypto.randomUUID(),
    }),
    /visitor/,
  );
  assert.equal(
    (await rec.recordRecommendationEvent(db, null, { ...input, type: "recommendation_impression" }))
      .recorded,
    true,
  );
  assert.equal(
    (await rec.recordRecommendationEvent(db, null, { ...input, type: "recommendation_impression" }))
      .deduplicated,
    true,
  );
  assert.equal(
    (await rec.recordRecommendationEvent(db, null, { ...input, type: "recommendation_click" }))
      .recorded,
    true,
  );
  const queryId = await search.recordCachedSearchQuery(
    { DB: db },
    new URL("https://test/api/fore/catalog?q=alpha"),
    { results: [{ productId }], count: 1, search: { backend: "meilisearch", queryId: null } },
    "US",
  );
  assert.ok(queryId);
  await search.recordSearchClick(db, { queryId, productId, position: 1 });
  await assert.rejects(
    search.recordSearchClick(db, { queryId, productId, position: 2 }),
    /invalid/,
  );
  assert.equal((await raw.DB.prepare("SELECT COUNT(*) n FROM search_query_events").first()).n, 0);
  assert.equal((await ledger.prepare("SELECT COUNT(*) n FROM search_click_events").first()).n, 1);
  const request = new Request("https://test/api/fore/catalog");
  const beforeHttp = (await raw.DB.prepare("SELECT COUNT(*) n FROM ops_http_requests").first()).n;
  await ops.recordHttpRequest(db, ops.beginRequestTrace(request), request, new Response("ok"));
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM ops_http_requests").first()).n,
    beforeHttp,
  );
  assert.equal((await ledger.prepare("SELECT COUNT(*) n FROM ops_http_requests").first()).n, 1);
  await ops.recordHttpRequest(
    db,
    ops.beginRequestTrace(request),
    request,
    new Response("failure", { status: 503 }),
  );
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM ops_http_requests").first()).n,
    beforeHttp + 1,
    "5xx operational persistence remains primary",
  );
  const snapshot = await ops.operationsSnapshot(db);
  assert.equal(
    snapshot.http.total,
    beforeHttp + 2,
    "Dashboard combines independent success telemetry with primary errors",
  );
  assert.equal(snapshot.http.serverErrors, 1);
  await ops.refreshSloMeasurements(db);
  // Authenticated explicit outcomes remain useful for training without copying privacy to analytics.
  const alice = "engagement-alice";
  await ledger
    .prepare(
      "UPDATE recommendation_requests SET user_id=?,created_at=datetime('now','-1 minute') WHERE id=?",
    )
    .bind(alice, rail.requestId)
    .run();
  await ledger
    .prepare(
      "UPDATE recommendation_impressions SET feature_snapshot_json='[1,0,0,0,0,0]' WHERE request_id=?",
    )
    .bind(rail.requestId)
    .run();
  await rec.setRecommendationPrivacy(db, alice, {
    personalizationEnabled: true,
    activityPersonalizationEnabled: true,
    personalizedSearchEnabled: true,
  });
  await assert.rejects(
    rec.recordRecommendationEvent(db, "other-account", { ...input, type: "loved" }),
    /account/,
  );
  await rec.recordRecommendationEvent(db, alice, { ...input, type: "loved" });
  assert.ok(
    (await rec.discoveryTrainingDataset(db)).rows.some((r) => r.requestId === rail.requestId),
  );
  assert.ok(
    (await accounts.accountDataExport(db, alice)).discovery.events.length > 0,
    "Account export reads independent ledger",
  );
  const taste = await intelligence.buildLiteraryTaste(
    db,
    alice,
    new Map([[productId, [{ dimension: "themes", feature: "friendship", confidence: 1 }]]]),
  );
  assert.ok(taste.size > 0, "Literary taste consumes independent engagement outcomes");
  await rec.rebuildUserFeatures(db, alice);
  assert.ok(
    (
      await raw.DB.prepare("SELECT COUNT(*) n FROM recommendation_user_features WHERE user_id=?")
        .bind(alice)
        .first()
    ).n > 0,
  );
  const status = await rec.recommendationStatus(db);
  assert.ok(status.requests24h > 0 && status.events24h > 0);
  await rec.refreshRecommendationEvaluations(db);
  assert.ok(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM recommendation_model_evaluations").first()).n > 0,
  );
  await rec.setRecommendationPrivacy(db, alice, {
    personalizationEnabled: false,
    activityPersonalizationEnabled: false,
    personalizedSearchEnabled: false,
  });
  assert.equal(
    (await rec.discoveryTrainingDataset(db)).rows.length,
    0,
    "Current primary consent excludes historical outcomes immediately",
  );
  const page = await rec.refreshRecommendationMetrics(db, 2);
  assert.equal(page.products, 2);
  assert.equal(page.done, false);
  assert.ok(
    page.nextAfter && page.queuedContinuation,
    "Full refresh must queue a bounded continuation",
  );
  await rec.processRecommendationJobs(db, 10);
  await rec.resetRecommendationProfile(db, alice, { scope: "learned" });
  assert.equal(
    (
      await ledger
        .prepare("SELECT COUNT(*) n FROM recommendation_requests WHERE user_id=?")
        .bind(alice)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await ledger
        .prepare("SELECT COUNT(*) n FROM recommendation_events WHERE user_id=?")
        .bind(alice)
        .first()
    ).n,
    0,
  );
  // Repeated deletion and an in-flight event after deletion cannot recreate personal records.
  await engagement.eraseEngagementUser(db, alice);
  await engagement.eraseEngagementUser(db, alice);
  assert.equal(
    (
      await rec.recordRecommendationEvent(db, alice, {
        type: "book_view",
        productId,
        visitorId: crypto.randomUUID(),
      })
    ).recorded,
    false,
  );
  assert.equal(
    (
      await ledger
        .prepare("SELECT COUNT(*) n FROM recommendation_events WHERE user_id=?")
        .bind(alice)
        .first()
    ).n,
    0,
  );
  // Compare many visitor seeds, including pool-position exploration and varying limits.
  for (let i = 2; i < 82; i++) {
    const optionsForVisitor = {
      ...options,
      limit: 4 + (i % 17),
      visitorId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    };
    const reference = await rec.homeRecommendations(
      { ...serving, FORE_ANONYMOUS_DELIVERY: "classic" },
      optionsForVisitor,
    );
    const bounded = await rec.homeRecommendations(serving, optionsForVisitor);
    assert.deepEqual(shape(bounded), shape(reference), `Ranking/reason parity for visitor ${i}`);
    const previousDelivery = await rec.homeRecommendations(
      { ...serving, FORE_ANONYMOUS_DELIVERY: "bounded" },
      optionsForVisitor,
    );
    assert.deepEqual(
      shape(bounded),
      shape(previousDelivery),
      `Snapshot/bounded parity for visitor ${i}`,
    );
  }
  // A stale neutral pool with mass revocation must fall back to a bounded full check.
  const grants = (await raw.DB.prepare("SELECT id,status FROM rights_grants").all()).results;
  try {
    await raw.DB.prepare(
      "UPDATE rights_grants SET status='revoked' WHERE edition_id IN (SELECT edition_id FROM products WHERE id<>?)",
    )
      .bind(productId)
      .run();
    const reference = await rec.homeRecommendations(
      { ...serving, FORE_ANONYMOUS_DELIVERY: "classic" },
      options,
    );
    const bounded = await rec.homeRecommendations(serving, options);
    assert.deepEqual(
      shape(bounded),
      shape(reference),
      "Mass revocation must preserve exact legal ranking",
    );
  } finally {
    for (const grant of grants)
      await raw.DB.prepare("UPDATE rights_grants SET status=? WHERE id=?")
        .bind(grant.status, grant.id)
        .run();
  }
  // A ledger outage cannot silently return to primary persistence.
  const broken = {
    prepare() {
      throw Error("injected engagement outage");
    },
    async batch() {
      throw Error("injected engagement outage");
    },
  };
  await assert.rejects(
    rec.homeRecommendations({ ...serving, ENGAGEMENT_DB: broken }, options),
    /engagement outage/,
  );
  assert.equal(
    (await raw.DB.prepare("SELECT COUNT(*) n FROM recommendation_requests").first()).n,
    primaryCount.n,
  );
  console.log(
    JSON.stringify({
      ...deliveryCost,
    }),
  );
  console.log(
    "PASS: independent schema, ranking parity, zero primary delivery writes, ownership, ordering, deduplication, live consent, training, learning, status, export, reset, erasure fencing and outage isolation",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
