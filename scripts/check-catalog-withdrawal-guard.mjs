/* eslint-disable prettier/prettier -- Transaction-by-transaction legal safety proof kept close to audited SQL. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE gutenberg_source_cache(
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, copyright INTEGER,
 ingest_status TEXT NOT NULL, rights_status TEXT NOT NULL,
 commercial_use_status TEXT NOT NULL,rights_territories_json TEXT NOT NULL,
 rights_evidence_url TEXT NOT NULL, source_metadata_json TEXT NOT NULL,
 last_seen_at TEXT NOT NULL DEFAULT '');
CREATE TABLE rights_grants(
 edition_id TEXT,source TEXT,territory_code TEXT,decision TEXT,
 status TEXT,updated_at TEXT);
CREATE TABLE products(id TEXT,storefront_status TEXT,updated_at TEXT);
CREATE TABLE offers(product_id TEXT,active INTEGER,updated_at TEXT);
CREATE TABLE editions(id TEXT,release_status TEXT,updated_at TEXT);
CREATE TABLE catalog_search_documents(
 product_id TEXT,suppressed INTEGER,availability TEXT,updated_at TEXT);
CREATE INDEX idx_rights_grants_edition ON rights_grants(edition_id,source,status);
CREATE INDEX idx_offers_product ON offers(product_id,active);
CREATE INDEX idx_products_id ON products(id);
CREATE INDEX idx_edition_id ON editions(id);
CREATE INDEX idx_catalog_doc_id ON catalog_search_documents(product_id);
`);
const migration = fs.readFileSync("drizzle/0086_catalog_legal_withdrawal_guard.sql","utf8")
  .replaceAll("--> statement-breakpoint", "");
db.exec(migration);
const seed = db.prepare(`INSERT INTO gutenberg_source_cache
 (id,source_id,copyright,ingest_status,rights_status,commercial_use_status,
  rights_territories_json,rights_evidence_url,source_metadata_json)
 VALUES(?,'pg_us',0,'active','public-domain','approved','["US","CA"]',
 'https://license.example/rights','{"rightsFingerprint":"initial"}')`);
for (const id of ["101","102","103","104","105","106"]) {
 seed.run(id);
 const edition = "ed_gutenberg_" + id, product = "prd_gutenberg_" + id;
 for (const territory of ["US","CA"]) {
   db.prepare(`INSERT INTO rights_grants VALUES(?,'gutenberg-pg_us-public-domain',?,'allow','active','')`).run(edition,territory);
 }
 db.prepare("INSERT INTO rights_grants VALUES(?,'publisher-private','CA','allow','active','')").run(edition);
 db.prepare("INSERT INTO products VALUES(?,'active','')").run(product);
 db.prepare("INSERT INTO offers VALUES(?,1,'')").run(product);
 db.prepare("INSERT INTO editions VALUES(?,'available','')").run(edition);
 db.prepare("INSERT INTO catalog_search_documents VALUES(?,0,'available','')").run(product);
}
const src = (id) => db.prepare("SELECT * FROM gutenberg_source_cache WHERE id=?").get(id);
const grant = (id,territory,source="gutenberg-pg_us-public-domain") =>
 db.prepare("SELECT status FROM rights_grants WHERE edition_id=? AND territory_code=? AND source=?")
 .get("ed_gutenberg_"+id,territory,source)?.status;
const state = (id) => ({
 product:db.prepare("SELECT storefront_status FROM products WHERE id=?").get("prd_gutenberg_"+id)?.storefront_status,
 offer:db.prepare("SELECT active FROM offers WHERE product_id=?").get("prd_gutenberg_"+id)?.active,
 edition:db.prepare("SELECT release_status FROM editions WHERE id=?").get("ed_gutenberg_"+id)?.release_status,
 search:db.prepare("SELECT suppressed FROM catalog_search_documents WHERE product_id=?").get("prd_gutenberg_"+id)?.suppressed,
});
const active = {product:"active",offer:1,edition:"available",search:0};
const denied = {product:"inactive",offer:0,edition:"unavailable",search:1};
// No changes to indexed legal evidence: no false withdrawal on heartbeat.
db.prepare("UPDATE gutenberg_source_cache SET last_seen_at='heartbeat' WHERE id='101'").run();
assert.equal(grant("101","CA"),"active");
assert.deepEqual(state("101"),active);
// Exact territory contraction is synchronous in the SAME primary transaction.
db.prepare("UPDATE gutenberg_source_cache SET rights_territories_json='[\"US\"]' WHERE id='101'").run();
assert.equal(grant("101","CA"),"suspended");
assert.equal(grant("101","US"),"active");
assert.deepEqual(state("101"),active);
// Adding the old territory to source metadata does not automatically re-grant.
db.prepare("UPDATE gutenberg_source_cache SET rights_territories_json='[\"US\",\"CA\"]' WHERE id='101'").run();
assert.equal(grant("101","CA"),"suspended");
// Evidence replacement suspends all previous source-derived permissions.
db.prepare("UPDATE gutenberg_source_cache SET rights_evidence_url='https://license.example/new' WHERE id='102'").run();
assert.equal(grant("102","US"),"suspended");
assert.equal(grant("102","CA"),"suspended");
assert.deepEqual(state("102"),active); // no global withdrawal unless source status revoked
db.prepare("UPDATE gutenberg_source_cache SET source_metadata_json='{\"rightsFingerprint\":\"revised\"}' WHERE id='103'").run();
assert.equal(grant("103","CA"),"suspended");
assert.equal(grant("103","US"),"suspended");
// Source identity cannot retain an old source-specific active right.
db.prepare("UPDATE gutenberg_source_cache SET source_id='pg_ca' WHERE id='104'").run();
assert.equal(grant("104","US"),"suspended");
assert.equal(grant("104","CA"),"suspended");
// Quarantine/deletion invalidates offer, edition, product and search synchronously.
db.prepare("UPDATE gutenberg_source_cache SET ingest_status='quarantined' WHERE id='105'").run();
assert.deepEqual(state("105"),denied);
assert.equal(grant("105","US"),"suspended");
assert.equal(grant("105","CA"),"suspended");
// Ordinary positive source update does not restore cancelled legal state.
db.prepare("UPDATE gutenberg_source_cache SET ingest_status='active' WHERE id='105'").run();
assert.deepEqual(state("105"),denied);
assert.equal(grant("105","US"),"suspended");
db.prepare("DELETE FROM gutenberg_source_cache WHERE id='106'").run();
assert.deepEqual(state("106"),denied);
assert.equal(grant("106","CA"),"suspended");
// Never suspend unrelated publisher licenses.
for (const id of ["101","102","103","104","105","106"]) {
 assert.equal(grant(id,"CA","publisher-private"),"active");
}
// Transaction rollback proves source and rights change atomically together.
db.exec("BEGIN");
db.prepare("UPDATE gutenberg_source_cache SET rights_status='rejected' WHERE id='101'").run();
assert.deepEqual(state("101"),denied);
assert.equal(grant("101","US"),"suspended");
db.exec("ROLLBACK");
assert.equal(grant("101","US"),"active");
assert.equal(src("101").rights_status,"public-domain");
assert.deepEqual(state("101"),active);
assert.ok(!src("106"));
// Proof must run, never be a no-op CI script.
console.log("PASS: rollback atomicity, territory narrowing, source identity, changed evidence, quarantine, deletion, stale restoration and third-party grant isolation");
