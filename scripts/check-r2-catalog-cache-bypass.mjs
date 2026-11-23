import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-r2-page-cache-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/search.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "search.mjs"),
    logLevel: "silent",
  });
  const { parseSearchInput, searchCatalog, canDeferGuestCatalogFacets } = await import(
    path.join(root, "search.mjs")
  );
  const local = localBindings(root, { seedCatalogFixture: true });
  const input = parseSearchInput(
    new URL("https://cove.test/api/fore/catalog?sort=popular&page=1&currency=USD"),
  );
  let cacheWrites = 0,
    combinedMetadataReads = 0,
    localeBatches = 0;
  let legacyCacheReads = 0,
    primaryRightsReads = 0;
  const db = new Proxy(local.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql) => {
          if (/\b(?:INSERT INTO|DELETE FROM) api_cache\b/.test(sql)) cacheWrites++;
          if (sql.includes("active_market AS MATERIALIZED")) combinedMetadataReads++;
          if (sql.startsWith("SELECT body FROM api_cache WHERE key=?")) legacyCacheReads++;
          if (sql.includes("retail_product_availability_rows")) primaryRightsReads++;
          return target.prepare(sql);
        };
      if (property === "batch")
        return (statements) => {
          if (statements.length === 2) localeBatches++;
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const facets = {
    categories: [],
    languages: [],
    formats: [],
    publishers: [],
    series: [],
    availability: [{ value: "available", count: 100 }],
    price: { currency: "USD", min: 0, max: 0 },
  };
  const r2 = {
    async get() {
      return {
        etag: "ready",
        text: async () =>
          JSON.stringify({ version: 1, kind: "ready", expiresAt: Date.now() + 590_000, facets }),
      };
    },
    async put() {
      assert.fail("A warm facet result must not need a presentation write");
    },
  };
  const env = {
    ...local,
    DB: db,
    FORE_ENVIRONMENT: "production",
    FORE_SEARCH_BACKEND: "d1",
    FORE_ASYNC_CATALOG_FACETS: "1",
    FORE_POPULAR_RIGHTS_SHORTLIST: "1",
    FORE_GUEST_CATALOG_PROGRESSIVE_COUNT: "1",
    COVE_PUBLIC_PRESENTATION_CACHE: r2,
  };
  const result = await searchCatalog(env, input, null, () => {});
  assert.ok(result.books.length > 0, "The real catalog path must still return fixture books");
  assert.equal(
    legacyCacheReads,
    0,
    "The opt-in R2 path cannot query the unused legacy D1 page/facet cache",
  );
  assert.ok(
    primaryRightsReads > 0,
    "Removing a presentation lookup cannot remove current primary rights",
  );

  legacyCacheReads = 0;
  await searchCatalog({ ...env, COVE_PUBLIC_PRESENTATION_CACHE: undefined }, input, null, () => {});
  assert.ok(legacyCacheReads > 0, "The ordinary catalog path must retain its original D1 cache");
  assert.equal(canDeferGuestCatalogFacets(env, input, null), true);
  assert.equal(canDeferGuestCatalogFacets(env, input, "user-1"), false);
  for (const query of [
    "page=2",
    "sort=title",
    "search=reading",
    "format=ebook",
    "subscription=true",
    "library=true",
    "minPrice=0",
  ])
    assert.equal(
      canDeferGuestCatalogFacets(
        env,
        parseSearchInput(new URL("https://cove.test/api/fore/catalog?" + query)),
        null,
      ),
      false,
    );

  // Exercise the real outer backend cache AND API handler, not a replacement
  // that could silently omit rate admission or current-rights selection.
  await build({
    stdin: {
      contents: `
    export { cachedPublicApi } from "./src/features/fore/public-api-cache.server.ts";
    export { handleCoveApi } from "./src/features/fore/api.server.ts";
  `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "outer.mjs"),
    logLevel: "silent",
  });
  const { cachedPublicApi, handleCoveApi } = await import(path.join(root, "outer.mjs"));
  legacyCacheReads = 0;
  cacheWrites = 0;
  combinedMetadataReads = 0;
  localeBatches = 0;
  primaryRightsReads = 0;
  let admissions = 0;
  const admittedEnv = {
    ...env,
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        admissions++;
        return { success: true };
      },
    },
  };
  const request = new Request(
    "https://cove.test/api/fore/catalog?sort=popular&page=1&currency=USD",
    {
      headers: { "x-cove-client-country": "US", "x-cove-client-ip": "192.0.2.6" },
    },
  );
  const work = [];
  const ctx = {
    waitUntil(promise) {
      work.push(promise);
    },
  };
  const response = await cachedPublicApi(request, request, admittedEnv, ctx, (r, bindings) =>
    handleCoveApi(r, bindings, ctx),
  );
  await Promise.all(work);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).results.length);
  assert.equal(response.headers.get("x-cove-backend-cache"), "BYPASS");
  assert.equal(admissions, 1, "Independent storage cannot bypass guest abuse admission");
  assert.equal(
    combinedMetadataReads,
    1,
    "Cookie-free R2 catalog must use one fresh metadata snapshot",
  );
  assert.equal(
    localeBatches,
    0,
    "Cookie-free catalog metadata cannot add a dependent payment/translation round trip",
  );
  assert.ok(primaryRightsReads > 0);
  assert.equal(legacyCacheReads, 0, "The outer cache must not reintroduce a primary D1 lookup");
  assert.equal(cacheWrites, 0, "The outer cache must not reintroduce D1 prune/upsert transactions");
  combinedMetadataReads = 0;
  localeBatches = 0;
  const preferenceRequest = new Request(request, {
    headers: {
      "x-cove-client-country": "US",
      "x-cove-client-ip": "192.0.2.6",
      cookie: "fore-locale=fr-CA",
    },
  });
  const preferenceResponse = await cachedPublicApi(
    preferenceRequest,
    preferenceRequest,
    admittedEnv,
    ctx,
    (r, bindings) => handleCoveApi(r, bindings, ctx),
  );
  await Promise.all(work);
  assert.equal(preferenceResponse.status, 200);
  assert.equal(
    combinedMetadataReads,
    0,
    "Preferences cannot enter the cookie-free metadata shortcut",
  );
  assert.ok(localeBatches > 0, "Preference-aware locale/payment validation must remain active");
  console.log(
    "PASS: actual R2-backed catalog skips legacy D1 page/facet cache reads, preserves primary rights, and leaves ordinary caching intact",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
