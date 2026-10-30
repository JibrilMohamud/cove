/* eslint-disable prettier/prettier -- Security tests enumerate mutation bypass attempts. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const root=mkdtempSync(join(tmpdir(),"cove-exclusive-fence-"));
try{
  const output=join(root,"write-fence.mjs");
  await build({entryPoints:["src/storefront-strangler/canonical-d1-write-fence.ts"],
    outfile:output,bundle:true,platform:"node",format:"esm",target:"node22",
    logLevel:"silent"});
  const {scopeExclusiveCanonicalD1,readOnlyCanonicalD1}=await import(pathToFileURL(output).href);
  const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
  assert.equal(
    backend.split("scopeExclusiveCanonicalD1(scopePublicationOwnerEnv(env))").length-1,
    2,"EVERY persistence backend HTTP+scheduled entrypoint must use the same write fence"
  );
  assert.ok(backend.includes('async scheduled(')&&backend.includes('async fetch('));

  let created=0,writes=0,batches=0,reads=0;
  const raw={
    prepare(sql){
      created++;
      let bound=[];
      function statement(){
        return {
          bind(...args){bound=args;return statement();},
          async first(){reads++;return {sql,bound};},
          async all(){reads++;return {results:[{sql,bound}]};},
          async run(){if(!/^\s*SELECT\s/i.test(sql))writes++;return {success:true};}
        };
      }
      return statement();
    },
    async batch(statements){
      batches++;
      return Promise.all(statements.map(s=>s.all()));
    },
    async exec(){writes++;}
  };
  const plain={DB:raw};
  assert.equal(scopeExclusiveCanonicalD1(plain),plain,
    "Unconfigured deployments must have byte-for-byte unchanged DB identity and no overhead");
  assert.equal(scopeExclusiveCanonicalD1({...plain,COVE_OWNER_EXCLUSIVE_WRITER_FENCE:"0"}).DB,raw);
  const strict={...plain,COVE_OWNER_EXCLUSIVE_WRITER_FENCE:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"};
  for(const unsafe of [
    {...strict,COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {...strict,COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87"},
    {...strict,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1"},
    {...strict,COVE_SSR_STAGING:"1"},
    {...strict,COVE_OWNER_EXCLUSIVE_WRITER_FENCE:"yes"},
    {...strict,DB:null}
  ])assert.throws(()=>scopeExclusiveCanonicalD1(unsafe),/cutover_not_certified/);
  const fenced=scopeExclusiveCanonicalD1(strict);
  assert.notEqual(fenced,strict);
  assert.notEqual(fenced.DB,raw);
  assert.equal(fenced.COVE_OWNER_EXCLUSIVE_WRITER_FENCE,"1");
  assert.deepEqual(Object.keys(fenced.DB).sort(),["batch","prepare"]);
  assert.equal(typeof fenced.DB.exec,"undefined");
  assert.equal(typeof fenced.DB.withSession,"undefined");
  let select=fenced.DB.prepare("SELECT id FROM commerce_orders WHERE id=?").bind("o_012345678");
  assert.deepEqual(await select.first(),{
    sql:"SELECT id FROM commerce_orders WHERE id=?",bound:["o_012345678"]
  });
  assert.equal((await select.all()).results.length,1);
  assert.deepEqual(await select.run(),{success:true});
  assert.equal((await fenced.DB.batch([select,fenced.DB.prepare("SELECT 1")])).length,2);
  assert.equal(batches,1);
  assert.throws(()=>fenced.DB.batch([raw.prepare("SELECT 1")]),/foreign_statement/);
  assert.throws(()=>fenced.DB.batch([select,raw.prepare("SELECT 1")]),/foreign_statement/);
  assert.throws(()=>fenced.DB.batch([]),/untrusted_batch/);
  assert.throws(()=>fenced.DB.batch([null]),/foreign_statement/);
  assert.throws(()=>fenced.DB.batch(Array.from({length:101},()=>select)),/untrusted_batch/);
  const forbidden=[
    "INSERT INTO commerce_orders VALUES(1)",
    "UPDATE commerce_orders SET status='paid'",
    "DELETE FROM entitlements",
    "REPLACE INTO rights_grants VALUES(1)",
    "CREATE TABLE entitlements (id TEXT)",
    "ALTER TABLE commerce_orders ADD COLUMN test TEXT",
    "DROP TABLE rights_contracts",
    "PRAGMA writable_schema=ON",
    "WITH r AS (SELECT 1) UPDATE commerce_orders SET status='paid'",
    "WITH r AS (SELECT 1) SELECT * FROM commerce_orders",
    " /*x*/ UPDATE commerce_orders SET status='paid'",
    "-- comment\nSELECT * FROM rights_grants",
    "SELECT 1; DROP TABLE rights_grants",
    "SELECT 1;",
    "SELECT 1 /* hidden statement */",
    "",
    "  EXEC sp_executesql('UPDATE entitlements')"
  ];
  const before=created;
  for(const sql of forbidden)
    assert.throws(()=>fenced.DB.prepare(sql),/nonowner_mutation_denied/,
      "Unsafe SQL or unverified query must fail CLOSED: "+sql);
  assert.equal(created,before,
    "Every forbidden statement must be rejected before underlying production D1.prepare");
  assert.equal(writes,0);
  const reused=readOnlyCanonicalD1(raw);
  assert.ok((await reused.prepare("SELECT 2").first()).sql==="SELECT 2");
  assert.equal(writes,0);
  console.log("PASS: owner-exclusive D1 scope on HTTP+cron entrypoints has zero default change, blocks direct writes/CTEs/raw batches/unknown DB methods before D1");
}finally{rmSync(root,{recursive:true,force:true});}
