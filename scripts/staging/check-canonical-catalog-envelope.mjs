import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-canonical-envelope-"));
try {
  await build({
    entryPoints: ["src/features/fore/catalog-envelope.server.ts"],
    outfile: path.join(tmp, "contract.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { canonicalCatalogEnvelope } = await import(path.join(tmp, "contract.mjs"));

  const book = { productId: "perf-synth-0", title: "Public book" };
  const facets = {
    categories: [{ value: "Fiction", count: 25 }],
    languages: [{ value: "en", count: 25 }],
    formats: [],
    publishers: [],
    series: [],
    availability: [],
    price: { currency: "USD", min: 0, max: 999 },
  };
  const search = {
    books: [book],
    count: 25,
    facets,
    facetsPending: true,
    countPending: true,
    queryId: "query_01",
    backend: "d1-fts5",
    processingTimeMs: 16,
    correctedQuery: undefined,
    limit: 24,
  };
  const ingestion = { state: "not-blocking", sources: [] };
  const url = new URL("https://covereads.com/api/fore/catalog?sort=popular&topic=fiction&page=1");
  const result = canonicalCatalogEnvelope(url, 1, search, ingestion);

  assert.deepEqual(Object.keys(result), [
    "results",
    "count",
    "next",
    "cached",
    "facets",
    "facetsPending",
    "countPending",
    "search",
    "ingestion",
  ]);
  assert.deepEqual(Object.keys(result.search), [
    "queryId",
    "backend",
    "processingTimeMs",
    "correctedQuery",
    "pageSize",
  ]);
  assert.equal(
    result.next,
    "/api/fore/catalog?sort=popular&topic=fiction&page=2",
    "Page 2 retains canonical filters in the original URL",
  );
  assert.strictEqual(result.results, search.books);
  assert.strictEqual(result.facets, facets);
  assert.strictEqual(result.ingestion, ingestion);
  assert.equal(result.count, 25, "Pending first page remains a proven lower bound");
  assert.equal(result.countPending, true);
  assert.equal(result.facetsPending, true);
  assert.equal(result.search.backend, "d1-fts5");
  assert.equal(result.search.queryId, "query_01");
  assert.equal(result.search.correctedQuery, null);
  assert.equal(result.search.pageSize, 24);
  assert.equal(result.cached, true);

  const last = canonicalCatalogEnvelope(url, 1, { ...search, count: 24 }, null);
  assert.equal(last.next, null, "No synthetic second page when the count proves none");
  assert.equal(last.countPending, true, "Pending flag is never silently converted to exact");
  const page2 = canonicalCatalogEnvelope(url, 2, { ...search, count: 48 }, ingestion);
  assert.equal(page2.next, null);
  const empty = canonicalCatalogEnvelope(url, 1, {
    ...search,
    books: [],
    count: 0,
    facetsPending: undefined,
    countPending: undefined,
    correctedQuery: "corrected",
  }, null);
  assert.equal(empty.next, null);
  assert.equal(empty.countPending, false);
  assert.equal(empty.facetsPending, false);
  assert.equal(empty.search.correctedQuery, "corrected");

  for (const invalid of [
    () => canonicalCatalogEnvelope(url, 0, search, ingestion),
    () => canonicalCatalogEnvelope(url, 1, { ...search, count: -1 }, ingestion),
    () => canonicalCatalogEnvelope(url, 1, { ...search, count: 1.5 }, ingestion),
    () => canonicalCatalogEnvelope(url, 1, { ...search, limit: 0 }, ingestion),
  ]) {
    assert.throws(invalid, /Invalid canonical catalog/);
  }
  console.log("Canonical nine-field catalog envelope: exact shape, pending-state and cursor invariants PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
