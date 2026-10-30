/* eslint-disable prettier/prettier -- Enforce source-level commerce-only D1 mutation isolation. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const temp=mkdtempSync(join(tmpdir(),"cove-commerce-fence-"));
try{
  const output=join(temp,"commerce-fence.mjs");
  await build({entryPoints:["src/storefront-strangler/commerce-d1-write-fence.ts"],
    outfile:output,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {scopeCommerceProductionD1,commerceRestrictedCanonicalD1}=await import(pathToFileURL(output).href);
  const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
  assert.equal(backend.split("scopeCommerceProductionD1(scopeExclusiveCanonicalD1(scopePublicationOwnerEnv(env)))").length-1,2,
    "Commerce domain fence must be applied to BOTH authenticated HTTP and scheduled cron paths");
  let prepared=0,mutation=0,batches=0;
  const raw={
    prepare(sql){
      prepared++;
      let values=[];
      const stm=()=>({
        bind(...args){values=args;return stm();},
        async first(){return {sql,values};},
        async all(){return {results:[{sql,values}]};},
        async run(){mutation++;return {success:true};}
      });
      return stm();
    },
    async batch(rows){batches++;return Promise.all(rows.map(r=>r.run()));},
    async exec(){mutation++}
  };
  const base={DB:raw};
  assert.equal(scopeCommerceProductionD1(base),base,"Production default must be exact no-op");
  assert.equal(scopeCommerceProductionD1({...base,COVE_COMMERCE_OWNER_D1_FENCE:"0"}).DB,raw);
  const enrolled={...base,COVE_COMMERCE_OWNER_D1_FENCE:"1",
    COVE_COMMERCE_OWNER_PRODUCTION_ENABLED:"1",
    COVE_RIGHTS_OWNER_ENABLED:"1",STRIPE_LIVEMODE:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64),
    LEGAL_AUTHORITY:{getByName:()=>({fetch:()=>new Response(null,{status:503})})}};
  for(const noFence of [
    {...base,COVE_COMMERCE_OWNER_PRODUCTION_ENABLED:"1"},
    {...base,COVE_COMMERCE_OWNER_PRODUCTION_ENABLED:"enabled"},
    {...enrolled,COVE_COMMERCE_OWNER_D1_FENCE:"0"},
    {...enrolled,COVE_COMMERCE_OWNER_D1_FENCE:undefined}
  ])assert.throws(()=>scopeCommerceProductionD1(noFence),
    /activation_without_write_fence/,"Production enrollment without write isolation must fail closed");
  for(const unsafe of [
    {...enrolled,COVE_COMMERCE_OWNER_PRODUCTION_ENABLED:"enabled"},
    {...enrolled,COVE_COMMERCE_OWNER_PRODUCTION_ENABLED:"0"},
    {...enrolled,COVE_RIGHTS_OWNER_ENABLED:"0"},
    {...enrolled,STRIPE_LIVEMODE:"0"},
    {...enrolled,COVE_COMMERCE_OWNER_D1_FENCE:"enabled"},
    {...enrolled,COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {...enrolled,COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87"},
    {...enrolled,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1"},
    {...enrolled,COVE_SSR_STAGING:"1"},
    {...enrolled,COVE_RIGHTS_OWNER_SECRET:"bad"},
    {...enrolled,LEGAL_AUTHORITY:null},
    {...enrolled,DB:null}
  ])assert.throws(()=>scopeCommerceProductionD1(unsafe),/(cutover_not_certified|activation_without_write_fence)/);
  const restricted=scopeCommerceProductionD1(enrolled);
  assert.notEqual(restricted.DB,raw);
  assert.deepEqual(Object.keys(restricted.DB).sort(),["batch","prepare"]);
  assert.equal(typeof restricted.DB.exec,"undefined");
  assert.equal(typeof restricted.DB.withSession,"undefined");
  const select=restricted.DB.prepare("SELECT status, total_minor FROM commerce_orders WHERE id=?").bind("ord_x");
  assert.equal((await select.first()).values[0],"ord_x");
  const other=restricted.DB.prepare("UPDATE literary_profiles SET updated_at=? WHERE id=?").bind("2026-01-01","book_1");
  assert.deepEqual(await other.run(),{success:true});
  const safeOther=restricted.DB.prepare("INSERT INTO music_profiles(id, title) VALUES(?,?)").bind("track1","Quiet");
  assert.equal((await restricted.DB.batch([safeOther])).length,1);
  assert.equal(batches,1);
  assert.throws(()=>restricted.DB.batch([raw.prepare("SELECT 1")]),/foreign_statement/);
  assert.throws(()=>restricted.DB.batch([]),/untrusted_batch/);
  assert.throws(()=>restricted.DB.batch([select,null]),/foreign_statement/);
  assert.throws(()=>restricted.DB.batch(Array.from({length:101},()=>select)),/untrusted_batch/);
  const forbidden=[
    "INSERT INTO commerce_orders(id) VALUES(?)",
    "update main.commerce_refunds set status='succeeded'",
    'UPDATE "commerce_orders" SET status = ?',
    "UPDATE [commerce_orders] SET status='paid'",
    "REPLACE INTO `commerce_refunds` VALUES(1)",
    "DELETE FROM entitlements WHERE id=?",
    "INSERT INTO publishing_entitlement_version_pins VALUES(?)",
    "UPDATE publishing_owner_version_events SET id=?",
    "INSERT INTO publishing_outbox VALUES(?)",
    "INSERT INTO finance_royalty_allocations VALUES(?)",
    "UPDATE royalty_allocations SET amount=1",
    "INSERT INTO preorders VALUES(1)",
    "INSERT INTO account_billing_methods VALUES(1)",
    "UPDATE commercial_delivery_grants SET status='revoked'",
    "UPDATE audio_offline_licenses SET status='revoked'",
    "UPDATE literary_profiles SET id=(SELECT id FROM commerce_orders LIMIT 1)",
    "WITH q AS (SELECT 1) UPDATE commerce_orders SET status='paid'",
    "WITH q AS (UPDATE commerce_orders SET status='paid') SELECT * FROM q",
    "PRAGMA writable_schema=ON",
    "CREATE TRIGGER t AFTER UPDATE ON literary_profiles BEGIN UPDATE commerce_orders SET status='paid'; END",
    "ALTER TABLE commerce_orders ADD COLUMN forged TEXT",
    "SELECT 1; UPDATE commerce_orders SET status='paid'",
    "-- safe\nUPDATE commerce_orders SET status='paid'",
    "UPDATE /*comment*/ commerce_orders SET status='paid'",
    "VACUUM", "EXPLAIN UPDATE commerce_orders SET status='paid'",
    "", "SELECT 'unfinished"
  ];
  const before=prepared;
  for(const sql of forbidden)
    assert.throws(()=>restricted.DB.prepare(sql),/nonowner_write_denied/,
      "Forbidden commerce SQL must not reach the driver: "+sql);
  assert.equal(prepared,before,"No rejected statement may touch the actual production DB binding");
  const rawSafe=commerceRestrictedCanonicalD1(raw);
  assert.ok((await rawSafe.prepare("SELECT 'commerce_orders; -- in a literal' AS test").first()).sql);
  assert.equal(mutation,2,"Only the two unrelated non-commerce writes may execute");
  console.log("PASS: commerce-only canonical D1 fence rejects all tested financial/entitlement writes on HTTP and cron, preserves unrelated DML, and changes no default production behavior.");
}finally{rmSync(temp,{recursive:true,force:true});}
