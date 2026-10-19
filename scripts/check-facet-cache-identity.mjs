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
for (const sort of ["popular", "bestselling", "added", "title", "rating"]) {
  assert.equal(
    key({ ...filters, sort, page: 9, limit: 72 }),
    key(),
    "Facet counts cannot vary with ranking or pagination",
  );
}
const populations = ["coming_soon", "released", "published"];
assert.equal(
  new Set([key(), ...populations.map((sort) => key({ ...filters, sort }))]).size,
  4,
  "Eligibility-changing sorts need distinct facet populations",
);
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
assert.match(src, /retail_product_availability_rows/);
assert.match(
  src,
  /populationCacheVersion: 2/,
  "Invalidate full-page cached totals/facets from old scope",
);
console.log(
  "Facets: sorting/pagination reuse, country/currency/filter isolation, counts-only caching PASS",
);
