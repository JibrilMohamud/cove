import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-discovery-read-"));
const originalFetch = globalThis.fetch;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/api.server.ts",
      "src/features/fore/recommendations.server.ts",
      "src/features/fore/merchandising.server.ts",
      "src/features/fore/search.server.ts",
      "src/features/fore/discovery-read-model.server.ts",
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
  const api = await import(path.join(root, "api.server.mjs"));
  const rec = await import(path.join(root, "recommendations.server.mjs"));
  const merch = await import(path.join(root, "merchandising.server.mjs"));
  const search = await import(path.join(root, "search.server.mjs"));
  const models = await import(path.join(root, "discovery-read-model.server.mjs"));
  const rights = await import(path.join(root, "discovery-rights.server.mjs"));
  const { profileD1 } = await import(path.join(root, "d1-cost-profile.server.mjs"));
  const objects = new Map();
  const store = {
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : { size: Buffer.byteLength(value), text: async () => value };
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
  const env = { ...localBindings(root), FORE_ENVIRONMENT: "development", DISCOVERY_MODELS: store };
  const seed = await api.handleCoveApi(
    new Request("https://test/api/fore/storefront/bootstrap", {
      headers: { "cf-ipcountry": "US" },
    }),
    env,
  );
  assert.equal(seed.status, 200, await seed.text());
  const ids = (
    await env.DB.prepare("SELECT product_id FROM catalog_search_documents LIMIT 100").all()
  ).results.map((row) => row.product_id);
  assert.ok(ids.length >= 10);
  const opts = {
    userId: null,
    visitorId: "00000000-0000-4000-8000-000000000001",
    territory: "US",
    limit: 12,
  };
  // Independent request-local accounting preserves bind/batch/session behavior.
  const p1 = profileD1(env.DB),
    p2 = profileD1(env.DB);
  await p1.db.prepare("SELECT 1").first();
  assert.equal(p1.samples.length, 1);
  assert.equal(p2.samples.length, 0);
  assert.equal(p1.samples[0].sqlMs, null, "Missing metadata is unknown, not zero");
  await p1.db.batch([p1.db.prepare("SELECT 2"), p1.db.prepare("SELECT 3")]);
  assert.equal(p1.samples.length, 3);
  const baselineCost = profileD1(env.DB);
  const baseline = await rec.homeRecommendations({ ...env, DB: baselineCost.db }, opts);
  await rec.publishAnonymousHomeCandidates(env, "US");
  const serving = { ...env, FORE_DISCOVERY_READ_MODE: "required" };
  const readCost = profileD1(env.DB);
  const projected = await rec.homeRecommendations({ ...serving, DB: readCost.db }, opts);
  const railIds = (value) =>
    value.rails.map((rail) => ({
      key: rail.key,
      books: rail.books.map((b) => b.productId),
      reasons: rail.items.map((i) => i.reason),
    }));
  assert.deepEqual(
    railIds(projected),
    railIds(baseline),
    "Projection must preserve ranking, diversity and reasons for same visitor",
  );
  assert.ok(
    readCost.samples.length < baselineCost.samples.length,
    "Serving must perform fewer D1 statements",
  );
  console.log(
    JSON.stringify({
      event: "discovery_local_cost",
      baselineStatements: baselineCost.samples.length,
      projectedStatements: readCost.samples.length,
    }),
  );
  // Every response has a fresh request identity; the stored model contains no user/visitor IDs.
  const next = await rec.homeRecommendations(serving, {
    ...opts,
    visitorId: "00000000-0000-4000-8000-000000000002",
  });
  if (projected.rails.length)
    assert.notEqual(next.rails[0].requestId, projected.rails[0].requestId);
  const snapshots = [...objects.values()].join("");
  assert.ok(!snapshots.includes(opts.visitorId));
  // A stale candidate model cannot authorize a revocation committed after publication.
  const revoked = projected.rails.flatMap((r) => r.books).find((b) => b.productId)?.productId;
  assert.ok(revoked, "Need an authorized fixture recommendation");
  await env.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?)",
  )
    .bind(revoked)
    .run();
  const afterRevocation = await rec.homeRecommendations(serving, opts);
  assert.ok(!afterRevocation.rails.flatMap((r) => r.books).some((b) => b.productId === revoked));
  assert.ok(!(await rights.authorizeDiscoveryCandidates(env.DB, [revoked], "US")).has(revoked));
  assert.equal((await rights.authorizeDiscoveryCandidates(env.DB, ids, "CA")).size, 0);
  const beforeMiss = profileD1(env.DB);
  await assert.rejects(
    rec.homeRecommendations({ ...serving, DB: beforeMiss.db }, { ...opts, territory: "CA" }),
    (e) => e.status === 503,
  );
  assert.equal(beforeMiss.samples.length, 0, "A miss must not regenerate candidates");
  await assert.rejects(
    rights.authorizeDiscoveryCandidates(
      env.DB,
      Array.from({ length: 601 }, (_, i) => "p" + i),
      "US",
    ),
    (e) => e.status === 503,
  );
  const authCost = profileD1(env.DB);
  await rights.authorizeDiscoveryCandidates(authCost.db, ids, "US");
  assert.equal(authCost.samples.length, 1, "One bounded primary authorization operation");
  // Merchandising projection retains per-visitor placement/experiment assignment and reads current books/offers.
  await merch.publishAnonymousMerchandising(env, { territory: "US", language: "en" });
  const merchandise = await merch.storefrontMerchandising(serving, { ...opts, language: "en" });
  assert.ok(
    !Object.values(merchandise.slots)
      .flat()
      .flatMap((p) => p.books)
      .some((b) => b.productId === revoked),
  );
  const deadline = Date.now() + 60_000;
  await env.DB.prepare(
    "UPDATE merch_campaigns SET ends_at=? WHERE id=(SELECT id FROM merch_campaigns LIMIT 1)",
  )
    .bind(new Date(deadline).toISOString())
    .run();
  await merch.publishAnonymousMerchandising(env, { territory: "US", language: "en" });
  const merchPointer = JSON.parse(objects.get("discovery/v1/merchandising/US_en/current.json"));
  const merchKey = `discovery/v1/merchandising/US_en/${merchPointer.revision}.json`;
  const merchVersion = JSON.parse(objects.get(merchKey));
  assert.ok(
    Math.abs(merchVersion.data.validUntil - deadline) < 1000,
    "Projection must stop at the earliest future schedule boundary",
  );
  objects.set(
    merchKey,
    JSON.stringify({ ...merchVersion, data: { ...merchVersion.data, validUntil: Date.now() - 1 } }),
  );
  await assert.rejects(
    merch.storefrontMerchandising(serving, { ...opts, language: "en" }),
    (error) => error.status === 503,
  );
  objects.set(merchKey, JSON.stringify(merchVersion));
  // External search candidates are untrusted. Index lag drops revoked books without D1 search fallback.
  const externalEnv = {
    ...serving,
    FORE_SEARCH_BACKEND: "meilisearch",
    FORE_SEARCH_FALLBACK: "disabled",
    FORE_SEARCH_URL: "https://search.test",
    FORE_SEARCH_SEARCH_KEY: "test-only",
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json(
      body.queries
        ? { results: body.queries.map(() => ({ facetDistribution: {} })) }
        : {
            hits: ids.slice(0, 12).map((id) => ({ id })),
            totalHits: ids.length,
            processingTimeMs: 1,
            facetDistribution: {},
          },
    );
  };
  const input = {
    ...search.parseSearchInput(new URL("https://test/api/fore/catalog?search=book")),
    territory: "US",
  };
  const fromIndex = await search.searchCatalog(externalEnv, input, null);
  assert.equal(fromIndex.backend, "meilisearch");
  assert.ok(!fromIndex.books.some((book) => book.productId === revoked));
  globalThis.fetch = async () => {
    throw new Error("engine unavailable");
  };
  const outage = profileD1(env.DB);
  await assert.rejects(
    search.searchCatalog({ ...externalEnv, DB: outage.db }, input, null),
    (e) => e.status === 503,
  );
  assert.equal(outage.samples.length, 0, "Search outage must not stampede D1");
  // Expired/corrupt/mismatched projections fail closed before any database access.
  const pointerKey = "discovery/v1/home-candidates/US/current.json";
  const pointer = objects.get(pointerKey);
  objects.set(
    pointerKey,
    JSON.stringify({ ...JSON.parse(pointer), generatedAt: Date.now() - 301000 }),
  );
  await assert.rejects(rec.homeRecommendations(serving, opts), (e) => e.status === 503);
  objects.set(pointerKey, pointer);
  const revisionKey = `discovery/v1/home-candidates/US/${JSON.parse(pointer).revision}.json`;
  const revision = JSON.parse(objects.get(revisionKey));
  objects.set(revisionKey, JSON.stringify({ ...revision, scope: "CA" }));
  await assert.rejects(rec.homeRecommendations(serving, opts), (e) => e.status === 503);
  console.log(
    "PASS: read-model ranking parity, bounded primary authorization, committed revocation, market isolation, model expiry/corruption, Meilisearch outage isolation and request-local cost accounting",
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
