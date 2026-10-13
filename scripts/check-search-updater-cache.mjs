import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-search-"));
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/api.server.ts",
      "src/features/fore/search.server.ts",
      "src/features/fore/public-api-cache.server.ts",
      "src/features/fore/catalog-fetch.server.ts",
    ],
    entryNames: "[name]",
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(scratch, "api.server.mjs"));
  const search = await import(path.join(scratch, "search.server.mjs"));
  const cache = await import(path.join(scratch, "public-api-cache.server.mjs"));
  const { fetchCatalogPage } = await import(path.join(scratch, "catalog-fetch.server.mjs"));
  const env = localBindings(scratch);
  const request = (route) => new Request(`https://fore.test/api/fore${route}`);
  const input = (query) => search.parseSearchInput(new URL(`https://fore.test/catalog?${query}`));
  assert.deepEqual(input("language=en,fr&language=de&language=en").languages, ["en", "fr", "de"]);
  assert.deepEqual(input("publisher=Smith%2C+Ltd&publisher=Other+House").publishers, [
    "Smith, Ltd",
    "Other House",
  ]);
  globalThis.fetch = async () => {
    throw new Error("Browsing must not fetch an upstream catalog");
  };
  const baseline = await api.handleCoveApi(request("/catalog?search=pride"), env);
  assert.equal(baseline.status, 200);
  const data = await baseline.json();
  assert.ok(data.results.some((book) => book.title.includes("Pride")));
  assert.equal("sources" in data.ingestion, false);
  assert.equal((await search.searchCatalog(env, input("q=!!!"), null)).count, 0);
  assert.deepEqual(await search.searchSuggestions(env, "!!"), []);
  assert.ok(
    (await search.searchSuggestions(env, "1342")).length,
    "identifier suggestions must be ranked without a missing alias",
  );

  // Synthesize a full two-page search using the normal catalog normalization path.
  const seed = JSON.parse(fs.readFileSync("src/features/fore/catalog-seed.json", "utf8"))
    .results[0];
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=0 WHERE id<>'pg_us'").run();
  globalThis.fetch = async () =>
    Response.json({
      results: Array.from({ length: 28 }, (_, i) => ({
        ...seed,
        id: 900001 + i,
        title: `Adventure volume ${900001 + i}`,
        copyright: false,
      })),
      next: null,
      count: 28,
    });
  const imported = await api.runCatalogIngestion({ ...env, BUCKET: undefined });
  assert.equal(imported.inserted, 28);
  const first = await search.searchCatalog(env, input("q=adventurre&limit=24&page=1"), null);
  const second = await search.searchCatalog(env, input("q=adventurre&limit=24&page=2"), null);
  assert.ok(first.correctedQuery);
  assert.equal(second.correctedQuery, first.correctedQuery);
  assert.equal(second.count, first.count);
  assert.ok(second.books.length > 0);
  assert.equal(
    new Set([...first.books, ...second.books].map((book) => book.productId)).size,
    first.books.length + second.books.length,
  );
  const repeated = await api.handleCoveApi(
    request("/catalog?search=adventure&limit=1&language=en&language=fr"),
    env,
  );
  const next = new URL((await repeated.json()).next, "https://fore.test");
  assert.deepEqual(next.searchParams.getAll("language"), ["en", "fr"]);
  let facetAggregations = 0;
  const tracked = {
    ...env,
    DB: {
      ...env.DB,
      prepare(sql) {
        if (sql.includes("FROM candidate")) facetAggregations++;
        return env.DB.prepare(sql);
      },
    },
  };
  await search.searchCatalog(tracked, input("q=adventure&page=1"), null);
  const coldAggregations = facetAggregations;
  await search.searchCatalog(tracked, input("q=adventure&page=2"), null);
  assert.equal(coldAggregations, 7);
  assert.equal(
    facetAggregations,
    coldAggregations,
    "pagination must reuse public facets instead of re-running all seven aggregations",
  );

  // Shared cache preserves market/locale variants and regenerates impression identities.
  globalThis.caches = undefined;
  const pending = [];
  const ctx = {
    waitUntil(work) {
      pending.push(work);
    },
  };
  let handlerCalls = 0;
  const handler = async (req) => {
    handlerCalls++;
    return api.handleCoveApi(req, env);
  };
  const cacheRequest = new Request(
    "https://backend.example.workers.dev/api/fore/catalog?search=adventure",
  );
  const logical = request("/catalog?search=adventure");
  const miss = await cache.cachedPublicApi(logical, cacheRequest, env, ctx, handler);
  const missData = await miss.json();
  assert.equal(miss.headers.get("x-cove-backend-cache"), "MISS");
  await Promise.all(pending.splice(0));
  const hit = await cache.cachedPublicApi(logical, cacheRequest, env, ctx, handler);
  const hitData = await hit.json();
  assert.equal(hit.headers.get("x-cove-backend-cache"), "HIT");
  assert.equal(handlerCalls, 1);
  assert.ok(hitData.search.queryId);
  assert.notEqual(hitData.search.queryId, missData.search.queryId);
  assert.notEqual(hit.headers.get("x-fore-request-id"), miss.headers.get("x-fore-request-id"));
  assert.equal(hit.headers.get("cache-control"), "no-store");
  const key = (url, headers = {}) => cache.publicCacheKey(new Request(url, { headers })).url;
  assert.equal(
    key("https://backend.test/api/fore/catalog?a=1&b=2"),
    key("https://backend.test/api/fore/catalog?b=2&a=1"),
  );
  assert.notEqual(
    key("https://backend.test/api/fore/catalog", { "accept-language": "zz,fr;q=0.9" }),
    key("https://backend.test/api/fore/catalog", { "accept-language": "zz,en;q=0.9" }),
  );
  assert.notEqual(
    key("https://backend.test/api/fore/catalog", { "x-cove-client-country": "US" }),
    key("https://backend.test/api/fore/catalog", { "x-cove-client-country": "CA" }),
  );
  for (const headers of [
    { cookie: "session=private" },
    { authorization: "Bearer fixture" },
    { range: "bytes=0-1" },
  ])
    assert.equal(cache.publicCacheEligible(new Request(logical, { headers })), false);
  assert.equal(cache.publicCacheEligible(request("/account")), false);
  const row = await env.DB.prepare(
    "SELECT body FROM api_cache WHERE key LIKE 'public-api:v2:%'",
  ).first();
  assert.equal(JSON.parse(row.body).search.queryId, null);
  await env.DB.prepare("UPDATE api_cache SET expires_at=0 WHERE key LIKE 'public-api:v2:%'").run();
  const expired = await cache.cachedPublicApi(logical, cacheRequest, env, ctx, handler);
  assert.equal(expired.headers.get("x-cove-backend-cache"), "MISS");
  await Promise.all(pending.splice(0));
  // Edge read failures and corrupt entries must not become catalog failures.
  globalThis.caches = {
    default: {
      async match() {
        throw new Error("cache unavailable");
      },
      async put() {},
    },
  };
  const live = await cache.cachedPublicApi(
    logical,
    new Request("https://backend.test/api/fore/catalog?search=adventure"),
    env,
    ctx,
    handler,
  );
  assert.equal(live.status, 200);
  await Promise.all(pending.splice(0));
  await env.DB.prepare(
    "UPDATE api_cache SET body='not JSON' WHERE key LIKE 'public-api:v2:%'",
  ).run();
  assert.equal((await cache.cachedPublicApi(logical, cacheRequest, env, ctx, handler)).status, 200);
  await Promise.all(pending.splice(0));
  await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'public-api:v2:%'").run();
  const failureHandler = async () => Response.json({ error: "unavailable" }, { status: 503 });
  await cache.cachedPublicApi(logical, cacheRequest, env, ctx, failureHandler);
  await Promise.all(pending.splice(0));
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM api_cache WHERE key LIKE 'public-api:v2:%'",
      ).first()
    ).n,
    0,
  );

  for (let i = 0; i < 130; i++) {
    const statusRequest = request(`/service-status?fixture=${i}`);
    await cache.cachedPublicApi(
      statusRequest,
      new Request(`https://backend.example.workers.dev/api/fore/service-status?fixture=${i}`),
      env,
      ctx,
      async () => Response.json({ fixture: i }),
    );
    await Promise.all(pending.splice(0));
  }
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM api_cache WHERE key LIKE 'public-api:v2:%'",
      ).first()
    ).n,
    128,
    "public cache entries must remain bounded under many distinct URLs",
  );

  // Force an outbox change while the external index upload is in progress.
  const selected = await env.DB.prepare(
    "SELECT product_id,change_token FROM search_index_outbox ORDER BY queued_at,product_id LIMIT 1",
  ).first();
  let uploadChanges = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes("/documents?")) {
      uploadChanges++;
      await env.DB.prepare(
        "UPDATE catalog_search_documents SET title=title||' revised' WHERE product_id=?",
      )
        .bind(selected.product_id)
        .run();
    }
    return Response.json({ uid: "fore_books" });
  };
  const external = {
    ...env,
    FORE_SEARCH_URL: "https://search.test",
    FORE_SEARCH_ADMIN_KEY: "fixture-search-key",
  };
  await search.syncSearchIndex(external, 1);
  assert.equal(uploadChanges, 1);
  const retained = await env.DB.prepare(
    "SELECT change_token FROM search_index_outbox WHERE product_id=?",
  )
    .bind(selected.product_id)
    .first();
  assert.ok(retained);
  assert.notEqual(retained.change_token, selected.change_token);
  await env.DB.prepare(
    "UPDATE search_index_state SET sync_lease_token='other',sync_lease_until=? WHERE id=1",
  )
    .bind(new Date(Date.now() + 60000).toISOString())
    .run();
  assert.equal((await search.syncSearchIndex(external, 1)).skipped, "running");

  // Two workers reading the same old state must not fetch the same US page.
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=0 WHERE id<>'pg_us'").run();
  await env.DB.prepare(
    "UPDATE catalog_state SET status='idle',next_url=NULL,last_success_at=NULL,next_run_at='',lease_token=NULL,lease_until=NULL WHERE id=1",
  ).run();
  const updaterEnv = { ...env, BUCKET: undefined };
  let catalogCalls = 0;
  let release;
  const responseGate = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    catalogCalls++;
    await responseGate;
    return Response.json({ results: [], next: null, count: 0 });
  };
  const a = api.runCatalogIngestion(updaterEnv);
  while (!catalogCalls) await new Promise((resolve) => setTimeout(resolve, 1));
  const b = await api.runCatalogIngestion(updaterEnv);
  assert.equal(b.skipped, "running");
  release();
  await a;
  assert.equal(catalogCalls, 1);
  assert.equal(
    (await env.DB.prepare("SELECT lease_token FROM catalog_state WHERE id=1").first()).lease_token,
    null,
  );
  assert.equal(
    (await api.runCatalogIngestion(updaterEnv, 1, { deadlineMs: Date.now() - 1 })).skipped,
    "deadline",
  );
  let timeoutSignal;
  globalThis.fetch = (_url, options) => {
    timeoutSignal = options.signal;
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("expired", "AbortError")),
        { once: true },
      ),
    );
  };
  const keepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(
      fetchCatalogPage("https://catalog.test/books", { deadlineMs: Date.now() + 10 }),
      /deadline/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(timeoutSignal.aborted, true);
  let retryCalls = 0;
  globalThis.fetch = async () => {
    retryCalls++;
    return new Response("busy", { status: 429, headers: { "retry-after": "3600" } });
  };
  await assert.rejects(
    fetchCatalogPage("https://catalog.test/books"),
    (error) => error.retryAfterMs === 3600000,
  );
  assert.equal(retryCalls, 1, "long upstream retry windows must yield to the durable scheduler");
  // Strict two-download ticks must rotate fairly across three backlogged sources.
  await env.DB.prepare("UPDATE gutenberg_source_cache SET epub_status='completed'").run();
  for (const [id, source] of [
    [900001, "pg_au"],
    [900002, "pg_ca"],
    [900003, "pg_us"],
  ]) {
    await env.DB.prepare(
      "UPDATE gutenberg_source_cache SET source_id=?,epub_status='pending',epub_next_attempt_at='' WHERE id=?",
    )
      .bind(source, String(id))
      .run();
  }
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  const downloadTick = await api.runCatalogIngestion(env, 2);
  assert.equal(downloadTick.epubs.attempted, 2);
  const followingTick = await api.runCatalogIngestion(env, 2);
  assert.ok(followingTick.epubs.attempted <= 2);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM gutenberg_source_states WHERE source_id IN ('pg_us','pg_ca','pg_au') AND epub_last_attempt_at IS NOT NULL",
      ).first()
    ).n,
    3,
  );
  assert.equal((await env.DB.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  console.log(
    "PASS: repeated filters, identifier suggestions, typo pagination, read-only browsing, D1/edge cache recovery and isolation, fresh cache-hit impressions, outbox races, exclusive updater claims and deadline handling.",
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
  fs.rmSync(scratch, { recursive: true, force: true });
}
