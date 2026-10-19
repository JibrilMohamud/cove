import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const src = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const start = src.indexOf("function facetCacheIdentity(");
const end = src.indexOf("async function d1Facets(", start);
assert.ok(start >= 0 && end > start, "Missing production count-only facet cache identity");
const code = src
  .slice(start, end)
  .replace("function facetCacheIdentity(", "export function facetCacheIdentity(");
const { code: compiled } = await transform(code, { loader: "ts", format: "esm" });
const { facetCacheIdentity } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
const filters = {
  territory: "US",
  currency: "USD",
  query: "",
  taxonomy: [],
  categories: [],
  languages: ["en"],
  formats: [],
  sort: "popular",
  page: 1,
  limit: 24,
};
function key(input = filters, expression = "") {
  return JSON.stringify(facetCacheIdentity(input, expression));
}
for (const sort of ["popular", "bestselling", "newest", "title", "rating"]) {
  assert.equal(
    key({ ...filters, sort, page: 9, limit: 72 }),
    key(),
    "Facet counts cannot vary with ranking or pagination",
  );
}
for (const change of [
  { territory: "CA" },
  { currency: "CAD" },
  { categories: ["Fantasy"] },
  { languages: ["fr"] },
  { query: "ocean" },
]) {
  assert.notEqual(key({ ...filters, ...change }), key(), "Do not mix filter/country variants");
}
assert.notEqual(key(filters, "space"), key(filters, "sail"), "Search FTS scope is part of key");
const facetSource = src.slice(end, src.indexOf("function levenshtein(", end));
assert.match(facetSource, /search-facets:v2:/);
assert.match(facetSource, /facetCacheIdentity\(input, expression\)/);
assert.match(facetSource, /writeCatalogCache/);
assert.doesNotMatch(facetSource, /canonicalBooksByProductIds/);
// The D1 replica is permitted only for numerical facet aggregates. The
// rights-authoritative product results and cache reads/writes remain primary.
const readerStart = src.indexOf("function presentationFacetReadDb(");
assert.ok(readerStart > 0, "Presentation-only D1 reader must be explicit");
const readerCode = src
  .slice(readerStart, end)
  .replace("function presentationFacetReadDb(", "export function presentationFacetReadDb(");
const { code: readerCompiled } = await transform(readerCode, { loader: "ts", format: "esm" });
const { presentationFacetReadDb } = await import(
  "data:text/javascript;base64," + Buffer.from(readerCompiled).toString("base64")
);
const primary = { name: "primary" };
const replica = { name: "replica" };
const constraints = [];
primary.withSession = (consistency) => {
  constraints.push(consistency);
  return replica;
};
assert.equal(presentationFacetReadDb(primary), replica);
assert.deepEqual(constraints, ["first-unconstrained"]);
assert.equal(presentationFacetReadDb({ name: "no-replication" }).name, "no-replication");
assert.throws(
  () =>
    presentationFacetReadDb({
      withSession: () => {
        throw Error("session failed");
      },
    }),
  /session failed/,
  "Do not silently send a failed replica read to the primary under contention",
);
assert.match(facetSource, /const facetReadDb = presentationFacetReadDb\(db\);/);
const aggregations = facetSource.slice(
  facetSource.indexOf("const shared = commonCandidates"),
  facetSource.indexOf("const values ="),
);
assert.equal(
  (aggregations.match(/facetReadDb\s*\.prepare\(/g) || []).length,
  8,
  "All one-batch and disjunctive facet aggregate queries must use read session",
);
assert.doesNotMatch(aggregations, /\bdb\s*\.prepare\(/);
assert.match(facetSource, /const cached = await db\s*\.prepare\(/);
assert.match(facetSource, /writeCatalogCache\(\s*db,/);
assert.match(src, /canonicalBooksByProductIds\(env\.DB, ids\)/);
assert.match(src, /retail_product_availability_rows/);
console.log(
  "Facets: sorting/pagination reuse, country/currency/filter isolation, counts-only caching PASS",
);
