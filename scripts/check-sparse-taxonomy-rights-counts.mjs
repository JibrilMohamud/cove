import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

const production = fs.readFileSync("src/features/fore/taxonomy-count-query.ts", "utf8");
const caller = fs.readFileSync("src/features/fore/taxonomy.server.ts", "utf8");
assert.match(caller, /presentationTaxonomyCounts\(db, territory, language/);
assert.match(caller, /taxonomyPresentationReadDb\(db\)/);
assert.match(caller, /\.prepare\(taxonomySparseRightsProbe\)/);
assert.match(caller, /taxonomyCountPlan\(territory, language,/);
assert.match(production, /retail_product_availability rpa/);
assert.match(production, /retail_product_availability_rows rpa/);
assert.match(production, /g\.sales_channel='retail' AND g\.status='active'/);
assert.match(production, /COUNT\(\*\) product_count/);

const { code } = await transform(production, { loader: "ts", format: "esm" });
const { taxonomyCountPlan, taxonomySparseRightsProbe } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE products(
      id TEXT PRIMARY KEY, edition_id TEXT NOT NULL,
      storefront_status TEXT NOT NULL, source_name TEXT NOT NULL
    );
    CREATE INDEX products_edition ON products(edition_id);
    CREATE TABLE editions(id TEXT PRIMARY KEY,release_status TEXT NOT NULL);
    CREATE TABLE edition_languages(edition_id TEXT,language_code TEXT);
    CREATE TABLE edition_taxonomy_nodes(
      edition_id TEXT NOT NULL,taxonomy_node_id TEXT NOT NULL,
      PRIMARY KEY(edition_id,taxonomy_node_id)
    );
    CREATE INDEX taxonomy_edition ON edition_taxonomy_nodes(taxonomy_node_id,edition_id);
    CREATE TABLE rights_grants(
      id TEXT PRIMARY KEY,edition_id TEXT NOT NULL,
      sales_channel TEXT NOT NULL,status TEXT NOT NULL,decision TEXT NOT NULL
    );
    CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT,
      PRIMARY KEY(grant_id,territory_code));
    CREATE INDEX idx_rights_grant_territories_lookup
      ON rights_grant_territories(territory_code,grant_id);
    CREATE VIEW retail_product_availability_rows AS
      SELECT DISTINCT p.id product_id,rgt.territory_code
      FROM products p
      JOIN rights_grants g ON g.edition_id=p.edition_id
        AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'
      JOIN rights_grant_territories rgt ON rgt.grant_id=g.id
      WHERE NOT EXISTS (
        SELECT 1 FROM rights_grants deny
        JOIN rights_grant_territories dt ON dt.grant_id=deny.id
        WHERE deny.edition_id=p.edition_id AND deny.status='active'
          AND deny.sales_channel='retail' AND deny.decision='deny'
          AND dt.territory_code=rgt.territory_code
      );
    CREATE VIEW retail_product_availability AS
      SELECT DISTINCT product_id,territory_code FROM retail_product_availability_rows;
  `);
  const product = db.prepare("INSERT INTO products VALUES (?,?,?,?)");
  const edition = db.prepare("INSERT INTO editions VALUES (?,?)");
  const language = db.prepare("INSERT INTO edition_languages VALUES (?,?)");
  const membership = db.prepare("INSERT INTO edition_taxonomy_nodes VALUES (?,?)");
  const grant = db.prepare("INSERT INTO rights_grants VALUES (?,?,?,?,?)");
  const scope = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
  for (let n = 1; n <= 2500; n++) {
    const id = "edition-" + n;
    edition.run(id, n % 31 === 0 ? "draft" : "available");
    product.run(
      "product-" + n,
      id,
      n % 37 === 0 ? "draft" : "active",
      n % 41 === 0 ? "upload" : "gutenberg",
    );
    language.run(id, n % 6 === 0 ? "fr" : "en");
    membership.run(id, "fantasy");
    if (n % 2 === 0) membership.run(id, "fiction");
    if (n % 7 === 0) membership.run(id, "classics");
    grant.run("grant-" + n, id, "retail", n % 19 === 0 ? "revoked" : "active", "allow");
    scope.run("grant-" + n, "US");
    if (n % 313 === 0) scope.run("grant-" + n, "CA");
    // Multiple grants to one edition must NOT double a taxonomy count.
    if (n % 67 === 0) {
      grant.run("duplicate-" + n, id, "retail", "active", "allow");
      scope.run("duplicate-" + n, "US");
    }
    if (n % 47 === 0) {
      grant.run("deny-" + n, id, "retail", "active", "deny");
      scope.run("deny-" + n, "US");
    }
  }
  const original = `WITH eligible AS MATERIALIZED (
    SELECT p.id,p.edition_id FROM products p JOIN editions e ON e.id=p.edition_id
    WHERE p.storefront_status='active' AND p.source_name<>'upload'
      AND e.release_status IN ('available','preorder')
      AND (?='' OR EXISTS(
        SELECT 1 FROM edition_languages el
        WHERE el.edition_id=e.id AND lower(el.language_code)=lower(?)
      ))
      AND EXISTS(SELECT 1 FROM retail_product_availability rpa
        WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
  ) SELECT et.taxonomy_node_id node_id,COUNT(DISTINCT p.id) product_count
    FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
    GROUP BY et.taxonomy_node_id`;
  const normalize = (rows) =>
    rows
      .map((row) => ({ node_id: String(row.node_id), product_count: Number(row.product_count) }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
  const verify = (territory, lang) => {
    const originalRows = normalize(db.prepare(original).all(lang, lang, territory));
    const probe = db.prepare(taxonomySparseRightsProbe).get(territory).grant_count;
    const sparse = probe <= 1000;
    const plan = taxonomyCountPlan(territory, lang, sparse);
    assert.deepEqual(
      normalize(db.prepare(plan.sql).all(...plan.binds)),
      originalRows,
      `Count must preserve current legal rights for ${territory}/${lang}`,
    );
    const otherPlan = taxonomyCountPlan(territory, lang, !sparse);
    assert.deepEqual(
      normalize(db.prepare(otherPlan.sql).all(...otherPlan.binds)),
      originalRows,
      `Both candidate plans must be fully legally equivalent: ${territory}/${lang}`,
    );
    return { probe, sparse };
  };
  for (const territory of ["US", "CA", "GB"]) {
    for (const lang of ["", "en", "fr"]) verify(territory, lang);
  }
  assert.ok(verify("US", "").probe > 1000);
  assert.equal(verify("CA", "").sparse, true);
  assert.equal(verify("GB", "").probe, 0);
  // Revocation, restoration and new active rights must affect BOTH plans
  // immediately without an eligibility cache or replica authorization.
  db.prepare("UPDATE rights_grants SET status='revoked' WHERE id=?").run("grant-313");
  verify("CA", "");
  db.prepare("UPDATE rights_grants SET status='active' WHERE id=?").run("grant-313");
  verify("CA", "");
  grant.run("fresh-ca", "edition-2", "retail", "active", "allow");
  scope.run("fresh-ca", "CA");
  verify("CA", "");
  grant.run("deny-ca", "edition-2", "retail", "active", "deny");
  scope.run("deny-ca", "CA");
  verify("CA", "");
  const sqlPlan = db
    .prepare("EXPLAIN QUERY PLAN " + taxonomyCountPlan("CA", "", true).sql)
    .all(...taxonomyCountPlan("CA", "", true).binds);
  assert.ok(
    sqlPlan.some((row) => String(row.detail).includes("idx_rights_grant_territories_lookup")),
    "Sparse market must use the indexed territory seed",
  );
  assert.ok(
    sqlPlan.some((row) => String(row.detail).includes("retail_product_availability")),
    "Always preserve the authoritative legal view",
  );
  console.log(
    "Taxonomy counts: dense/sparse rights parity; locale, duplicates, revocations, denials, active grants PASS",
  );
} finally {
  db.close();
}
