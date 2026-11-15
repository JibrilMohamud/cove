import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Executable stage-only proof that any future full-search R2 index has the
// same normalized axes as the CURRENT production parseSearchInput contract.
// Do not use this test as a production catalog-count or rights certificate.
const folder = mkdtempSync(path.join(tmpdir(), "cove-catalog-projection-scope-"));
try {
  const outfile = path.join(folder, "scope.mjs");
  await build({
    entryPoints: ["src/features/fore/catalog-presentation-scope.stage.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { catalogPresentationScope } = await import(pathToFileURL(outfile).href);
  const generation = "a".repeat(64);
  const base = {
    query: "",
    taxonomy: [],
    categories: [],
    languages: [],
    formats: [],
    publishers: [],
    series: [],
    contributorIds: [],
    seriesIds: [],
    publisherIds: [],
    imprintIds: [],
    territory: "US",
    currency: "USD",
    availability: "available",
    sort: "popular",
    page: 1,
    limit: 24,
  };
  const key = async (change = {}, generationOverride = generation, userId = null) =>
    (await catalogPresentationScope({ ...base, ...change }, generationOverride, userId)).key;
  const first = await key();
  assert.match(first, /^catalog-projection:v1:[a-f0-9]{64}$/);
  assert.equal(await key({ page: 2 }), first, "Page continuation shares immutable scope");
  assert.equal(await key({ page: 500 }), first);
  assert.notEqual(await key({ limit: 25 }), first, "Page size is cursor-bound");
  assert.notEqual(await key({}, "b".repeat(64)), first, "Generation invalidates stale metadata");

  const variants = {
    query: "robots",
    topic: "Science",
    taxonomy: ["Fiction"],
    categories: ["Adventure"],
    languages: ["fr"],
    formats: ["audiobook"],
    publishers: ["Example Press"],
    series: ["Orbit"],
    contributorIds: ["writer-1"],
    seriesIds: ["series-1"],
    publisherIds: ["publisher-1"],
    imprintIds: ["imprint-1"],
    territory: "CA",
    currency: "CAD",
    minPrice: 100,
    maxPrice: 600,
    subscription: true,
    library: false,
    minRating: 4.5,
    minReviews: 17,
    publishedAfter: "2025-01-01",
    publishedBefore: "2026-01-01",
    preorder: false,
    newRelease: true,
    deals: true,
    availability: "preorder",
    sort: "released",
  };
  for (const [field, value] of Object.entries(variants))
    assert.notEqual(await key({ [field]: value }), first, "Partition missing: " + field);
  assert.equal(
    await key({ categories: ["Adventure", "Fantasy", "Adventure"] }),
    await key({ categories: ["Fantasy", "Adventure"] }),
    "Order and duplicate multi-select values must not fragment equivalent public searches",
  );
  assert.notEqual(
    await key({ subscription: false }),
    await key({ subscription: true }),
    "Explicit false cannot collide with true",
  );
  assert.notEqual(
    await key({ subscription: false }),
    first,
    "Explicit false must remain distinguishable from an unspecified filter",
  );
  assert.notEqual(await key({ query: "query-A" }), await key({ query: "query-B" }));

  await assert.rejects(() => key({}, generation, "sb:user-1"), /Private users/);
  await assert.rejects(() => key({ surpriseFilter: "unreviewed" }), /Unreviewed catalog input/);
  await assert.rejects(() => key({}, "bad"), /Unversioned/);
  await assert.rejects(() => key({ territory: "U.S." }), /territory/);
  await assert.rejects(() => key({ sort: "random" }), /sort/);
  await assert.rejects(() => key({ page: 0 }), /pagination/);
  await assert.rejects(() => key({ limit: 61 }), /pagination/);
  await assert.rejects(() => key({ categories: "Fiction" }), /list/);
  await assert.rejects(() => key({ categories: Array(21).fill("A") }), /list/);
  await assert.rejects(() => key({ maxPrice: Infinity }), /numeric/);
  await assert.rejects(() => key({ publishedAfter: "2025/01/01" }), /date/);
  await assert.rejects(() => key({ query: "x".repeat(161) }), /search terms/);

  console.log(
    "PASS: all canonical catalog query, filters, sort, territory, price, publication, booleans, page-size, generation and personalized-query isolation",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
