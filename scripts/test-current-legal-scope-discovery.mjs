import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { discoverLegalScopes } from "./release/current-legal-scope-discovery.mjs";

test("discovery includes inactive products, deny-only grants, expanded channels and unresolved scopes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE products(id TEXT,edition_id TEXT,format TEXT,storefront_status TEXT,source_name TEXT,source_external_id TEXT); CREATE TABLE rights_grants(id TEXT,edition_id TEXT,format TEXT,sales_channel TEXT,territory_code TEXT,decision TEXT,status TEXT,subscription_permitted INTEGER,library_permitted INTEGER); CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT);",
    );
    db.exec(
      "INSERT INTO products VALUES('p1','e1','ebook','active','gutenberg','1'),('p2','e2','ebook','inactive','gutenberg','2'),('p3','e3','ebook','inactive','gutenberg','3'); INSERT INTO rights_grants VALUES('g1','e1','ebook','retail','US','allow','active',1,1),('g2','e2','ebook','retail','CA','deny','revoked',0,0),('g3','e3','ebook','retail','ZZ','deny','suspended',0,0); INSERT INTO rights_grant_territories VALUES('g1','US'),('g2','CA');",
    );
    const report = discoverLegalScopes(db);
    assert.equal(report.manifest.products.length, 3);
    assert.equal(report.manifest.scopes.length, 4);
    assert.deepEqual(report.manifest.unresolvedGrantIds, ["g3"]);
    assert.deepEqual(report.manifest.productsWithoutRecordedScopes, ["p3"]);
    assert.equal(report.manifest.scopes.find((r) => r.productId === "p2").territory, "CA");
    assert.equal(report.authorizing, false);
    assert.equal(report.completeOwnerInventory, false);
    assert.equal(discoverLegalScopes(db).manifestSha256, report.manifestSha256);
  } finally {
    db.close();
  }
});
