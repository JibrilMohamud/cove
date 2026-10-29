/* eslint-disable prettier/prettier -- Adversarial runtime D1 writer deny tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cove-writer-lock-"));
try {
  const file=path.join(dir,"legal-lock.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-primary-write-lock.ts"],
    outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const {guardProtectedLegalSql,makeStageLegalWriterLock,
    scopeStageLegalWriterEnv}=await import(pathToFileURL(file).href);
  const source=fs.readFileSync("src/storefront-strangler/legal-primary-write-lock.ts","utf8");
  assert.ok(source.includes('from "../../config/canonical-legal-tables.json"'),
    "Runtime SQL fence must import the same registry used by the scanner");
  const tables=JSON.parse(fs.readFileSync("config/canonical-legal-tables.json","utf8"));
  assert.ok(Array.isArray(tables));
  assert.equal(tables.length,new Set(tables).size,"Protected-table registry must not have duplicates");
  assert.ok(tables.length>=90,"Incomplete guarded-table registry");
  for(const name of tables){
    for(const sql of [
      `INSERT INTO ${name} (id) VALUES ('x')`,
      `UPDATE ${name} SET id='x'`,
      `DELETE FROM ${name}`,
      `DROP TABLE ${name}`,
      `ALTER TABLE ${name} RENAME TO discarded`
    ])assert.throws(()=>guardProtectedLegalSql(sql),
      /canonical_legal_write_requires_owner_fence/,sql);
  }
  for(const sql of [
    "WITH t AS (SELECT 1) UPDATE commerce_ledger_entries SET id='x'",
    "INSERT /* comment */ INTO rights_grants (id) VALUES ('x')",
    "UPDATE /* comment */ commercial_audio_playback SET id='x'",
    "DELETE /* comment */ FROM publishing_owner_version_events",
    "CREATE TEMP TRIGGER bypass BEFORE INSERT ON products BEGIN SELECT 1; END",
    "ATTACH DATABASE 'secondary.db' AS bypass",
    "PRAGMA writable_schema=ON"
  ]) assert.throws(()=>guardProtectedLegalSql(sql),
    /canonical_legal_write_requires_owner_fence/,sql);
  guardProtectedLegalSql("SELECT * FROM rights_grants WHERE id='x'");
  guardProtectedLegalSql("UPDATE local_transient_metrics SET value=1");
  const calls=[];
  const unguarded={
    prepare(sql){
      calls.push(sql);
      const stmt={bind(){return stmt;},run:async()=>({success:true}),
        first:async()=>null,all:async()=>({results:[]})};
      return stmt;
    },
    batch:async statements=>statements.length,
    withSession(){return this;},
    exec:async()=>({success:true})
  };
  const guarded=makeStageLegalWriterLock(unguarded);
  assert.throws(()=>guarded.prepare("INSERT INTO commerce_payment_attempts (id) VALUES ('x')"),
    /canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>guarded.withSession().prepare("UPDATE publishing_titles SET id='x'"),
    /canonical_legal_write_requires_owner_fence/);
  assert.throws(()=>guarded.exec("UPDATE rights_grants SET id='x'"),
    /unfenced_legal_sql_exec/);
  assert.throws(()=>guarded.batch([unguarded.prepare("SELECT 1")]),
    /unfenced_legal_batch_statement/);
  const safe=guarded.prepare("SELECT 1").bind("safe");
  assert.equal(await guarded.batch([safe]),1);
  assert.equal((await safe.run()).success,true);
  assert.throws(()=>scopeStageLegalWriterEnv({
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",COVE_SSR_STAGING:"0",DB:unguarded
  }),/production_legal_writer_cutover_not_certified/);
  const staged=scopeStageLegalWriterEnv({
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",COVE_SSR_STAGING:"1",DB:unguarded
  });
  assert.throws(()=>staged.DB.prepare("UPDATE commerce_ledger_entries SET id='x'"),
    /canonical_legal_write_requires_owner_fence/);
  assert.ok(calls.includes("SELECT 1"));
  console.log("PASS: "+tables.length+
    " canonical tables denied for insert/update/delete/DDL; SQL comments, "+
    "CTE, forged batch, session and production fallback denied");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
