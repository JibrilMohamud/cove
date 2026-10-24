import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

// Exercise the extracted production helper, not a rewritten test-only planner.
const source = fs.readFileSync("src/features/fore/discovery-intelligence.server.ts", "utf8");
const begin = source.indexOf("async function rightsExactLiteraryFeatureCandidates(");
const end = source.indexOf("export async function retrieveLiteraryCandidates(", begin);
assert.ok(begin >= 0 && end > begin, "Production feature selector not found");
const isolated = source
  .slice(begin, end)
  .replace(
    "async function rightsExactLiteraryFeatureCandidates(",
    "export async function rightsExactLiteraryFeatureCandidates(",
  );
const compiled = await transform(isolated, { loader: "ts", format: "esm" });
const { rightsExactLiteraryFeatureCandidates: select } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,storefront_status TEXT);
    CREATE TABLE recommendation_book_features(
      product_id TEXT,dimension TEXT,feature TEXT,confidence REAL,
      PRIMARY KEY(product_id,dimension,feature)
    );
    CREATE INDEX idx_rec_literary_lookup
      ON recommendation_book_features(dimension,feature,confidence DESC,product_id);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,sales_channel TEXT,status TEXT,decision TEXT);
    CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT);
    CREATE INDEX idx_test_territory ON rights_grant_territories(territory_code,grant_id);
    CREATE INDEX idx_test_grants ON rights_grants(edition_id,sales_channel,status);
    CREATE VIEW retail_product_availability_rows AS
      SELECT p.id product_id,t.territory_code FROM products p
      JOIN rights_grants g ON g.edition_id=p.edition_id
      JOIN rights_grant_territories t ON t.grant_id=g.id
      WHERE g.status='active' AND g.sales_channel='retail' AND g.decision='allow'
        AND NOT EXISTS(
          SELECT 1 FROM rights_grants deny
          JOIN rights_grant_territories dt ON dt.grant_id=deny.id
          WHERE deny.edition_id=p.edition_id AND deny.status='active'
            AND deny.decision='deny' AND dt.territory_code=t.territory_code
        );
  `);
  const product = db.prepare("INSERT INTO products VALUES (?,?,'active')");
  const feat = db.prepare("INSERT INTO recommendation_book_features VALUES (?,?,?,?)");
  const grant = db.prepare("INSERT INTO rights_grants VALUES (?,?,'retail',?,'allow')");
  const region = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
  for (let n = 1; n <= 1500; n++) {
    const id = "book-" + String(n).padStart(4, "0");
    product.run(id, id);
    feat.run(id, "literaryStyle", "epistolary", (1501 - n) / 1501);
    if (n % 2 === 0) feat.run(id, "literaryStyle", "essays", (1501 - n) / 1501 + 0.0001);
    grant.run("grant-" + id, id, "active");
    region.run("grant-" + id, "US");
    if (n >= 1420) region.run("grant-" + id, "CA");
  }
  const features = ["epistolary", "essays"];
  const reference = db.prepare(`
    SELECT f.product_id,MAX(f.confidence) confidence
    FROM recommendation_book_features f JOIN products p ON p.id=f.product_id
    WHERE f.dimension=? AND f.feature IN (?,?) AND p.storefront_status='active'
      AND EXISTS(
        SELECT 1 FROM retail_product_availability_rows a
        WHERE a.product_id=f.product_id AND a.territory_code=upper(?)
      )
    GROUP BY f.product_id ORDER BY confidence DESC,f.product_id LIMIT 40
  `);
  function adapter(log) {
    return {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async first() {
                log.push(sql);
                return db.prepare(sql).get(...params) ?? null;
              },
              async all() {
                log.push(sql);
                return { results: db.prepare(sql).all(...params) };
              },
            };
          },
        };
      },
    };
  }
  async function check(country, calls, expectedKind) {
    const log = [];
    const got = await select(adapter(log), "literaryStyle", features, country);
    const expected = reference.all("literaryStyle", ...features, country).map((r) => r.product_id);
    assert.deepEqual(got, expected, "Live rights ranking must be identical in " + country);
    assert.equal(log.length, calls, "Wrong number of plans used for " + country);
    assert.match(log[1], expectedKind, "Wrong strategy for " + country);
  }

  await check("US", 2, /WITH ranked AS MATERIALIZED/);
  await check("CA", 2, /WITH territory_seed AS MATERIALIZED/);
  await check("GB", 2, /WITH territory_seed AS MATERIALIZED/);

  // Force a hard rights-withdrawal case: the top 170 feature-ranked US
  // candidates are now revoked, so returning only the 120-item shortlist
  // would silently lose all authorized books. It MUST run the exact fallback.
  db.prepare("UPDATE rights_grants SET status='revoked' WHERE edition_id<=?").run("book-0170");
  await check("US", 3, /WITH ranked AS MATERIALIZED/);
  await check("CA", 2, /WITH territory_seed AS MATERIALIZED/);

  // Deny precedence may change mid-session; an active allow cannot override
  // a live deny and the algorithm must never cache earlier authorizations.
  db.prepare("INSERT INTO rights_grants VALUES (? ,? ,'retail','active','deny')").run(
    "deny-book-0190",
    "book-0190",
  );
  region.run("deny-book-0190", "US");
  await check("US", 3, /WITH ranked AS MATERIALIZED/);

  assert.deepEqual(await select(adapter([]), "literaryStyle", [], "US"), []);
  assert.match(isolated, /idx_rec_literary_lookup/);
  assert.match(isolated, /retail_product_availability_rows/);
  assert.match(isolated, /shortlist\.results\.length === 40/);
  console.log(
    "Literary feature rights: dense shortlist, sparse US/CA/GB, duplicate features, denial and fallback PASS",
  );
} finally {
  db.close();
}
