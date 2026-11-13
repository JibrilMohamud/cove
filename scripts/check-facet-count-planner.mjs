import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const start = source.lastIndexOf("function facetScanCandidateParts(");
assert.ok(start > 0, "Exact unsorted facet-only planner helper must exist");
const helper = source.slice(start);
const mock = String.raw`
function candidateParts(input) { return input.part; }
`;
const { code } = await transform(mock + helper + "\nexport { facetScanCandidateParts };", {
  loader: "ts",
  format: "esm",
});
const { facetScanCandidateParts: plan } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const forced = "catalog_search_documents d INDEXED BY idx_search_popular_stable CROSS JOIN";
const cross = "catalog_search_documents d CROSS JOIN";
const input = {
  part: {
    prefix: "",
    from: forced + " products p ON p.id=d.product_id",
    where: [
      "d.currency=?",
      "d.availability='available'",
      "d.suppressed=0",
      "EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code=?)",
    ],
    binds: ["USD", "US"],
    order: "d.fore_bestseller_score DESC",
    limit: 25,
    hasFts: false,
  },
};
const selected = plan(input, "");
assert.equal(selected.from, cross + " products p ON p.id=d.product_id");
assert.strictEqual(selected.where, input.part.where, "Never change any rights predicates");
assert.strictEqual(selected.binds, input.part.binds, "Never alter country/currency bindings");
assert.equal(selected.order, input.part.order, "Ranking for actual book page remains independent");
assert.equal(input.part.from, forced + " products p ON p.id=d.product_id");

for (const from of [
  "matched m JOIN catalog_search_documents d ON d.product_id=m.product_id",
  "catalog_search_documents d JOIN products p ON p.id=d.product_id",
  "catalog_search_documents d INDEXED BY idx_search_added_effective_stable CROSS JOIN products p",
]) {
  assert.equal(plan({ part: { ...input.part, from } }, "").from, from);
}

// The only two call sites are the unsorted disjunctive facet candidate and
// the shared facet-population CTE. No product-ID ranking path is changed.
const body = source.slice(source.indexOf("function d1FacetCandidate("), source.indexOf("function meiliBase("));
assert.match(
  body,
  /const part = facetScanCandidateParts\(withoutFacet\(input, facet\), expression\)/,
);
assert.match(body, /const base = facetScanCandidateParts\(input, expression\)/);
assert.match(body, /const shared = commonCandidates/);
assert.match(body, /candidate AS MATERIALIZED/);
assert.match(source, /const plan = await rankedCandidatePlan\(replicaRanking \? presentationDb : env.DB, input, part\)/);
assert.match(source, /const recheck = rightsScopedCachedPageQuery\(part, cached.ids\)/);
assert.match(source, /recheckPrimary: async \(ids\)/);

// The production D1 EXPLAIN checks were independently confirmed before this
// change. Reproduce their index distinction with a standalone SQLite fixture,
// and ensure territory withdrawal is never hidden by this plan modification.
const python = String.raw`
import sqlite3
con = sqlite3.connect(":memory:")
c = con.cursor()
c.executescript("""
CREATE TABLE catalog_search_documents(product_id TEXT, currency TEXT, price_minor INT, availability TEXT, suppressed INT, fore_bestseller_score INT, external_book_id TEXT);
CREATE INDEX idx_search_popular_stable ON catalog_search_documents(fore_bestseller_score DESC, external_book_id, product_id);
CREATE INDEX idx_search_price ON catalog_search_documents(currency,price_minor);
CREATE TABLE products(id TEXT PRIMARY KEY, edition_id TEXT, storefront_status TEXT, source_name TEXT);
CREATE TABLE editions(id TEXT PRIMARY KEY, release_status TEXT);
CREATE TABLE retail_product_availability_rows(product_id TEXT, territory_code TEXT);
CREATE INDEX rpa_idx ON retail_product_availability_rows(product_id,territory_code);
""")
for i in range(400):
    v = str(i)
    country = "US" if i % 3 else "GB"
    currency = "USD" if i % 2 else "EUR"
    status = "paused" if i % 13 == 0 else "active"
    c.execute("INSERT INTO catalog_search_documents VALUES(?,?,?,?,?,?,?)", (v,currency,100,'available',0,400-i,v))
    c.execute("INSERT INTO products VALUES(?,?,?,?)", (v,v,status,'gutenberg'))
    c.execute("INSERT INTO editions VALUES(?,?)", (v,'available'))
    c.execute("INSERT INTO retail_product_availability_rows VALUES(?,?)", (v,country))
con.commit()
query = """SELECT d.product_id FROM catalog_search_documents d {index}
CROSS JOIN products p ON p.id=d.product_id
CROSS JOIN editions e ON e.id=p.edition_id
WHERE p.storefront_status='active' AND p.source_name<>'upload'
AND d.suppressed=0 AND e.release_status IN ('available','preorder')
AND d.availability='available'
AND EXISTS(SELECT 1 FROM retail_product_availability_rows rpa
    WHERE rpa.product_id=p.id AND rpa.territory_code=?)
AND d.currency=?"""
forced = query.format(index="INDEXED BY idx_search_popular_stable")
optimized = query.format(index="")
for territory in ["US","GB","FR"]:
  for currency in ["USD","EUR","CAD"]:
    params=(territory,currency)
    actual = sorted(v[0] for v in c.execute(optimized,params))
    original = sorted(v[0] for v in c.execute(forced,params))
    assert actual==original, f"Unauthorized or missing book after {territory}/{currency} plan change"
before = [v[3] for v in c.execute("EXPLAIN QUERY PLAN "+forced,("US","USD"))]
after = [v[3] for v in c.execute("EXPLAIN QUERY PLAN "+optimized,("US","USD"))]
assert any("SCAN d USING INDEX idx_search_popular_stable" in d for d in before)
assert any("SEARCH d USING INDEX idx_search_price" in d for d in after)
c.execute("DELETE FROM retail_product_availability_rows WHERE product_id='1'")
con.commit()
for territory in ["US","GB"]:
  params=(territory,"USD")
  assert "1" not in [v[0] for v in c.execute(optimized,params)]
  assert sorted(c.execute(optimized,params))==sorted(c.execute(forced,params))
print("Production-compatible SQLite facet planner fixture and withdrawal checks: PASS")
`;
const test = spawnSync("python3", ["-c", python], { encoding: "utf8", timeout: 10_000 });
assert.equal(test.status, 0, (test.stderr || "").slice(0, 1500));
assert.match(test.stdout, /withdrawal checks: PASS/);
console.log("Facet-only planner hint removal retains current primary-D1 rights and ranking behavior: PASS");
