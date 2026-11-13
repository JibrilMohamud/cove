import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-public-display-"));
const json = (value) => JSON.parse(JSON.stringify(value));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  const output = path.join(root, "shelf.mjs");
  await build({
    stdin: {
      contents: `export {firstPaintStorefrontShelf as shelf} from './src/features/fore/search.server';
        export * from './src/features/fore/storefront-public-display-cache';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    shelf,
    rememberCompletedPublicDisplay: remember,
    readCompletedPublicDisplay: read,
    hasCompletedPublicDisplay: has,
    PUBLIC_DISPLAY_TTL_MS: ttl,
  } = await import(output);
  const env = localBindings(root, { seedCatalogFixture: true });
  const queries = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scope = {};
  const fetch = async (country = "US", cacheScope = scope) => {
    const metrics = {};
    const before = queries.length;
    const value = await shelf({ ...env, DB: db }, null, country, metrics, cacheScope);
    return { value: json(value), metrics, queries: queries.slice(before) };
  };
  // Distinct request wrappers may reuse completed DATA, never another request's I/O.
  const cold = await fetch();
  assert.ok(cold.value.results.length > 1);
  assert.equal(cold.metrics.publicDisplay, "cold");
  const warm = await fetch();
  assert.equal(warm.metrics.publicDisplay, "hit");
  const normalize = (value) => {
    delete value.search.processingTimeMs;
    return value;
  };
  assert.deepEqual(
    normalize(warm.value),
    normalize(cold.value),
    "Exact warm/cold card DTO and order",
  );
  assert.equal(cold.queries.length, 1);
  assert.equal(warm.queries.length, 1);
  assert.match(cold.queries[0], /contributors_json/);
  assert.doesNotMatch(warm.queries[0], /contributors_json|e\.description|series_memberships/);
  assert.equal(
    cold.queries[0].split("SELECT\n")[0].includes("retail_product_availability_rows"),
    true,
  );
  for (const country of ["US", "CA", "GB", "SA", "JP"]) {
    const expected = await fetch(country, null);
    const actual = await fetch(country);
    assert.deepEqual(
      normalize(actual.value),
      normalize(expected.value),
      country + ": live market parity",
    );
    assert.match(actual.queries[0], /retail_product_availability_rows/);
  }
  const fresh = async () => json(await shelf({ ...env, DB: db }, null, "US"));
  const first = cold.value.results[0];
  const second = cold.value.results[1];
  const mutate = async (sql, ...binds) =>
    env.DB.prepare(sql)
      .bind(...binds)
      .run();
  // A completed display entry must never preserve a price, EPUB availability or DRM flag.
  await mutate(
    "UPDATE offers SET amount_minor=321 WHERE product_id=? AND active=1",
    first.productId,
  );
  await mutate("UPDATE editions SET downloadable=0,drm_status='adobe' WHERE id=?", first.editionId);
  const changed = await fetch();
  assert.equal(changed.metrics.publicDisplay, "hit");
  assert.deepEqual(
    normalize(changed.value),
    normalize(await fresh()),
    "Sensitive fields remain current",
  );
  assert.equal(
    changed.value.results.find((book) => book.productId === first.productId).downloadable,
    false,
  );
  assert.equal(
    changed.value.results.find((book) => book.productId === first.productId).drmStatus,
    "adobe",
  );
  assert.equal(
    changed.value.results.find((book) => book.productId === first.productId).offer.amountMinor,
    321,
  );
  await mutate(
    "UPDATE asset_versions SET source_url=NULL,object_key=NULL WHERE id IN (SELECT current_version_id FROM digital_assets WHERE edition_id=? AND kind='epub')",
    first.editionId,
  );
  const unavailable = await fetch();
  assert.equal(unavailable.metrics.publicDisplay, "hit");
  assert.ok(
    !unavailable.value.results.find((book) => book.productId === first.productId).formats[
      "application/epub+zip"
    ],
  );
  assert.deepEqual(normalize(unavailable.value), normalize(await fresh()));
  // Withdrawal is effective even while every display entry remains hot.
  await mutate(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=? AND decision='allow'",
    first.editionId,
  );
  const revoked = await fetch();
  assert.ok(!revoked.value.results.some((book) => book.productId === first.productId));
  assert.deepEqual(normalize(revoked.value), normalize(await fresh()));
  await mutate("UPDATE products SET storefront_status='withdrawn' WHERE id=?", second.productId);
  const withdrawn = await fetch();
  assert.ok(!withdrawn.value.results.some((book) => book.productId === second.productId));
  assert.deepEqual(normalize(withdrawn.value), normalize(await fresh()));
  // A new eligible book cannot disappear merely because its presentation was not cached.
  const seed = JSON.parse(fs.readFileSync("src/features/fore/catalog-seed.json", "utf8"))
    .results[0];
  env.seedAdditionalLocalCatalogBooks([
    { ...seed, id: 99999991, title: "Freshly approved fixture" },
  ]);
  await mutate(
    "UPDATE catalog_search_documents SET fore_bestseller_score=999999999 WHERE external_book_id='99999991'",
  );
  const added = await fetch();
  assert.equal(added.metrics.publicDisplay, "miss");
  assert.equal(added.queries.length, 2, "Missing display must re-run the complete live selection");
  assert.ok(added.value.results.some((book) => book.sourceExternalId === "99999991"));
  assert.deepEqual(normalize(added.value), normalize(await fresh()));
  assert.equal((await fetch()).metrics.publicDisplay, "hit");
  const current = added.value.results.find((book) => book.sourceExternalId === "99999991");
  await mutate(
    "UPDATE rights_grants SET ends_at='2000-01-01' WHERE edition_id=?",
    current.editionId,
  );
  const expired = await fetch();
  assert.ok(!expired.value.results.some((book) => book.productId === current.productId));
  assert.deepEqual(normalize(expired.value), normalize(await fresh()));
  const otherScope = await fetch("US", {});
  assert.equal(
    otherScope.metrics.publicDisplay,
    "cold",
    "Separate D1 scopes cannot reuse presentation",
  );
  const before = queries.length;
  const productionMetrics = {};
  await shelf({ ...env, DB: db }, null, "US", productionMetrics);
  assert.equal(productionMetrics.publicDisplay, undefined);
  assert.equal(queries.length - before, 1);
  assert.match(queries.at(-1), /contributors_json/, "No optional scope: unchanged full read");
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + ttl + 1;
    assert.equal(
      (await fetch()).metrics.publicDisplay,
      "cold",
      "Expired display triggers original full read",
    );
  } finally {
    Date.now = originalNow;
  }
  await assert.rejects(
    shelf(
      {
        DB: {
          prepare() {
            throw Error("primary unavailable");
          },
        },
      },
      null,
      "US",
      {},
      scope,
    ),
    /primary unavailable/,
  );

  // Storage boundary: immutable copies, protected fields omitted, expiry and strict bounds.
  const now = 1_000_000,
    isolated = {};
  const book = {
    ...first,
    offer: { amountMinor: 123 },
    uploaded: false,
    formats: {
      "image/jpeg": "https://example.test/cover.jpg",
      "application/epub+zip": "/protected",
    },
  };
  remember(isolated, book, now + ttl, now);
  const display = read(isolated, first.productId, first.editionId, now);
  assert.ok(display);
  for (const key of [
    "productId",
    "editionId",
    "workId",
    "sourceName",
    "sourceExternalId",
    "offer",
    "drmStatus",
    "downloadable",
    "readingAvailability",
    "subscriptionEligible",
    "libraryEligible",
  ])
    assert.ok(!(key in display), key + " must not enter presentation cache");
  assert.deepEqual(display.formats, { "image/jpeg": "https://example.test/cover.jpg" });
  display.title = "poisoned";
  display.authors.push({ name: "poisoned" });
  assert.equal(read(isolated, first.productId, first.editionId, now).title, first.title);
  assert.notDeepEqual(
    read(isolated, first.productId, first.editionId, now).authors,
    display.authors,
  );
  assert.equal(read(isolated, first.productId, "other-edition", now), null);
  assert.equal(read({}, first.productId, first.editionId, now), null);
  assert.equal(read(isolated, first.productId, first.editionId, now + ttl), null);
  assert.equal(has(isolated, now + ttl), false);
  for (const bad of [
    { uploaded: true },
    { sourceName: "upload" },
    { title: "x".repeat(70 * 1024) },
  ]) {
    const badScope = {};
    remember(badScope, { ...book, ...bad }, now + ttl, now);
    assert.equal(has(badScope, now), false);
  }
  const bounded = {};
  for (let i = 0; i < 140; i++) remember(bounded, { ...book, productId: "p" + i }, now + ttl, now);
  assert.equal(read(bounded, "p0", first.editionId, now), null);
  assert.ok(read(bounded, "p139", first.editionId, now));
  const byteBounded = {};
  for (let i = 0; i < 40; i++)
    remember(
      byteBounded,
      { ...book, productId: "p" + i, title: "x".repeat(40 * 1024) },
      now + ttl,
      now,
    );
  assert.equal(read(byteBounded, "p0", first.editionId, now), null);
  assert.ok(read(byteBounded, "p39", first.editionId, now));
  console.log(
    "Public display cache PASS: exact DTO/order, current primary rights/prices/DRM, new book fallback, immutable data, expiry and bounded memory",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
