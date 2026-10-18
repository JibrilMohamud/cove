import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

// Test production SQL/branching, not a rewritten test-only implementation.
const file = fs.readFileSync("src/features/fore/discovery-intelligence.server.ts", "utf8");
const start = file.indexOf("async function rightsExactTaxonomyCandidates(");
const end = file.indexOf("export async function retrieveLiteraryCandidates(", start);
assert.ok(start >= 0 && end > start, "Missing rights-preserving genre selector");
const isolated = file.slice(start, end).replace(
  "async function rightsExactTaxonomyCandidates(",
  "export async function rightsExactTaxonomyCandidates(",
);
const compiled = await transform(isolated, { loader: "ts", format: "esm" });
const { rightsExactTaxonomyCandidates } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);

const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE products (id TEXT PRIMARY KEY,edition_id TEXT,storefront_status TEXT);
CREATE INDEX idx_test_edition ON products(edition_id);
CREATE TABLE edition_taxonomy_nodes (edition_id TEXT,taxonomy_node_id TEXT,confidence REAL);
CREATE INDEX idx_test_taxonomy ON edition_taxonomy_nodes(taxonomy_node_id,edition_id);
CREATE TABLE rights_grants (id TEXT PRIMARY KEY,edition_id TEXT,sales_channel TEXT,status TEXT);
CREATE INDEX idx_test_grant ON rights_grants(edition_id,sales_channel,status);
CREATE TABLE rights_grant_territories (grant_id TEXT,territory_code TEXT);
CREATE INDEX idx_test_territory ON rights_grant_territories(territory_code,grant_id);
CREATE VIEW retail_product_availability_rows AS
 SELECT p.id product_id,rgt.territory_code FROM products p
 JOIN rights_grants rg ON rg.edition_id=p.edition_id
 JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id
 WHERE rg.status='active' AND rg.sales_channel='retail';
CREATE VIEW retail_product_availability AS
 SELECT DISTINCT product_id,territory_code FROM retail_product_availability_rows;
`);
const p = db.prepare("INSERT INTO products VALUES (?,?,'active')");
const tax = db.prepare("INSERT INTO edition_taxonomy_nodes VALUES (?,'genre-1',1)");
const grant = db.prepare("INSERT INTO rights_grants VALUES (?,?,'retail',?)");
const region = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
for (let n = 1; n <= 1160; n++) {
  const id = "book-" + String(n).padStart(4, "0");
  p.run(id, id);
  tax.run(id);
  grant.run("grant-" + id, id, n <= 3 ? "revoked" : "active");
  region.run("grant-" + id, "US");
  if (n >= 1120) region.run("grant-" + id, "CA");
}
const reference = db.prepare(`
 SELECT DISTINCT p.id FROM edition_taxonomy_nodes e
 JOIN products p ON p.edition_id=e.edition_id
 WHERE e.taxonomy_node_id IN (?) AND e.confidence>=0.25
 AND p.storefront_status='active'
 AND EXISTS(SELECT 1 FROM retail_product_availability a
 WHERE a.product_id=p.id AND a.territory_code=upper(?))
 ORDER BY p.id LIMIT 60`);
function adapter(log) {
  return {
    prepare(statement) {
      return {
        bind(...params) {
          return {
            async first() {
              log.push("first");
              return db.prepare(statement).get(...params);
            },
            async all() {
              log.push("all");
              return { results: db.prepare(statement).all(...params) };
            },
          };
        },
      };
    },
  };
}
async function checkMarket(market, expectedCalls) {
  const calls = [];
  const actual = await rightsExactTaxonomyCandidates(adapter(calls), ["genre-1"], market);
  const expected = reference.all("genre-1", market).map((r) => r.id);
  assert.deepEqual(actual, expected, `Exact ordered rights differ for ${market}`);
  assert.equal(calls.length, expectedCalls, `Unexpected query plan for ${market}`);
}
await checkMarket("US", 2);
await checkMarket("CA", 2);
await checkMarket("GB", 2);
// A large market with the first 250 grants revoked must not silently truncate
// to zero candidates. It must retry the complete live rights projection.
db.prepare("UPDATE rights_grants SET status='revoked' WHERE edition_id<=?").run("book-0250");
await checkMarket("US", 3);
assert.deepEqual(await rightsExactTaxonomyCandidates(adapter([]), [], "US"), []);
assert.match(isolated, /retail_product_availability_rows/);
assert.match(isolated, /fast\.results\.length === 60/);
console.log("Literary genre rights: exact US/CA/GB order, revocation, fallback and empty inputs PASS");
