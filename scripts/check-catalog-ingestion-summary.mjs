import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const helper = fs.readFileSync("src/features/fore/catalog-ingestion-summary.server.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const { code } = await transform(helper, { loader: "ts", format: "esm" });
const { optionalCatalogIngestionSummary } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const unknown = {
  status: "unknown",
  page: 0,
  lastSuccessAt: null,
  totalCatalogCount: 0,
};
let reads = 0;
const deniedDb = {
  prepare() {
    reads++;
    throw Error("D1_ERROR: database overloaded (7429)");
  },
};
assert.deepEqual(await optionalCatalogIngestionSummary(deniedDb, "production"), unknown);
assert.equal(reads, 0, "Production catalog must never query primary D1 for ingestion metadata");
assert.deepEqual(await optionalCatalogIngestionSummary(deniedDb, "development"), unknown);
assert.equal(reads, 1, "Development metadata outage must not lose already-authorized books");
const healthy = {
  prepare(sql) {
    assert.equal(
      sql,
      "SELECT status,page,last_success_at,total_catalog_count FROM catalog_state WHERE id=1",
    );
    return {
      async first() {
        return {
          status: "running",
          page: 7,
          last_success_at: "2026-11-12T12:00:00Z",
          total_catalog_count: 48000,
        };
      },
    };
  },
};
assert.deepEqual(await optionalCatalogIngestionSummary(healthy, "development"), {
  status: "running",
  page: 7,
  lastSuccessAt: "2026-11-12T12:00:00Z",
  totalCatalogCount: 48000,
});
const start = api.indexOf("async function catalog(");
const end = api.indexOf("\nfunction libraryRow(", start);
assert.ok(start >= 0 && end > start, "Missing production catalog handler");
const handler = api.slice(start, end);
assert.ok(
  handler.indexOf("await searchCatalog(") <
    handler.indexOf("await optionalCatalogIngestionSummary("),
  "Never substitute ingestion metadata for canonical authorization",
);
assert.ok(handler.includes("results: result.books"), "Preserve original rights-checked books");
assert.ok(handler.includes("ingestion,"), "Preserve optional ingestion response contract");
assert.doesNotMatch(handler, /\.prepare\(["']SELECT status,page,last_success_at/);
console.log(
  "PASS: production catalog avoids optional D1, preserves rights-checked books, and fails open ONLY for nonauthoritative ingestion status",
);
