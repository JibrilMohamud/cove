/* eslint-disable prettier/prettier -- Security regression matrix: never relax a canonical writer fence. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(path.join(os.tmpdir(),"cove-legal-mutation-fence-"));
try {
  const artifact=path.join(directory,"lock.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-primary-write-lock.ts"],
    outfile:artifact,format:"esm",platform:"node",bundle:true,target:"node22",logLevel:"silent"});
  const {classifyProtectedLegalSql,guardProtectedLegalSql,
    makeStageLegalWriterLock,scopeStageLegalWriterEnv}=await import(pathToFileURL(artifact).href);

  const deny=[
    "UPDATE rights_grants SET status='revoked' WHERE id=?",
    "WITH old AS (SELECT 1) UPDATE rights_grants SET status='active' WHERE id=?",
    "INSERT INTO gutenberg_rights_evidence(id) VALUES(?)",
    "INSERT OR IGNORE INTO offers(id) VALUES(?)",
    "DELETE FROM rights_grant_territories WHERE grant_id=?",
    "REPLACE INTO editions(id) VALUES(?)",
    "CREATE TABLE gutenberg_source_cache(id TEXT)",
    "UPDATE products SET storefront_status='inactive'",
    "INSERT INTO entitlements(id) VALUES(?)",
    "DELETE FROM offline_epub_licenses WHERE id=?",
    "-- legal review\n UPDATE rights_contracts SET status='active'",
    "SELECT 1; UPDATE offers SET active=1",
    "UPDATE main.\"rights_grants\" SET status='active' WHERE id=?",
    "INSERT INTO \"main\".\"offers\"(id) VALUES(?)",
    "DELETE FROM [main].[entitlements] WHERE id=?",
    "CREATE TRIGGER regrant AFTER INSERT ON cove_arch_load BEGIN UPDATE rights_grants SET status='active'; END",
    "PRAGMA writable_schema=ON",
  ];
  for(const sql of deny){
    assert.ok(classifyProtectedLegalSql(sql).length>0,"Fails to recognize: "+sql);
    assert.throws(()=>guardProtectedLegalSql(sql),
      /canonical_legal_write_requires_owner_fence/);
  }
  const allow=[
    "SELECT * FROM rights_grants WHERE edition_id=?",
    "SELECT product_id FROM offers WHERE active=1",
    "UPDATE cove_arch_load SET payload=? WHERE run_id=?",
    "INSERT INTO recommendation_events(id) VALUES(?)"
  ];
  for(const sql of allow)assert.deepEqual(classifyProtectedLegalSql(sql),[],
    "Non-legal statement must not be classified as authoritatively mutating");
  let nativeBatches=0, nativePrepareCalls=0;
  const native={
    prepare(sql){
      nativePrepareCalls++;
      return {sql,bind(...args){return {...this,args}},async all(){return {results:[]}},
        async first(){return null},async run(){return {success:true}}};
    },
    async batch(stmts){nativeBatches++;return stmts.map(s=>({sql:s.sql}))},
    exec(sql){throw Error("Raw SQL exec must be blocked in the audit: "+sql)},
    withSession(){return this;}
  };
  const scoped=scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",DB:native
  });
  assert.notEqual(scoped.DB,native,"Staging closure must wrap the raw binding");
  assert.equal(nativePrepareCalls,0);
  const select=scoped.DB.prepare("SELECT * FROM rights_grants WHERE id=?").bind("r1");
  const synthetic=scoped.DB.prepare("UPDATE cove_arch_load SET sequence=? WHERE id=?").bind(1,"run");
  const batched=await scoped.DB.batch([select,synthetic]);
  assert.equal(nativeBatches,1);
  assert.equal(batched.length,2);
  for(const sql of deny) assert.throws(()=>scoped.DB.prepare(sql),
    /canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>scoped.DB.batch([native.prepare("SELECT 1")]),
    /unfenced_legal_batch_statement/);
  assert.throws(()=>scoped.DB.exec("UPDATE offers SET active=1"),
    /unfenced_legal_sql_exec/);
  assert.throws(()=>scoped.DB.withSession("first-unconstrained")
    .prepare("DELETE FROM rights_grants"),/canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"0",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",DB:native
  }),/production_legal_writer_cutover_not_certified/);
  assert.equal(scopeStageLegalWriterEnv({
    COVE_SSR_STAGING:"0",DB:native
  }).DB,native,"Production release flag off must preserve existing primary DB");
  console.log("PASS: legacy API/cron legal write barrier blocks D1 upserts, SQL injection via batches, and unverified production cutover");
}finally{rmSync(directory,{force:true,recursive:true});}
