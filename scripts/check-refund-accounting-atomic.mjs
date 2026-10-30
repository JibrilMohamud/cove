/* eslint-disable prettier/prettier -- Crash injection at every actual D1 batch boundary, including ambiguous success. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
const directory=mkdtempSync(join(tmpdir(),"cove-refund-atomic-")),stores=[];
try{
  const file=join(directory,"refund.mjs");
  await build({entryPoints:["scripts/test-refund-accounting-legacy-source.ts"],outfile:file,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {postRefundAccounting}=await import(pathToFileURL(file).href);
  const at="2026-10-28T20:00:00.000Z",refundId="refund_atomic_01",orderId="order_atomic_01";
  function fixture(){
    const sql=new DatabaseSync(":memory:");stores.push(sql);
    sql.exec(`CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,user_id TEXT,currency TEXT,total_minor INTEGER,
      refunded_minor INTEGER,status TEXT,tax_minor INTEGER,tax_inclusive_minor INTEGER,updated_at TEXT);
      CREATE TABLE commerce_refunds(id TEXT PRIMARY KEY,order_id TEXT,amount_minor INTEGER,stripe_amount_minor INTEGER,
        gift_card_amount_minor INTEGER,store_credit_amount_minor INTEGER,currency TEXT,status TEXT,succeeded_at TEXT,updated_at TEXT);
      CREATE TABLE commerce_balance_reservations(order_id TEXT,source_type TEXT,source_key TEXT,status TEXT);
      CREATE TABLE commerce_gift_cards(code_hash TEXT PRIMARY KEY,balance_minor INTEGER,status TEXT,expires_at TEXT,updated_at TEXT);
      CREATE TABLE commerce_gift_card_ledger(id TEXT PRIMARY KEY,code_hash TEXT,order_id TEXT,entry_type TEXT,amount_minor INTEGER,balance_after_minor INTEGER,created_at TEXT);
      CREATE TABLE commerce_store_credit_ledger(id TEXT PRIMARY KEY,user_id TEXT,order_id TEXT,entry_type TEXT,amount_minor INTEGER,currency TEXT,reference TEXT,created_at TEXT);
      CREATE TABLE commerce_ledger_entries(id TEXT PRIMARY KEY,order_id TEXT,refund_id TEXT,user_id TEXT,entry_type TEXT,account_code TEXT,amount_minor INTEGER,currency TEXT,external_reference TEXT,metadata_json TEXT,created_at TEXT);
      CREATE UNIQUE INDEX posting_key ON commerce_ledger_entries(order_id,entry_type,account_code,external_reference);
      CREATE TABLE commerce_order_items(id TEXT PRIMARY KEY,order_id TEXT,entitlement_status TEXT);
      CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,order_item_id TEXT,entitlement_type TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE preorders(order_id TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE commerce_promo_codes(code_hash TEXT PRIMARY KEY,redemptions INTEGER,updated_at TEXT);
      CREATE TABLE commerce_promo_redemptions(order_id TEXT,code_hash TEXT,status TEXT,updated_at TEXT);
      INSERT INTO commerce_orders VALUES('order_atomic_01','buyer_atomic_01','USD',1000,0,'paid',100,0,NULL);
      INSERT INTO commerce_refunds VALUES('refund_atomic_01','order_atomic_01',1000,400,300,300,'USD','pending',NULL,NULL);
      INSERT INTO commerce_balance_reservations VALUES('order_atomic_01','gift_card','gift_atomic_01','consumed');
      INSERT INTO commerce_gift_cards VALUES('gift_atomic_01',500,'exhausted',NULL,NULL);
      INSERT INTO commerce_order_items VALUES('item_atomic_01','order_atomic_01','granted');
      INSERT INTO entitlements VALUES('ent_atomic_01','buyer_atomic_01','item_atomic_01','purchase','active',NULL);
      INSERT INTO preorders VALUES('order_atomic_01','confirmed',NULL);
      INSERT INTO commerce_promo_codes VALUES('promo_atomic_01',1,NULL);
      INSERT INTO commerce_promo_redemptions VALUES('order_atomic_01','promo_atomic_01','applied',NULL);`);
    let failure=-1,ambiguous=false,batchSize=0;
    const DB={prepare(query){const statement=(params=[])=>({bind:(...args)=>statement(args),
      async first(){return sql.prepare(query).get(...params)||null;},
      async all(){return {results:sql.prepare(query).all(...params)};},
      execute(){return {meta:sql.prepare(query).run(...params)};},
      async run(){throw Error("All refund mutations MUST run inside one atomic batch");}
    });return statement();},async batch(statements){batchSize=statements.length;sql.exec("BEGIN");
      try{const results=[];for(let i=0;i<statements.length;i++){
        if(i===failure)throw Error("injected_d1_failure_"+i);
        results.push(statements[i].execute());
      }sql.exec("COMMIT");if(ambiguous)throw Error("committed_but_response_lost");return results;
      }catch(error){if(sql.isTransaction)sql.exec("ROLLBACK");throw error;}}
    };
    return {sql,DB,size:()=>batchSize,failAt(n){failure=n;},loseResponse(v){ambiguous=v;}};
  }
  function assertUnposted(f){
    assert.equal(f.sql.prepare("SELECT balance_minor FROM commerce_gift_cards").get().balance_minor,500);
    assert.equal(f.sql.prepare("SELECT succeeded_at FROM commerce_refunds").get().succeeded_at,null);
    assert.equal(f.sql.prepare("SELECT refunded_minor FROM commerce_orders").get().refunded_minor,0);
    for(const table of ["commerce_ledger_entries","commerce_gift_card_ledger","commerce_store_credit_ledger"])
      assert.equal(f.sql.prepare("SELECT count(*) n FROM "+table).get().n,0);
    assert.equal(f.sql.prepare("SELECT status FROM entitlements").get().status,"active");
    assert.equal(f.sql.prepare("SELECT redemptions FROM commerce_promo_codes").get().redemptions,1);
  }
  function assertPosted(f){
    assert.equal(f.sql.prepare("SELECT balance_minor FROM commerce_gift_cards").get().balance_minor,800);
    assert.equal(f.sql.prepare("SELECT sum(amount_minor) n FROM commerce_store_credit_ledger").get().n,300);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM commerce_gift_card_ledger").get().n,1);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM commerce_store_credit_ledger").get().n,1);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,5);
    assert.equal(f.sql.prepare("SELECT sum(amount_minor) n FROM commerce_ledger_entries").get().n,0);
    assert.equal(f.sql.prepare("SELECT amount_minor FROM commerce_ledger_entries WHERE account_code='tax_payable'").get().amount_minor,100);
    assert.equal(f.sql.prepare("SELECT status FROM entitlements").get().status,"revoked");
    assert.equal(f.sql.prepare("SELECT status FROM preorders").get().status,"refunded");
    assert.equal(f.sql.prepare("SELECT status FROM commerce_promo_redemptions").get().status,"refunded");
    assert.equal(f.sql.prepare("SELECT redemptions FROM commerce_promo_codes").get().redemptions,0);
    assert.equal(f.sql.prepare("SELECT refunded_minor FROM commerce_orders").get().refunded_minor,1000);
    assert.equal(f.sql.prepare("SELECT status FROM commerce_orders").get().status,"refunded");
    assert.equal(f.sql.prepare("SELECT succeeded_at FROM commerce_refunds").get().succeeded_at,at);
  }
  const good=fixture();await postRefundAccounting(good.DB,refundId,at,false);assertPosted(good);
  const boundaries=good.size();
  for(let n=0;n<boundaries;n++){
    const f=fixture();f.failAt(n);
    await assert.rejects(()=>postRefundAccounting(f.DB,refundId,at,false));assertUnposted(f);
    f.failAt(-1);await postRefundAccounting(f.DB,refundId,at,false);assertPosted(f);
    await postRefundAccounting(f.DB,refundId,at,false);assertPosted(f);
  }
  const ambiguous=fixture();ambiguous.loseResponse(true);
  await assert.rejects(()=>postRefundAccounting(ambiguous.DB,refundId,at,false));assertPosted(ambiguous);
  ambiguous.loseResponse(false);await postRefundAccounting(ambiguous.DB,refundId,at,false);assertPosted(ambiguous);
  const parallel=fixture();
  await Promise.all(Array.from({length:8},()=>postRefundAccounting(parallel.DB,refundId,at,false)));
  assertPosted(parallel);
  const partial=fixture();
  partial.sql.exec("UPDATE commerce_orders SET total_minor=3,tax_minor=1; UPDATE commerce_refunds SET amount_minor=1,stripe_amount_minor=1,gift_card_amount_minor=0,store_credit_amount_minor=0;");
  for(const id of ["refund_atomic_02","refund_atomic_03"])
    partial.sql.prepare("INSERT INTO commerce_refunds VALUES(?,'order_atomic_01',1,1,0,0,'USD','pending',NULL,NULL)").run(id);
  await Promise.all([refundId,"refund_atomic_02","refund_atomic_03"].map(id=>postRefundAccounting(partial.DB,id,at,false)));
  assert.equal(partial.sql.prepare("SELECT sum(amount_minor) n FROM commerce_ledger_entries WHERE account_code='tax_payable'").get().n,1,
    "Concurrent partial refunds must allocate exactly the full original rounded tax");
  assert.equal(partial.sql.prepare("SELECT sum(amount_minor) n FROM commerce_ledger_entries").get().n,0);
  assert.equal(partial.sql.prepare("SELECT refunded_minor FROM commerce_orders").get().refunded_minor,3);
  assert.equal(partial.sql.prepare("SELECT redemptions FROM commerce_promo_codes").get().redemptions,0);
  for(const patch of ["UPDATE commerce_orders SET refunded_minor=1", "UPDATE commerce_orders SET tax_minor=1001", "UPDATE commerce_refunds SET stripe_amount_minor=401"]){
    const invalid=fixture();invalid.sql.exec(patch);
    await assert.rejects(()=>postRefundAccounting(invalid.DB,refundId,at,false));
    assert.equal(invalid.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,0,
      "Over-refund, invalid tax and unbalanced tender must fail before financial writes");
    assert.equal(invalid.sql.prepare("SELECT succeeded_at FROM commerce_refunds").get().succeeded_at,null);
  }
  console.log(`PASS: refund core is atomic across ${boundaries} D1 mutation boundaries; exact tender restoration, balanced ledger, unknown commit replay, concurrent refunds, rounded tax and fulfillment`);
}finally{for(const db of stores)db.close();rmSync(directory,{recursive:true,force:true});}
