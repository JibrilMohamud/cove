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
      "src/persistence-backend.worker.ts",
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
  const { default: worker } = await import(path.join(scratch, "persistence-backend.worker.mjs"));
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
  await env.DB.prepare(
    "UPDATE catalog_state SET status='failed',last_error='Upstream unavailable' WHERE id=1",
  ).run();
  const retryingCatalog = await (
    await api.handleCoveApi(request("/catalog?search=pride"), env)
  ).json();
  assert.ok(retryingCatalog.results.length);
  assert.equal(
    retryingCatalog.warning,
    undefined,
    "background failures must not warn on healthy indexed results",
  );
  assert.equal(retryingCatalog.ingestion.status, "failed", "updater diagnostics remain observable");
  await env.DB.prepare("UPDATE catalog_state SET status='idle',last_error='' WHERE id=1").run();
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
  // Production canonical normalization without an owner lease is denied.
  assert.equal(imported.failed, true, "owner-less catalog ingestion must fail closed");
  assert.match(imported.error, /Catalog normalization requires private authority/);
  const unowned = await env.DB.prepare(
    "SELECT id FROM products WHERE id='prd_gutenberg_900001'",
  ).first();
  assert.equal(unowned, null, "failed owner normalization cannot publish a product");
  env.seedAdditionalLocalCatalogBooks(
    Array.from({ length: 28 }, (_, i) => ({
      ...seed,
      id: 900001 + i,
      title: `Adventure volume ${900001 + i}`,
      copyright: false,
    })),
  );
  const fixtureCount = await env.DB.prepare(
    "SELECT COUNT(*) n FROM products WHERE id LIKE 'prd_gutenberg_9000%'",
  ).first();
  assert.equal(fixtureCount.n, 28, "only the local fixture adds 28 synthetic catalog rows");
  // Exercise real parsed aliases and real rights-filtered queries, not only
  // cache-key helpers. Newest is normalized to released (a FILTER, not just order).
  assert.equal(input("sort=newest").sort, "released");
  const releaseFixture = await env.DB.prepare(
    "SELECT id,release_date,publication_date,release_status FROM editions WHERE id=(SELECT edition_id FROM products WHERE id=(SELECT product_id FROM catalog_search_documents WHERE external_book_id='900001' LIMIT 1))",
  ).first();
  assert.ok(releaseFixture);
  await env.DB.prepare(
    "UPDATE editions SET release_date='2099-01-01',publication_date=NULL,release_status='preorder' WHERE id=?",
  )
    .bind(releaseFixture.id)
    .run();
  const clearSearchCaches = () =>
    env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-%'").run();
  try {
    const populations = ["popular", "newest", "published", "coming_soon"];
    const expected = new Map();
    for (const sort of populations) {
      await clearSearchCaches();
      const result = await search.searchCatalog(env, input(`sort=${sort}`), null);
      expected.set(sort, { count: result.count, facets: result.facets });
    }
    assert.ok(expected.get("popular").count > expected.get("newest").count);
    assert.ok(expected.get("coming_soon").count > 0);
    await clearSearchCaches();
    for (const sort of populations) {
      const actual = await search.searchCatalog(env, input(`sort=${sort}`), null);
      assert.deepEqual(
        { count: actual.count, facets: actual.facets },
        expected.get(sort),
        `Warm browsing must not change ${sort} release-population totals or facets`,
      );
    }
  } finally {
    await env.DB.prepare(
      "UPDATE editions SET release_date=?,publication_date=?,release_status=? WHERE id=?",
    )
      .bind(
        releaseFixture.release_date,
        releaseFixture.publication_date,
        releaseFixture.release_status,
        releaseFixture.id,
      )
      .run();
    await clearSearchCaches();
  }
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
        if (sql.includes("FROM candidate")) {
          facetAggregations++;
          assert.ok(
            !sql.includes("UNION ALL"),
            "shared facets must avoid D1 compound-SELECT limits",
          );
        }
        return env.DB.prepare(sql);
      },
    },
  };
  await search.searchCatalog(tracked, input("q=adventure&page=1"), null);
  const coldAggregations = facetAggregations;
  await search.searchCatalog(tracked, input("q=adventure&page=2"), null);
  assert.equal(coldAggregations, 1, "unfiltered facets must share one materialized candidate scan");
  assert.equal(
    facetAggregations,
    coldAggregations,
    "pagination must reuse public facets instead of re-running the candidate aggregation",
  );

  let fullCounts = 0;
  const countTracked = {
    ...env,
    DB: {
      ...env.DB,
      prepare(sql) {
        if (sql.includes("SELECT COUNT(*) count FROM")) fullCounts++;
        return env.DB.prepare(sql);
      },
    },
  };
  const warmPage = await search.searchCatalog(countTracked, input("q=adventure&page=1"), null);
  assert.ok(warmPage.books.length);
  assert.equal(fullCounts, 0, "warm pages must not rescan the entire catalog for counts");
  const withdrawn = warmPage.books[0].productId;
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?")
    .bind(withdrawn)
    .run();
  const rightsChanged = await search.searchCatalog(env, input("q=adventure&page=1"), null);
  assert.equal(
    rightsChanged.books.some((book) => book.productId === withdrawn),
    false,
    "cached page IDs must respect current suppression",
  );
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=0 WHERE product_id=?")
    .bind(withdrawn)
    .run();

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
  const cachedProduct = hitData.results[0].productId;
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?")
    .bind(cachedProduct)
    .run();
  const withdrawnHit = await cache.cachedPublicApi(logical, cacheRequest, env, ctx, handler);
  assert.equal(withdrawnHit.headers.get("x-cove-backend-cache"), "MISS");
  assert.equal(
    (await withdrawnHit.json()).results.some((book) => book.productId === cachedProduct),
    false,
  );
  await Promise.all(pending.splice(0));
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=0 WHERE product_id=?")
    .bind(cachedProduct)
    .run();
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
  assert.equal(
    key("https://backend.test/api/fore/storefront/bootstrap", {
      "accept-language": "FR-fr, en-US;q=0.800, de-DE;q=0.3",
    }),
    key("https://backend.test/api/fore/storefront/bootstrap", {
      "accept-language": "fr-FR;q=1.0,en-us;q=0.7,de-de;q=0.1",
    }),
    "Equivalent language priorities must share the same guest bootstrap cache",
  );
  assert.notEqual(
    key("https://backend.test/api/fore/storefront/bootstrap", {
      "accept-language": "fr-FR;q=0.7,en-US",
    }),
    key("https://backend.test/api/fore/storefront/bootstrap", {
      "accept-language": "fr-FR,en-US;q=0.7",
    }),
    "Different negotiated language priorities must not share a cache entry",
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
  for (const [country, locale] of [
    ["US", "en-US"],
    ["ES", "es-ES"],
    ["FR", "fr-FR"],
    ["DE", "de-DE"],
    ["SA", "ar-SA"],
  ]) {
    const contextRequest = new Request("https://fore.test/api/fore/storefront/context", {
      headers: { "x-cove-client-country": country, "accept-language": locale },
    });
    const contextBackend = new Request(
      "https://backend.example.workers.dev/api/fore/storefront/context",
      { headers: contextRequest.headers },
    );
    const miss = await cache.cachedPublicApi(contextRequest, contextBackend, env, ctx, handler);
    assert.equal(miss.headers.get("x-cove-backend-cache"), "MISS");
    const before = await miss.json();
    assert.equal(before.rightsCountry, country);
    assert.equal(before.locale, locale);
    assert.ok(before.uiMessages);
    await Promise.all(pending.splice(0));
    const callsBefore = handlerCalls;
    const hit = await cache.cachedPublicApi(contextRequest, contextBackend, env, ctx, handler);
    assert.equal(hit.headers.get("x-cove-backend-cache"), "HIT");
    assert.deepEqual(await hit.json(), before);
    assert.equal(
      handlerCalls,
      callsBefore,
      "warm public UI context avoids repeated configuration lookups",
    );
    const privateRequest = new Request(contextRequest, {
      headers: { ...Object.fromEntries(contextRequest.headers), cookie: "session=private" },
    });
    const bypass = await cache.cachedPublicApi(privateRequest, contextBackend, env, ctx, handler);
    assert.equal(bypass.headers.get("x-cove-backend-cache"), "BYPASS");
    assert.equal(handlerCalls, callsBefore + 1);
  }
  assert.equal(cache.publicCacheTtl("/api/fore/storefront/context"), 30);
  for (const headers of [
    { cookie: "session=private" },
    { authorization: "Bearer fixture" },
    { "oai-authenticated-user-id": "private-reader" },
  ])
    assert.equal(
      cache.publicCacheEligible(
        new Request("https://cove.test/api/fore/storefront/context", { headers }),
      ),
      false,
    );
  assert.equal(
    cache.publicCacheEligible(
      new Request(logical, { headers: { cookie: "fore-locale=en-US; fore-currency=USD" } }),
    ),
    true,
  );
  assert.equal(
    key(logical.url, { cookie: "fore-locale=en-US; fore-currency=USD" }),
    key(logical.url, { cookie: "fore-currency=USD; fore-locale=en-US" }),
  );
  assert.notEqual(
    key(logical.url, { cookie: "fore-locale=en-US" }),
    key(logical.url, { cookie: "fore-locale=fr-CA" }),
  );
  // A guest homepage should hit one rights-safe combined bootstrap instead of
  // querying taxonomy, store settings and catalog on every HTML navigation.
  const bootstrapLogical = request("/storefront/bootstrap");
  const bootstrapBackend = new Request(
    "https://backend.example.workers.dev/api/fore/storefront/bootstrap",
  );
  assert.equal(cache.publicCacheTtl("/api/fore/storefront/bootstrap"), 300);
  const bootstrapHandler = async (req) => {
    const response = await handler(req);
    const value = await response.json();
    // A cache hit must never replay a previous request's analytics identifier.
    value.catalog.search.queryId = "uncacheable-bootstrap-query-id";
    return Response.json(value);
  };
  const bootstrapMiss = await cache.cachedPublicApi(
    bootstrapLogical,
    bootstrapBackend,
    env,
    ctx,
    bootstrapHandler,
  );
  assert.equal(bootstrapMiss.headers.get("x-cove-backend-cache"), "MISS");
  const firstBootstrap = await bootstrapMiss.json();
  assert.ok(firstBootstrap.catalog.results.length);
  await Promise.all(pending.splice(0));
  const callsAfterBootstrapMiss = handlerCalls;
  const bootstrapHit = await cache.cachedPublicApi(
    bootstrapLogical,
    bootstrapBackend,
    env,
    ctx,
    bootstrapHandler,
  );
  assert.equal(bootstrapHit.headers.get("x-cove-backend-cache"), "HIT");
  assert.equal(handlerCalls, callsAfterBootstrapMiss);
  const cachedBootstrap = await bootstrapHit.json();
  assert.equal(firstBootstrap.catalog.search.queryId, "uncacheable-bootstrap-query-id");
  assert.notEqual(cachedBootstrap.catalog.search.queryId, firstBootstrap.catalog.search.queryId);
  const firstBootstrapProduct = cachedBootstrap.catalog.results[0].productId;
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?")
    .bind(firstBootstrapProduct)
    .run();
  const changedBootstrap = await cache.cachedPublicApi(
    bootstrapLogical,
    bootstrapBackend,
    env,
    ctx,
    bootstrapHandler,
  );
  assert.equal(changedBootstrap.headers.get("x-cove-backend-cache"), "MISS");
  assert.equal(
    (await changedBootstrap.json()).catalog.results.some(
      (book) => book.productId === firstBootstrapProduct,
    ),
    false,
  );
  await Promise.all(pending.splice(0));
  await env.DB.prepare("UPDATE catalog_search_documents SET suppressed=0 WHERE product_id=?")
    .bind(firstBootstrapProduct)
    .run();
  assert.equal(
    cache.publicCacheEligible(
      new Request(bootstrapLogical, { headers: { cookie: "session=private" } }),
    ),
    false,
  );
  assert.notEqual(
    key(bootstrapLogical.url, { "x-cove-client-country": "US" }),
    key(bootstrapLogical.url, { "x-cove-client-country": "CA" }),
  );

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

  const latestStatus = request("/service-status?fixture=129");
  const latestHit = await cache.cachedPublicApi(
    latestStatus,
    new Request("https://backend.example.workers.dev/api/fore/service-status?fixture=129"),
    env,
    ctx,
    async () => {
      throw new Error("a full cache must still admit new URLs");
    },
  );
  assert.equal(latestHit.headers.get("x-cove-backend-cache"), "HIT");

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
  // Strict two-download ticks must rotate fairly across three enabled backlogged sources.
  await env.DB.prepare(
    "UPDATE gutenberg_sources SET enabled=1 WHERE id IN ('pg_us','pg_ca','pg_au')",
  ).run();
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
  const downloadTick = await api.runCatalogAssetMaintenance(env, 2);
  assert.equal(downloadTick.attempted, 2);
  const followingTick = await api.runCatalogAssetMaintenance(env, 2);
  assert.ok(followingTick.attempted <= 2);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM gutenberg_source_states WHERE source_id IN ('pg_us','pg_ca','pg_au') AND epub_last_attempt_at IS NOT NULL",
      ).first()
    ).n,
    3,
  );
  // Regional drains and successive metadata pages share one asset allowance.
  const resetAssets = async () => {
    await env.DB.prepare("UPDATE gutenberg_source_cache SET epub_status='completed'").run();
    await env.DB.prepare(
      "UPDATE gutenberg_source_cache SET source_id='pg_us',epub_status='pending',epub_next_attempt_at='',ingest_status='accepted' WHERE id IN ('900001','900002','900003','900004','900005')",
    ).run();
  };
  await resetAssets();
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=1 WHERE id='pg_ca'").run();
  await env.DB.prepare(
    "UPDATE gutenberg_source_states SET next_run_at='',lease_until=NULL,etag='test' WHERE source_id='pg_ca'",
  ).run();
  let assetsAttempted = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("gutenberg.ca")) return new Response(null, { status: 304 });
    assetsAttempted++;
    return new Response("missing", { status: 404 });
  };
  const regionalTick = await api.runCatalogIngestion(env, 2);
  assert.equal(regionalTick.regional.failed, true, "a source without its private owner must fail closed");
  assert.match(regionalTick.regional.error, /Regional ingestion requires a private owner/);
  assert.equal(regionalTick.epubs.attempted, 2, "unowned regional work cannot consume the US asset budget");
  assert.equal(assetsAttempted, 2, "the owner-disabled tick still has one shared download budget");
  await env.DB.prepare("UPDATE gutenberg_sources SET enabled=0 WHERE id<>'pg_us'").run();
  await resetAssets();
  assetsAttempted = 0;
  assert.equal((await api.runCatalogIngestion(env, 0)).epubs.attempted, 0);
  assert.equal(assetsAttempted, 0, "an exhausted allowance must not force one more download");
  await env.DB.prepare(
    "UPDATE catalog_state SET status='idle',next_url=NULL,last_success_at=NULL,next_run_at='',lease_token=NULL,lease_until=NULL WHERE id=1",
  ).run();
  let metadataPages = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("gutendex.com")) {
      metadataPages++;
      return Response.json({
        results: [],
        next: `https://gutendex.com/books/?page=${metadataPages + 1}`,
        count: 0,
      });
    }
    assert.equal(metadataPages, 3, "all metadata pages must finish before EPUB transfers begin");
    assetsAttempted++;
    return new Response("missing", { status: 404 });
  };
  const token = "local-test-only-backend-token-0001";
  const batchResponse = await worker.fetch(
    new Request("https://backend.test/__cove/ingestion/catalog", {
      method: "POST",
      headers: { "x-cove-backend-token": token, "content-type": "application/json" },
      body: JSON.stringify({ maxPages: 3, epubLimit: 2, maxMillis: 30000 }),
    }),
    { ...env, FORE_BACKEND_TOKEN: token },
    {},
  );
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json();
  assert.equal(batch.pagesAttempted, 3);
  assert.equal(metadataPages, 3);
  assert.equal(assetsAttempted, 2, "metadata pages must share the whole batch allowance");
  // A failed asset stage must leave successful metadata/cursor state intact.
  const assetFailureEnv = {
    ...env,
    DB: {
      ...env.DB,
      prepare(sql) {
        if (sql.includes("Recovered after an interrupted EPUB download"))
          throw new Error("fixture asset storage outage");
        return env.DB.prepare(sql);
      },
    },
  };
  globalThis.fetch = async () => Response.json({ results: [], next: null, count: 0 });
  const committed = await api.runCatalogIngestion(assetFailureEnv, 2, { includeRegional: false });
  assert.equal(committed.failed, undefined);
  assert.equal(committed.complete, true);
  assert.match(committed.epubs.error, /fixture asset storage outage/);
  const committedState = await env.DB.prepare(
    "SELECT status,last_error,next_url FROM catalog_state WHERE id=1",
  ).first();
  assert.equal(committedState.status, "idle");
  assert.equal(committedState.last_error, "");
  assert.equal(committedState.next_url, null);

  // A short transient outage resumes from the same durable cursor on the next tick.
  await env.DB.prepare(
    "UPDATE catalog_state SET next_url='https://gutendex.com/books/?page=42',next_run_at='',attempts=0 WHERE id=1",
  ).run();
  globalThis.fetch = async () => new Response("not available", { status: 404 });
  const retryStarted = Date.now();
  const failedPage = await api.runCatalogIngestion(updaterEnv, 0, { includeRegional: false });
  assert.equal(failedPage.failed, true);
  assert.ok(Date.parse(failedPage.retryAt) - retryStarted >= 60000);
  assert.ok(Date.parse(failedPage.retryAt) - retryStarted < 90000);
  assert.equal(
    (await api.runCatalogIngestion(updaterEnv, 0, { includeRegional: false })).skipped,
    "backoff",
  );
  await env.DB.prepare("UPDATE catalog_state SET next_run_at='' WHERE id=1").run();
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://gutendex.com/books/?page=42");
    return Response.json({ results: [], next: null, count: 0 });
  };
  assert.equal((await api.runCatalogIngestion(updaterEnv, 0, { includeRegional: false })).page, 42);
  const recovered = await env.DB.prepare(
    "SELECT status,last_error,attempts,lease_token FROM catalog_state WHERE id=1",
  ).first();
  assert.equal(recovered.status, "idle");
  assert.equal(recovered.last_error, "");
  assert.equal(recovered.attempts, 0);
  assert.equal(recovered.lease_token, null);
  assert.equal((await env.DB.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  console.log(
    "PASS: repeated filters, identifier suggestions, typo pagination, read-only browsing, D1/edge cache recovery and isolation, fresh cache-hit impressions, outbox races, exclusive updater claims and deadline handling.",
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
  fs.rmSync(scratch, { recursive: true, force: true });
}
