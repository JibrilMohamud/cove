/* eslint-disable prettier/prettier -- Executable synchronous primary revocation proof. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db=new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE gutenberg_source_cache(
 id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_item_id TEXT,
 source_url TEXT,title TEXT,summary TEXT,authors_json TEXT,subjects_json TEXT,
 bookshelves_json TEXT,languages_json TEXT,formats_json TEXT,
 copyright INTEGER,ingest_status TEXT,rights_status TEXT,
 commercial_use_status TEXT,rights_territories_json TEXT,
 rights_evidence_url TEXT,source_metadata_json TEXT,content_hash TEXT,
 epub_status TEXT,updated_at TEXT,download_count INTEGER);
CREATE TABLE gutenberg_rights_evidence(
 id TEXT PRIMARY KEY,source_id TEXT NOT NULL,cache_id TEXT NOT NULL,
 determination TEXT NOT NULL,territory_code TEXT NOT NULL,evidence_url TEXT,
 evidence_hash TEXT,status TEXT NOT NULL);
CREATE TABLE rights_grants(
 edition_id TEXT,source TEXT,territory_code TEXT,decision TEXT,status TEXT,
 updated_at TEXT,source_evidence_id TEXT);
CREATE TABLE products(id TEXT,storefront_status TEXT,updated_at TEXT);
CREATE TABLE offers(product_id TEXT,active INTEGER,updated_at TEXT);
CREATE TABLE editions(id TEXT,release_status TEXT,updated_at TEXT);
CREATE TABLE catalog_search_documents(product_id TEXT,suppressed INTEGER,
 availability TEXT,updated_at TEXT);
`);
for(const file of ["drizzle/0085_isolated_catalog_changefeed.sql",
                   "drizzle/0086_catalog_legal_withdrawal_guard.sql",
                   "drizzle/0088_catalog_evidence_revocation_and_asset_feed.sql",
                   "drizzle/0089_catalog_evidence_changefeed.sql"])
 db.exec(fs.readFileSync(file,"utf8").replaceAll("--> statement-breakpoint",""));
const seed=db.prepare(`INSERT INTO gutenberg_source_cache(id,source_id,source_item_id,
 source_url,title,summary,authors_json,subjects_json,bookshelves_json,
 languages_json,formats_json,copyright,ingest_status,rights_status,
 commercial_use_status,rights_territories_json,rights_evidence_url,
 source_metadata_json,content_hash,epub_status,download_count)
 VALUES(?,'pg_us',?,'https://gutenberg.example/source','Title','Summary',
 '[]','[]','[]','["en"]','{}',0,'active','public-domain',
 'approved','["US","CA"]','https://license.example','{}','sha-v1','pending',4)`);
const ev=db.prepare(`INSERT INTO gutenberg_rights_evidence(
 id,source_id,cache_id,determination,territory_code,evidence_url,evidence_hash,status)
 VALUES(?,'pg_us',?,'public-domain',?,'https://license.example','hash-v1','approved')`);
const grant=db.prepare(`INSERT INTO rights_grants VALUES(?,'gutenberg-pg_us-public-domain',?,'allow','active','',?)`);
for(const id of ["101","102","103","104","105"]){
 seed.run(id,id);
 for(const territory of ["US","CA"]){
  const evidenceId="ev-"+id+"-"+territory;
  ev.run(evidenceId,id,territory);
  grant.run("ed_gutenberg_"+id,territory,evidenceId);
 }
 db.prepare("INSERT INTO rights_grants VALUES(?,'publisher-private','US','allow','active','',NULL)").run("ed_gutenberg_"+id);
}
const status=(id,country,source="gutenberg-pg_us-public-domain")=>
 db.prepare("SELECT status FROM rights_grants WHERE edition_id=? AND territory_code=? AND source=?")
 .get("ed_gutenberg_"+id,country,source)?.status;
const revision=(id)=>Number(db.prepare("SELECT MAX(seq) rev FROM catalog_index_changefeed WHERE cache_id=?").get(id)?.rev||0);
const rev0=revision("101");
db.prepare("UPDATE gutenberg_source_cache SET download_count=10 WHERE id='101'").run();
assert.equal(revision("101"),rev0,"Popularity-only updates cannot rebuild independent graph");
db.prepare("UPDATE gutenberg_source_cache SET epub_status='completed',content_hash='sha-v2' WHERE id='101'").run();
assert.ok(revision("101")>rev0,"EPUB completion must append a new global-sequence asset event");
assert.equal(status("101","US"),"active");
const beforeEvidenceRevoke=revision("101");
db.prepare("UPDATE gutenberg_rights_evidence SET status='revoked' WHERE id='ev-101-US'").run();
assert.ok(revision("101")>beforeEvidenceRevoke,
 "Evidence revocation must trigger an independent discovery reindex");
assert.equal(status("101","US"),"suspended","Direct evidence revocation must suspend source grant synchronously");
assert.equal(status("101","CA"),"active","Distinct territory evidence remains valid");
assert.equal(status("101","US","publisher-private"),"active","Never cancel a publisher-owned right");
db.prepare("UPDATE gutenberg_rights_evidence SET status='approved' WHERE id='ev-101-US'").run();
assert.equal(status("101","US"),"suspended","Positive evidence update cannot automatically regrant");
db.prepare("UPDATE gutenberg_rights_evidence SET determination='rejected' WHERE id='ev-102-CA'").run();
assert.equal(status("102","CA"),"suspended");
db.prepare("UPDATE gutenberg_rights_evidence SET evidence_hash='superseded' WHERE id='ev-103-US'").run();
assert.equal(status("103","US"),"suspended","Hash substitution must revoke previous source grant");
db.prepare("DELETE FROM gutenberg_rights_evidence WHERE id='ev-104-US'").run();
assert.equal(status("104","US"),"suspended","Evidence deletion must suspend immediately");
const v=revision("105");
db.prepare("UPDATE gutenberg_source_cache SET source_url='https://gutenberg.example/replaced' WHERE id='105'").run();
assert.equal(status("105","US"),"suspended");
assert.equal(status("105","CA"),"suspended");
assert.ok(revision("105")>v,"Provenance changes must append a new global-sequence index event");
db.exec("BEGIN");
db.prepare("UPDATE gutenberg_rights_evidence SET status='revoked' WHERE id='ev-102-US'").run();
assert.equal(status("102","US"),"suspended");
db.exec("ROLLBACK");
assert.equal(status("102","US"),"active","Evidence and grants must roll back in same primary transaction");
const primaryModel=fs.readFileSync("src/features/fore/catalog-model.server.ts","utf8");
const start=primaryModel.indexOf("export async function authorizeStorefrontPresentationIds(");
const end=primaryModel.indexOf("function recordFirstPaintD1Metrics(",start);
const authority=primaryModel.slice(start,end);
assert.ok(authority.includes("gutenberg_rights_evidence ge")&&
 authority.includes("ge.status='approved'")&&authority.includes("ge.determination='public-domain'"),
 "Final legal authority must check current approved source evidence, never only stale grants");
assert.ok(authority.includes("gc.ingest_status='active'"));
console.log("PASS: primary evidence mutation/deletion transactional revocation, provenance and asset revision fencing, no-op popularity and rollback");
