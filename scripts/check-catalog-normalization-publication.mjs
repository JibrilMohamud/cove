/* eslint-disable prettier/prettier -- Exhaustive transaction and withdrawal proof. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"cove-catalog-fenced-"));
try {
  const outfile=path.join(tmp,"publisher.mjs");
  await build({
    entryPoints:["src/storefront-strangler/catalog-normalization-publish.server.ts"],
    outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent",
  });
  const { publishFencedCanonicalMetadata, fencedCanonicalMetadataStatements } =
    await import(pathToFileURL(outfile).href);
  const corefile=path.join(tmp,"normalize.mjs");
  await build({
    entryPoints:["src/storefront-strangler/catalog-normalization-core.ts"],
    outfile:corefile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent",
  });
  const { prepareIsolatedCanonicalMetadata, catalogPreparationWrite } =
    await import(pathToFileURL(corefile).href);

  class SQLiteBinding {
    constructor(db){this.db=db;}
    prepare(sql) {
      const engine=this.db;
      return {
        bind(...args) {
          return {
            all:async () => ({results:engine.prepare(sql).all(...args)}),
            first:async () => engine.prepare(sql).get(...args) || null,
            run:async () => ({meta:{changes:engine.prepare(sql).run(...args).changes}}),
          };
        }
      };
    }
    async batch(statements){
      // Tests assert the same all-or-nothing semantics as D1 batch.
      this.db.exec("BEGIN");
      try {
        const outputs=statements.map(s=>{
          const result=this.db.prepare(s.__sql).run(...s.__args);
          return {meta:{changes:result.changes}};
        });
        this.db.exec("COMMIT");
        return outputs;
      } catch(error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  // D1-shaped preparation must support batch and preserve SQL/args across bind.
  SQLiteBinding.prototype.prepare=function(sql){
    const engine=this.db;
    const statement=(args=[])=>({
      __sql:sql,__args:args,
      bind:(...next)=>statement(next),
      all:async()=>({results:engine.prepare(sql).all(...args)}),
      first:async()=>engine.prepare(sql).get(...args)||null,
      run:async()=>({meta:{changes:engine.prepare(sql).run(...args).changes}}),
    });
    return statement();
  };
  const primarySql = new DatabaseSync(":memory:");
  const isolatedSql = new DatabaseSync(":memory:");
  const primary=new SQLiteBinding(primarySql);
  const isolated=new SQLiteBinding(isolatedSql);
  primarySql.exec(`
    CREATE TABLE gutenberg_source_cache(
      id TEXT PRIMARY KEY,title TEXT,summary TEXT,authors_json TEXT,
      subjects_json TEXT,bookshelves_json TEXT,languages_json TEXT,
      formats_json TEXT,source_id TEXT,ingest_status TEXT,copyright INTEGER,
      rights_status TEXT,commercial_use_status TEXT,rights_territories_json TEXT,
      rights_evidence_url TEXT,source_metadata_json TEXT);
    CREATE TABLE catalog_index_changefeed(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,cache_id TEXT,
      operation TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE works(id TEXT PRIMARY KEY,title TEXT,description TEXT,updated_at TEXT);
    CREATE TABLE editions(id TEXT PRIMARY KEY,title TEXT,description TEXT,updated_at TEXT,release_status TEXT);
    CREATE TABLE products(id TEXT PRIMARY KEY,storefront_status TEXT,updated_at TEXT);
    CREATE TABLE offers(product_id TEXT,active INTEGER,updated_at TEXT);
    CREATE TABLE rights_grants(edition_id TEXT,source TEXT,status TEXT,decision TEXT,
      territory_code TEXT,updated_at TEXT);
    CREATE TABLE catalog_search_documents(product_id TEXT,suppressed INTEGER,availability TEXT,updated_at TEXT);
  `);
  primarySql.exec(fs.readFileSync("drizzle/0085_isolated_catalog_changefeed.sql","utf8")
    .replaceAll("--> statement-breakpoint",""));
  primarySql.exec(fs.readFileSync("drizzle/0086_catalog_legal_withdrawal_guard.sql","utf8")
    .replaceAll("--> statement-breakpoint",""));
  primarySql.exec(fs.readFileSync("drizzle/0087_fenced_canonical_metadata_receipts.sql","utf8")
    .replaceAll("--> statement-breakpoint",""));
  isolatedSql.exec(fs.readFileSync("infra/catalog-index/0002_normalized_preparations.sql","utf8"));
  assert.ok(!isolatedSql.prepare("SELECT 1 FROM sqlite_master WHERE name='rights_grants'").get());
  const seed=primarySql.prepare(`INSERT INTO gutenberg_source_cache
    (id,title,summary,authors_json,subjects_json,bookshelves_json,languages_json,
     formats_json,source_id,ingest_status,copyright,rights_status,commercial_use_status,
     rights_territories_json,rights_evidence_url,source_metadata_json)
    VALUES('2701',?,?,'[]','[]','[]','["en"]','{}','pg_us','active',0,
      'public-domain','approved','["US","CA"]','https://rights.example/v1','{"rightsFingerprint":"a"}')`);
  seed.run("  Initial   Title ","Initial source summary");
  const first=primarySql.prepare("SELECT * FROM gutenberg_source_cache WHERE id='2701'").get();
  primarySql.exec(`
    INSERT INTO works VALUES('wrk_gutenberg_2701','Old title','Old summary','');
    INSERT INTO editions VALUES('ed_gutenberg_2701','Old title','Old summary','','available');
    INSERT INTO products VALUES('prd_gutenberg_2701','active','');
    INSERT INTO offers VALUES('prd_gutenberg_2701',1,'');
    INSERT INTO catalog_search_documents VALUES('prd_gutenberg_2701',0,'available','');
    INSERT INTO rights_grants VALUES('ed_gutenberg_2701','gutenberg-pg_us-public-domain','active','allow','US','');
    INSERT INTO rights_grants VALUES('ed_gutenberg_2701','gutenberg-pg_us-public-domain','active','allow','CA','');
  `);
  const version=()=>primarySql.prepare("SELECT max(seq) n FROM catalog_index_changefeed").get().n;
  const receipt=()=>primarySql.prepare("SELECT * FROM catalog_canonical_publication_receipts WHERE source_id='2701'").get();
  const title=()=>primarySql.prepare("SELECT title FROM editions WHERE id='ed_gutenberg_2701'").get().title;
  async function indexCurrent(){
    const row=primarySql.prepare("SELECT * FROM gutenberg_source_cache WHERE id='2701'").get();
    const p=prepareIsolatedCanonicalMetadata(row,"2701",version());
    const q=catalogPreparationWrite(p);
    isolatedSql.prepare(q.sql).run(...q.binds);
    return p;
  }
  const safe={PRIMARY_DB:primary,CATALOG_INDEX_DB:isolated,
    COVE_CATALOG_NORMALIZATION_PUBLISH_ENABLED:"1",
    COVE_CATALOG_PUBLICATION_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87"};
  let primaryBatchCalls=0;
  const executePrimaryBatch=primary.batch.bind(primary);
  primary.batch=async (writes)=>{primaryBatchCalls++;return executePrimaryBatch(writes);};
  await assert.rejects(()=>publishFencedCanonicalMetadata({...safe,COVE_CATALOG_NORMALIZATION_PUBLISH_ENABLED:"0"},["2701"]),/disabled/);
  await assert.rejects(()=>publishFencedCanonicalMetadata({...safe,COVE_CATALOG_PUBLICATION_PRIMARY_ID:"production"},["2701"]),/unsafe/);
  // Observe actual write activity, not merely the monotonic receipt result.
  // A replay and a territory-only revision must not dirty unchanged canonical
  // metadata rows (which would contend with live primary rights reads).
  primarySql.exec(`
    CREATE TABLE canonical_metadata_writes(target TEXT);
    CREATE TRIGGER audit_work_changes AFTER UPDATE ON works BEGIN
      INSERT INTO canonical_metadata_writes VALUES('work');
    END;
    CREATE TRIGGER audit_edition_changes AFTER UPDATE ON editions BEGIN
      INSERT INTO canonical_metadata_writes VALUES('edition');
    END;
  `);
  const metadataWriteCount=()=>primarySql.prepare("SELECT COUNT(*) n FROM canonical_metadata_writes").get().n;
  await indexCurrent();
  const firstResult=await publishFencedCanonicalMetadata(safe,["2701"]);
  assert.equal(firstResult.published[0].applied,true);
  assert.equal(title(),"Initial Title");
  assert.equal(receipt().revision,1);
  assert.equal(primarySql.prepare("SELECT title FROM works").get().title,"Initial Title");
  assert.equal(metadataWriteCount(),2,"First publish must update one work and one edition");
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,false);
  assert.equal(metadataWriteCount(),2,"A replay must not write either canonical metadata row");
  // Source metadata changes in the primary BEFORE the preparation propagates.
  primarySql.prepare("UPDATE gutenberg_source_cache SET title=? WHERE id='2701'").run("New Book");
  assert.equal(version(),2);
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,false);
  assert.equal(title(),"Initial Title");
  await indexCurrent();
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,true);
  assert.equal(receipt().revision,2);
  assert.equal(title(),"New Book");
  assert.equal(metadataWriteCount(),4,"Changed source text must still update both canonical rows");
  // Replaying old revision cannot overwrite a newer source or receipt.
  const stale={...prepareIsolatedCanonicalMetadata(first,"2701",1)};
  assert.throws(
    ()=>fencedCanonicalMetadataStatements(primary,{...stale,title:"INJECTED TITLE"}),
    /catalog_invalid_prepared_metadata/,
    "Isolated publisher must never inject a title inconsistent with raw primary source",
  );
  assert.throws(
    ()=>fencedCanonicalMetadataStatements(primary,{...stale,description:"INJECTED DESCRIPTION"}),
    /catalog_invalid_prepared_metadata/,
  );
  assert.equal((await primary.batch(fencedCanonicalMetadataStatements(primary,stale)))[0].meta.changes,0);
  assert.equal(title(),"New Book");
  // Territory-only removal creates a new feed revision and immediately
  // suspends removed legal grant without trusting isolated metadata.
  primarySql.prepare("UPDATE gutenberg_source_cache SET rights_territories_json='[\"US\"]' WHERE id='2701'").run();
  assert.equal(version(),3);
  assert.equal(primarySql.prepare("SELECT status FROM rights_grants WHERE territory_code='CA'").get().status,"suspended");
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,false);
  await indexCurrent();
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,true);
  assert.equal(metadataWriteCount(),4,"A territory-only revision must not dirty unchanged work/edition rows");
  assert.equal(primarySql.prepare("SELECT status FROM rights_grants WHERE territory_code='CA'").get().status,"suspended");
  // A fresh but withdrawn source MUST NOT be accepted.
  primarySql.prepare("UPDATE gutenberg_source_cache SET rights_status='quarantined' WHERE id='2701'").run();
  await indexCurrent();
  assert.equal((await publishFencedCanonicalMetadata(safe,["2701"])).published[0].applied,false);
  assert.equal(primarySql.prepare("SELECT storefront_status FROM products").get().storefront_status,"inactive");
  assert.equal(primarySql.prepare("SELECT status FROM rights_grants WHERE territory_code='US'").get().status,"suspended");
  // A mix of two ready sources and one withdrawn source must submit ONE
  // bounded primary D1 transaction (six statements), retain input ordering,
  // and skip the withdrawn source without restoring its storefront rights.
  for (const sourceId of ["2702","2703"]) {
    primarySql.prepare(`INSERT INTO gutenberg_source_cache
      (id,title,summary,authors_json,subjects_json,bookshelves_json,
       languages_json,formats_json,source_id,ingest_status,copyright,
       rights_status,commercial_use_status,rights_territories_json,
       rights_evidence_url,source_metadata_json)
       VALUES(?,?,?,'[]','[]','[]','["en"]','{}','pg_us','active',0,
         'public-domain','approved','["US"]','https://rights.example','{}')`)
      .run(sourceId,"Title "+sourceId,"Summary "+sourceId);
    primarySql.prepare("INSERT INTO works VALUES(?,?,'before','')")
      .run("wrk_gutenberg_"+sourceId,"Old");
    primarySql.prepare("INSERT INTO editions VALUES(?,?,'before','','available')")
      .run("ed_gutenberg_"+sourceId,"Old");
    const sourceRow=primarySql.prepare("SELECT * FROM gutenberg_source_cache WHERE id=?")
      .get(sourceId);
    const prep=prepareIsolatedCanonicalMetadata(sourceRow,sourceId,version());
    const q=catalogPreparationWrite(prep);
    isolatedSql.prepare(q.sql).run(...q.binds);
  }
  const beforeMulti=primaryBatchCalls;
  const multi=await publishFencedCanonicalMetadata(safe,["2702","2701","2703"]);
  assert.equal(primaryBatchCalls,beforeMulti+1,
    "All ready books must commit in one bounded primary D1 batch");
  assert.deepEqual(multi.published.map(x=>x.applied),[true,false,true]);
  assert.equal(multi.published[1].reason,"missing_or_withdrawn");
  assert.equal(primarySql.prepare("SELECT title FROM editions WHERE id='ed_gutenberg_2702'")
    .get().title,"Title 2702");
  assert.equal(primarySql.prepare("SELECT title FROM works WHERE id='wrk_gutenberg_2703'")
    .get().title,"Title 2703");
  assert.equal((await publishFencedCanonicalMetadata(safe,["2702","2703"]))
    .published.every(x=>x.applied===false),true,
    "A replayed batch may never republish an already committed revision");
  // Rollback of cross-statement failure must not produce a positive receipt.
  primarySql.exec("DROP TRIGGER IF EXISTS deny_work_changes");
  primarySql.exec(`CREATE TRIGGER deny_work_changes BEFORE UPDATE ON works
    BEGIN SELECT RAISE(ABORT,'simulated canonical failure'); END;`);
  primarySql.prepare("UPDATE gutenberg_source_cache SET rights_status='public-domain',title='Recovered' WHERE id='2701'").run();
  // Positive source state does not reactivate products/offers/grants.
  assert.equal(primarySql.prepare("SELECT storefront_status FROM products").get().storefront_status,"inactive");
  assert.equal(primarySql.prepare("SELECT status FROM rights_grants WHERE territory_code='US'").get().status,"suspended");
  await indexCurrent();
  const previously=receipt().revision;
  await assert.rejects(()=>publishFencedCanonicalMetadata(safe,["2701"]),/simulated canonical failure/);
  assert.equal(receipt().revision,previously,"D1 transaction must roll back receipt on failed metadata update");
  console.log("PASS: independent normalization; primary exact-source receipt; replay, new revision, territory withdrawal, quarantine, no regrant; atomic rollback");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
