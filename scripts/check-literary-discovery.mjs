import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
import { trainDiscoveryRanker } from "./discovery/train-ranker.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-discovery-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "discovery-engine",
      "discovery-intelligence.server",
      "recommendations.server",
      "literary-profile",
      "api.server",
    ].map((n) => `src/features/fore/${n}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const core = await import(path.join(root, "discovery-engine.mjs"));
  const intelligence = await import(path.join(root, "discovery-intelligence.server.mjs"));
  const server = await import(path.join(root, "recommendations.server.mjs"));
  const literary = await import(path.join(root, "literary-profile.mjs"));
  const api = await import(path.join(root, "api.server.mjs"));
  const env = localBindings(root),
    db = env.DB,
    at = new Date().toISOString();
  const response = await api.handleCoveApi(new Request("https://cove.test/api/fore/catalog"), env);
  assert.equal(response.status, 200);
  const products = (
    await db
      .prepare("SELECT id FROM products WHERE storefront_status='active' ORDER BY id LIMIT 10")
      .all()
  ).results;
  assert.ok(products.length >= 3);
  const [favorite, match, other] = products.map((p) => p.id);
  async function profile(id, themes, revision = 1, confidence = 0.9) {
    const p = literary.emptyLiteraryProfile();
    p.themes = { value: themes, confidence, evidence: ["full-text-1"] };
    await db
      .prepare(
        `INSERT INTO literary_profiles(product_id,fingerprint,profile_json,status,coverage,revision,updated_at,reading_time_json) VALUES(?,?,?,'analyzed','full_text',?,?,?) ON CONFLICT(product_id) DO UPDATE SET profile_json=excluded.profile_json,revision=excluded.revision`,
      )
      .bind(
        id,
        `fp-${id}`,
        JSON.stringify(p),
        revision,
        at,
        JSON.stringify({ method: "epub_text", estimatedMinutes: 50, rangeMinutes: [40, 70] }),
      )
      .run();
  }
  const metadata = (await intelligence.loadDiscoveryFeatures(db, [favorite])).get(favorite) || [];
  const genre = metadata.find((f) => f.dimension === "genres");
  assert.ok(genre, "cold-start genre comes from explicit catalog taxonomy");
  const genreCandidates = await intelligence.retrieveLiteraryCandidates(db, [genre], "US");
  assert.ok(
    genreCandidates.includes(favorite),
    "metadata retrieval reaches catalog before full-text enrichment",
  );
  const cold = await server.literaryDiscovery(
    env,
    { userId: null, visitorId: crypto.randomUUID(), territory: "US" },
    { query: genre.feature },
  );
  assert.ok(
    cold.rails.length > 0,
    "cold-start intent uses real genre evidence without invented full-text facts",
  );
  await profile(favorite, ["friendship", "mystery"]);
  await profile(match, ["friendship"]);
  await profile(other, ["war"]);
  const indexed = await intelligence.loadLiteraryFeatures(db, [favorite, match]);
  assert.equal(indexed.get(favorite).length, 2, "trigger populates indexed features");
  const retrieved = await intelligence.retrieveLiteraryCandidates(
    db,
    [{ dimension: "themes", feature: "friendship", confidence: 1 }],
    "US",
  );
  assert.ok(retrieved.includes(match));
  await profile(other, ["friendship"], 2, 0);
  assert.equal(
    (await intelligence.loadLiteraryFeatures(db, [other])).size,
    0,
    "unknown evidence is not indexed",
  );
  await profile(other, ["war"], 3);
  const user = "discovery-test-reader";
  await intelligence.saveTasteControls(db, user, {
    likes: ["friendship"],
    dislikes: ["war"],
    adventurousness: 0,
    maxMinutes: null,
    languages: [],
  });
  assert.deepEqual((await intelligence.loadTasteControls(db, user)).likes, ["friendship"]);
  for (let i = 0; i < 60; i++)
    await server.recordRecommendationEvent(db, user, {
      type: "book_view",
      productId: favorite,
      eventId: crypto.randomUUID(),
    });
  let taste = await intelligence.buildLiteraryTaste(db, user);
  assert.ok(taste.get("themes:friendship").long <= 3, "repeat clicks bounded per book");
  await server.recordRecommendationEvent(db, user, {
    type: "rating",
    productId: favorite,
    value: 1,
    eventId: crypto.randomUUID(),
  });
  taste = await intelligence.buildLiteraryTaste(db, user);
  assert.ok(
    taste.get("themes:friendship").long < 0,
    "explicit dissatisfaction overrides click accumulation",
  );
  const learned = core.literaryCompatibility(
    indexed.get(match),
    taste,
    core.tasteControlsSchema.parse({}),
  );
  assert.ok(learned.score < 0);
  const visitor = crypto.randomUUID();
  let discovery = await server.literaryDiscovery(
    env,
    { userId: user, visitorId: visitor, territory: "US" },
    { query: "friendship, under 2 hours" },
  );
  assert.ok(discovery.rails.length > 0, "real catalog hydration and attributed rail");
  assert.ok(discovery.rails.flatMap((r) => r.items).some((i) => i.productId === match));
  assert.ok(!discovery.rails.flatMap((r) => r.items).some((i) => i.productId === other));
  const rail = discovery.rails[0];
  await server.recordRecommendationEvent(db, user, {
    type: "recommendation_impression",
    productId: rail.items[0].productId,
    requestId: rail.requestId,
    visitorId: visitor,
  });
  await server.recordRecommendationEvent(db, user, {
    type: "recommendation_click",
    productId: rail.items[0].productId,
    requestId: rail.requestId,
    visitorId: visitor,
  });
  await assert.rejects(
    () =>
      server.recordRecommendationEvent(db, "another-reader", {
        type: "recommendation_click",
        productId: rail.items[0].productId,
        requestId: rail.requestId,
        visitorId: visitor,
      }),
    /account/,
  );
  await db
    .prepare("UPDATE recommendation_requests SET created_at=? WHERE id=?")
    .bind(new Date(Date.now() - 60000).toISOString(), rail.requestId)
    .run();
  await server.recordRecommendationEvent(db, user, {
    type: "loved",
    productId: rail.items[0].productId,
    requestId: rail.requestId,
    eventId: crypto.randomUUID(),
  });
  const dataset = await server.discoveryTrainingDataset(db);
  assert.equal(
    dataset.rows.length,
    1,
    "visible explicit account-attributed label exports with serving features",
  );
  assert.equal(dataset.rows[0].features.length, 6);
  assert.equal(dataset.rows[0].label, 1);
  assert.notEqual(dataset.rows[0].readerKey, user, "exports rotate reader pseudonyms");
  await assert.rejects(
    () =>
      server.recordRecommendationEvent(db, "another-reader", {
        type: "loved",
        productId: rail.items[0].productId,
        requestId: rail.requestId,
        eventId: crypto.randomUUID(),
      }),
    /account/,
  );
  const eventId = crypto.randomUUID();
  await server.recordRecommendationEvent(db, user, { type: "loved", productId: match, eventId });
  assert.equal(
    (await server.recordRecommendationEvent(db, user, { type: "loved", productId: match, eventId }))
      .deduplicated,
    true,
  );
  await assert.rejects(
    () =>
      server.recordRecommendationEvent(db, user, { type: "rating", productId: match, value: 50 }),
    /between 1 and 5/,
  );
  discovery = await server.literaryDiscovery(
    env,
    { userId: null, visitorId: visitor, territory: "US" },
    { query: "a completely unrecorded theme" },
  );
  assert.equal(discovery.rails.length, 0, "no invented intent match or popularity substitution");
  discovery = await server.literaryDiscovery(
    env,
    { userId: null, visitorId: visitor, territory: "US" },
    { query: "friendship, under 5 minutes" },
  );
  assert.equal(discovery.rails.length, 0, "hard length constraint uses range upper bound");
  const before = await intelligence.loadTasteControls(db, user);
  await server.literaryDiscovery(
    env,
    { userId: user, visitorId: visitor, territory: "US" },
    { query: "less friendship" },
  );
  assert.deepEqual(
    await intelligence.loadTasteControls(db, user),
    before,
    "session intent never rewrites saved taste",
  );
  await server.setRecommendationPrivacy(db, user, {
    personalizationEnabled: false,
    activityPersonalizationEnabled: false,
    personalizedSearchEnabled: false,
  });
  const disabled = await server.recordRecommendationEvent(db, user, {
    type: "loved",
    productId: match,
    eventId: crypto.randomUUID(),
  });
  assert.equal(disabled.learned, false);
  assert.equal(
    (await server.discoveryTrainingDataset(db)).rows.length,
    0,
    "training export excludes opted-out readers",
  );
  discovery = await server.literaryDiscovery(
    env,
    { userId: user, visitorId: visitor, territory: "US" },
    {},
  );
  assert.equal(discovery.rails[0]?.personalized, false, "opt out ignores saved and inferred taste");
  await db
    .prepare(
      "INSERT INTO reading_states(user_id,product_id,external_book_id,status,progress,updated_at) VALUES(?,?,?,'finished',1,?)",
    )
    .bind(user, favorite, "1342", "2025-01-01T00:00:00.000Z")
    .run();
  await server.resetRecommendationProfile(db, user, { scope: "all" });
  assert.equal((await intelligence.loadTasteControls(db, user)).likes.length, 0);
  assert.equal((await intelligence.buildLiteraryTaste(db, user)).size, 0);
  const intent = core.parseDiscoveryIntent("mystery, less war, under 3 hours");
  assert.deepEqual(intent, {
    likes: ["mystery"],
    avoids: ["war"],
    maxMinutes: 180,
    unresolved: [],
  });
  assert.equal(core.satisfactionEvidence("pause"), 0);
  await profile(match, ["new theme"], 4);
  assert.ok(
    !(await intelligence.loadLiteraryFeatures(db, [match]))
      .get(match)
      .some((f) => f.feature === "friendship"),
    "profile revision removes stale inverted features",
  );
  const http = await api.handleCoveApi(
    new Request(`https://cove.test/api/fore/recommendations/discover?visitor=${visitor}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "new theme" }),
    }),
    env,
  );
  assert.equal(http.status, 200);
  assert.ok((await http.json()).rails.length > 0);
  // Synthetic data validates the trainer, not real reader enjoyment accuracy.
  const synthetic = Array.from({ length: 300 }, (_, i) => ({
    requestId: `r-${i}`,
    productId: `p-${i % 9}`,
    readerKey: `u-${i % 30}`,
    features: [i % 2 ? 1 : -1, 0, 0, 0, 0, 1],
    label: i % 2,
    servedAt: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(),
    observedAt: new Date(Date.UTC(2025, 0, 1) + i * 86400000 + 1000).toISOString(),
  }));
  const trained = trainDiscoveryRanker(synthetic);
  assert.ok(trained.evaluation.improvesPrior);
  assert.equal(trained.evaluation.automaticActivation, false);
  assert.ok(Date.parse(trained.model.trainedThrough) < Date.parse(synthetic[240].servedAt));
  assert.throws(() => trainDiscoveryRanker(synthetic.slice(0, 30)), /Insufficient/);
  const delayed = [
    ...synthetic.map((r, i) => (i === 0 ? { ...r, observedAt: synthetic.at(-1).observedAt } : r)),
  ];
  assert.ok(
    trainDiscoveryRanker(delayed).evaluation.temporalPurge > 0,
    "late labels excluded from training horizon",
  );
  // Reset earlier removed this request, so use the HTTP-served request for the persisted snapshot check.
  const latestSnapshot = await db
    .prepare(
      "SELECT feature_snapshot_json FROM recommendation_impressions ORDER BY rowid DESC LIMIT 1",
    )
    .first();
  assert.equal(JSON.parse(latestSnapshot.feature_snapshot_json).length, 6);
  await assert.rejects(
    () =>
      server.recordRecommendationEvent(db, "forger", {
        type: "loved",
        productId: match,
        requestId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      }),
    /not served/,
  );
  await db.prepare("DELETE FROM literary_profiles WHERE product_id=?").bind(match).run();
  assert.equal(
    (await intelligence.loadLiteraryFeatures(db, [match])).size,
    0,
    "profile deletion removes indexed evidence",
  );
  console.log(
    "Literary discovery: migration, index freshness, retrieval, real rails, bounded learning, dissatisfaction, privacy, attribution, session isolation and constraints passed.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
