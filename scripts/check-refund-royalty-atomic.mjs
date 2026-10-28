/* eslint-disable prettier/prettier -- Real royalty implementation, migrated SQLite schema and every write interruption. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,readdirSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
const directory=mkdtempSync(join(tmpdir(),"cove-royalty-atomic-")),stores=[];
const originalFetch=globalThis.fetch;
try{
  const file=join(directory,"finance.mjs");
  await build({entryPoints:["src/features/fore/finance.server.ts"],outfile:file,bundle:true,
    platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {reverseRoyaltiesForRefund}=await import(pathToFileURL(file).href);
  const commerceFile=join(directory,"commerce.mjs");
  await build({entryPoints:["src/features/fore/commerce.server.ts"],outfile:commerceFile,bundle:true,
    platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {refundOrder}=await import(pathToFileURL(commerceFile).href);
  const migrations=readdirSync("drizzle").filter(p=>p.endsWith(".sql")).sort().map(p=>readFileSync(join("drizzle",p),"utf8"));
  function fixture({pending=false}={}){
    const sql=new DatabaseSync(":memory:");stores.push(sql);
    // Only financial transaction behavior is under test here. Referential
    // fixture certification is independently covered by full-schema QA.
    for(const migration of migrations)sql.exec(migration);sql.exec("PRAGMA foreign_keys=OFF");
    const at="2026-10-28T21:00:00Z";
    sql.prepare("INSERT INTO commerce_orders(id,user_id,invoice_number,status,currency,territory_code,subtotal_minor,total_minor,stripe_due_minor,billing_address_json,idempotency_key,stripe_payment_intent_id,created_at,updated_at) VALUES('order_royalty_01','buyer_royalty_01','invoice_royalty_01',?,'USD','US',1000,1000,1000,'{}','royalty-test-order','pi_test_atomic_royalty',?,?)").run(pending?'paid':'refunded',at,at);
    sql.prepare("INSERT INTO commerce_refunds(id,order_id,amount_minor,stripe_amount_minor,currency,status,idempotency_key,reason,created_at,updated_at,succeeded_at) VALUES('refund_royalty_01','order_royalty_01',1000,1000,'USD',?,'royalty-test-refund','requested_by_customer',?,?,?)").run(pending?'pending':'succeeded',at,at,pending?null:at);
    sql.prepare(`INSERT INTO finance_royalty_calculations(id,source_type,source_id,order_id,order_item_id,product_id,contract_id,contract_version_id,contract_version_hash,sales_channel,currency,basis_minor,royalty_pool_minor,input_snapshot_json,calculated_at)
      VALUES('sale_calculation_01','sale','sale_source_01','order_royalty_01','item_royalty_01','prd_royalty_01','contract_royalty_01','version_royalty_01','hash_royalty_01','retail','USD',1000,400,'{}',?)`).run(at);
    for(const party of ["party_royalty_a","party_royalty_b"])
      sql.prepare("INSERT INTO finance_royalty_allocations(id,calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,created_at) VALUES(?,'sale_calculation_01',?,5000,200,20,10,170,'USD','accrued',?,?)").run("allocation_"+party,party,at,at);
    let fail=-1,ambiguous=false,batchSize=0,royaltyReadFailure=false;
    const DB={prepare(query){const statement=(params=[])=>({bind:(...args)=>statement(args),
      async first(){return sql.prepare(query).get(...params)||null;},
      async all(){
        if(royaltyReadFailure&&query.includes("source_type='sale'")){
          royaltyReadFailure=false;throw Error("crash_after_core_before_royalty");
        }
        return {results:sql.prepare(query).all(...params)};
      },
      execute(){return {meta:sql.prepare(query).run(...params)};},
      async run(){
        assert.ok(query.startsWith("UPDATE commerce_refunds"),"Every royalty reversal write must be atomic");
        return {meta:sql.prepare(query).run(...params)};
      }
    });return statement();},async batch(statements){batchSize=statements.length;sql.exec("BEGIN");
      try{const out=[];for(let i=0;i<statements.length;i++){
        if(i===fail)throw Error("injected_royalty_posting_"+i);
        out.push(statements[i].execute());
      }sql.exec("COMMIT");if(ambiguous)throw Error("royalty_response_lost");return out;
      }catch(e){if(sql.isTransaction)sql.exec("ROLLBACK");throw e;}}
    };
    return {sql,DB,size:()=>batchSize,failAt(n){fail=n;},loseResponse(v){ambiguous=v;},
      failNextRoyaltyRead(){royaltyReadFailure=true;}};
  }
  function unposted(f){
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_calculations WHERE source_type='refund'").get().n,0);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_allocations").get().n,2);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_events").get().n,0);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,0);
  }
  function posted(f){
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_calculations WHERE source_type='refund'").get().n,1);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_allocations").get().n,4);
    assert.equal(f.sql.prepare("SELECT sum(royalty_minor) n FROM finance_royalty_allocations").get().n,0);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM finance_royalty_events").get().n,2);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,8);
    assert.equal(f.sql.prepare("SELECT sum(amount_minor) n FROM commerce_ledger_entries").get().n,0);
  }
  const good=fixture();await reverseRoyaltiesForRefund(good.DB,"refund_royalty_01");posted(good);
  const boundaries=good.size();
  for(let i=0;i<boundaries;i++){
    const f=fixture();f.failAt(i);
    await assert.rejects(()=>reverseRoyaltiesForRefund(f.DB,"refund_royalty_01"));unposted(f);
    f.failAt(-1);await reverseRoyaltiesForRefund(f.DB,"refund_royalty_01");posted(f);
    await reverseRoyaltiesForRefund(f.DB,"refund_royalty_01");posted(f);
  }
  const parallel=fixture();
  await Promise.all(Array.from({length:8},()=>reverseRoyaltiesForRefund(parallel.DB,"refund_royalty_01")));posted(parallel);
  const ambiguous=fixture();ambiguous.loseResponse(true);
  await reverseRoyaltiesForRefund(ambiguous.DB,"refund_royalty_01");posted(ambiguous);
  await reverseRoyaltiesForRefund(ambiguous.DB,"refund_royalty_01");posted(ambiguous);
  // Invoke the ORIGINAL customer refund API across the core/royalty crash
  // boundary. The retry must repair the royalty projection from persisted
  // success without making another refund provider request.
  const integration=fixture({pending:true});
  let providerCalls=0;
  globalThis.fetch=async()=>{providerCalls++;return Response.json({id:"re_repaired_original_01",status:"succeeded"});};
  const env={DB:integration.DB,STRIPE_SECRET_KEY:"sk_test_atomic_refund_01",STRIPE_LIVEMODE:"false"};
  const input={orderId:"order_royalty_01",idempotencyKey:"royalty-test-refund"};
  integration.failNextRoyaltyRead();
  await assert.rejects(()=>refundOrder(env,input));
  assert.equal(integration.sql.prepare("SELECT status FROM commerce_orders").get().status,"refunded");
  assert.ok(integration.sql.prepare("SELECT succeeded_at FROM commerce_refunds").get().succeeded_at);
  assert.equal(integration.sql.prepare("SELECT count(*) n FROM finance_royalty_calculations WHERE source_type='refund'").get().n,0);
  assert.equal(providerCalls,1);
  assert.equal((await refundOrder(env,input)).status,"succeeded");
  assert.equal(providerCalls,1,"Persisted verified success repairs royalties without repeating provider refund");
  assert.equal(integration.sql.prepare("SELECT count(*) n FROM finance_royalty_calculations WHERE source_type='refund'").get().n,1);
  assert.equal(integration.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,10);
  assert.equal(integration.sql.prepare("SELECT sum(amount_minor) n FROM commerce_ledger_entries").get().n,0);
  await refundOrder(env,input);
  assert.equal(providerCalls,1);
  assert.equal(integration.sql.prepare("SELECT count(*) n FROM commerce_ledger_entries").get().n,10);
  console.log(`PASS: royalties commit complete calculation, allocations and balanced ledger atomically across ${boundaries} mutation boundaries; deterministic identity, duplicate concurrency and lost-response recovery`);
}finally{globalThis.fetch=originalFetch;for(const db of stores)db.close();rmSync(directory,{recursive:true,force:true});}
