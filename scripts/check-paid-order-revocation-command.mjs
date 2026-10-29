/* eslint-disable prettier/prettier -- Exercise the real owner and payment-side command against independent stores. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const directory=mkdtempSync(join(tmpdir(),"cove-revoke-command-"));
const stores=[];
const originalFetch=globalThis.fetch;
try {
  const workerFile=join(directory,"worker.mjs"),clientFile=join(directory,"client.mjs"),commerceFile=join(directory,"commerce.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:workerFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"durable-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env){ this.ctx=ctx; this.env=env; } }"}));
    }}]});
  await build({entryPoints:["src/storefront-strangler/paid-order-revocation.server.ts"],
    outfile:clientFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  await build({entryPoints:["src/features/fore/commerce.server.ts"],
    outfile:commerceFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {refundOrder}=await import(pathToFileURL(commerceFile).href);
  const {CoveLegalAuthority,default:worker}=await import(pathToFileURL(workerFile).href);
  const {revokePaidOrderAccess}=await import(pathToFileURL(clientFile).href);
  const secret="e".repeat(64),orderId="order_revoke_primary_01",otherOrder="order_unrelated_01";
  function fixture(){
    const primary=new DatabaseSync(":memory:"),owned=new DatabaseSync(":memory:");
    stores.push(primary,owned);
    primary.exec(`CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,user_id TEXT,status TEXT DEFAULT 'paid',
        total_minor INTEGER DEFAULT 1000,refunded_minor INTEGER DEFAULT 0,stripe_due_minor INTEGER DEFAULT 1000,
        store_credit_minor INTEGER DEFAULT 0,gift_card_minor INTEGER DEFAULT 0,
        stripe_payment_intent_id TEXT DEFAULT 'pi_test_order_01',currency TEXT DEFAULT 'USD');
      CREATE TABLE commerce_refunds(id TEXT PRIMARY KEY,order_id TEXT,amount_minor INTEGER,
        stripe_amount_minor INTEGER,gift_card_amount_minor INTEGER,store_credit_amount_minor INTEGER,
        currency TEXT,reason TEXT,status TEXT,idempotency_key TEXT UNIQUE,created_at TEXT,updated_at TEXT,
        provider_refund_id TEXT,succeeded_at TEXT);
      CREATE TABLE commerce_order_items(id TEXT PRIMARY KEY,order_id TEXT,product_id TEXT,total_minor INTEGER,source_surface TEXT,source_request_id TEXT,pricing_decision_id TEXT);
      CREATE TABLE finance_royalty_calculations(id TEXT,order_id TEXT,source_type TEXT);
      CREATE TABLE pricing_decisions(id TEXT,promotion_amount_minor INTEGER,promotion_id TEXT);
      CREATE TABLE promotions(id TEXT,campaign_id TEXT);
      CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,order_item_id TEXT,
        entitlement_type TEXT,status TEXT);
      CREATE TABLE audio_offline_licenses(id TEXT PRIMARY KEY,entitlement_id TEXT,
        status TEXT,revoked_at TEXT,revocation_reason TEXT);
      CREATE TABLE commercial_delivery_grants(id TEXT PRIMARY KEY, user_id TEXT,
        entitlement_id TEXT, status TEXT);`);
    primary.prepare("INSERT INTO commerce_orders(id,user_id) VALUES(?,?)").run(orderId,"buyer_primary_01");
    primary.prepare("INSERT INTO commerce_orders(id,user_id) VALUES(?,?)").run(otherOrder,"buyer_other_01");
    // More than the old per-item owner RPC bound; revocation remains one command.
    for(let i=0;i<40;i++){
      primary.prepare("INSERT INTO commerce_order_items(id,order_id) VALUES(?,?)").run("item_"+i,orderId);
      primary.prepare("INSERT INTO entitlements VALUES(?,?,?,'purchase','active')")
        .run("ent_"+i,"buyer_primary_01","item_"+i);
      primary.prepare("INSERT INTO audio_offline_licenses(id,entitlement_id,status) VALUES(?,?,'active')")
        .run("offline_"+i,"ent_"+i);
      primary.prepare("INSERT INTO commercial_delivery_grants(id,user_id,entitlement_id,status) VALUES(?,?,?,'active')")
        .run("epub_"+i,"buyer_primary_01","ent_"+i);
    }
    primary.prepare("INSERT INTO commerce_order_items(id,order_id) VALUES('item_unrelated',?)").run(otherOrder);
    primary.exec("INSERT INTO entitlements VALUES('other_ent','buyer_other_01','item_unrelated','purchase','active')");
    primary.exec("INSERT INTO audio_offline_licenses(id,entitlement_id,status) VALUES('offline_other','other_ent','active')");
    primary.exec("INSERT INTO commercial_delivery_grants(id,user_id,entitlement_id,status) VALUES('epub_other','buyer_other_01','other_ent','active')");
    // A corrupted grant on the same entitlement but a different buyer must
    // never be modified by an order scoped to the legitimate purchaser.
    primary.exec("INSERT INTO commercial_delivery_grants(id,user_id,entitlement_id,status) VALUES('epub_wrong_buyer','buyer_other_01','ent_0','active')");
    // A damaged row from another buyer must not be revoked by guessed item IDs.
    primary.exec("INSERT INTO entitlements VALUES('wrong_buyer','buyer_other_01','item_0','purchase','active')");
    primary.exec("INSERT INTO entitlements VALUES('subscription','buyer_primary_01','item_0','subscription','active')");
    const sql={exec(query,...params){const q=owned.prepare(query);
      const rows=q.columns().length?q.all(...params):(q.run(...params),[]);
      return {toArray:()=>rows};}};
    let failWrite=false,failRead=false,writes=0;
    let batchQueue=Promise.resolve();
    const DB={prepare(query){const statement=(params=[])=>({
      bind:(...args)=>statement(args),
      async first(){if(failRead)throw Error("primary_read_outage");
        return primary.prepare(query).get(...params)||null;},
      async all(){if(failRead)throw Error("primary_read_outage");
        return {results:primary.prepare(query).all(...params)};},
      async run(){
        if(query.startsWith("UPDATE entitlements")){
          assert.equal(owned.prepare("SELECT count(*) n FROM cove_paid_refunded_orders WHERE order_id=?")
            .get(orderId).n,1,"Durable owner denial MUST precede first D1 write");
          if(failWrite)throw Error("primary_write_outage");
          writes++;
        }
        return {meta:primary.prepare(query).run(...params)};
      }
    });return statement();},
      async batch(statements){
        // D1 serializes atomic batches. The independent SQLite fixture must
        // emulate that queue when eight owner replays arrive concurrently;
        // overlapping BEGIN calls in one in-memory connection are not D1.
        const task=batchQueue.then(async()=>{
          primary.exec("BEGIN");
          try {
            const results=[];
            for(const entry of statements)results.push(await entry.run());
            primary.exec("COMMIT");
            return results;
          }catch(error){primary.exec("ROLLBACK");throw error;}
        });
        batchQueue=task.then(()=>{},()=>{});
        return task;
      }
    };
    const ownerEnv={PRIMARY_DB:DB,COVE_RIGHTS_OWNER_ENABLED:"1",
      COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600_000),
      COVE_RIGHTS_OWNER_SECRET:secret};
    const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){
      owned.exec("BEGIN");try{const r=fn();owned.exec("COMMIT");return r;}
      catch(e){owned.exec("ROLLBACK");throw e;}
    }}},ownerEnv);
    ownerEnv.LEGAL_AUTHORITY={getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return owner;}};
    const clientEnv={DB,STRIPE_SECRET_KEY:"sk_test_unit_refund_01",STRIPE_LIVEMODE:"false",COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_SSR_STAGING:"1",
      COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",COVE_LEGAL_WRITER_PRIMARY_ID:ownerEnv.COVE_RIGHTS_OWNER_PRIMARY_ID,
      COVE_RIGHTS_OWNER_SECRET:secret,LEGAL_AUTHORITY:ownerEnv.LEGAL_AUTHORITY};
    const post=(body,headers={},method="POST")=>worker.fetch(
      new Request("https://legal-authority.internal/commercial/order/revoke",{method,
        headers:{authorization:"Bearer "+secret,"content-type":"application/json",...headers},
        ...(method==="POST"?{body:JSON.stringify(body)}:{})}),ownerEnv);
    return {primary,owned,ownerEnv,clientEnv,post,
      setFailWrite(v){failWrite=v;},setFailRead(v){failRead=v;},writes:()=>writes,
      active:()=>primary.prepare("SELECT count(*) n FROM entitlements WHERE user_id='buyer_primary_01' AND entitlement_type='purchase' AND status='active'").get().n};
  }
  const f=fixture(),operationId="refund:command_01";
  await revokePaidOrderAccess(f.clientEnv,orderId,operationId);
  assert.equal(f.active(),0);assert.equal(f.writes(),1);
  assert.equal(f.primary.prepare("SELECT count(*) n FROM audio_offline_licenses WHERE status='revoked' AND revoked_at IS NOT NULL AND revocation_reason='order_refunded'").get().n,40,
    "All forty linked offline audio licenses must be atomically withdrawn before the owner acknowledges");
  assert.equal(f.primary.prepare("SELECT status FROM audio_offline_licenses WHERE id='offline_other'").get().status,"active",
    "Refund must not withdraw another customer's offline license");
  assert.equal(f.primary.prepare("SELECT count(*) n FROM commercial_delivery_grants WHERE user_id='buyer_primary_01' AND status='revoked'").get().n,40,
    "Every existing EPUB delivery token must be revoked by the same canonical batch");
  assert.equal(f.primary.prepare("SELECT status FROM commercial_delivery_grants WHERE id='epub_other'").get().status,"active");
  assert.equal(f.primary.prepare("SELECT status FROM commercial_delivery_grants WHERE id='epub_wrong_buyer'").get().status,"active",
    "Malicious or inconsistent buyer claims cannot widen scope");
  assert.equal(f.primary.prepare("SELECT status FROM entitlements WHERE id='other_ent'").get().status,"active");
  assert.equal(f.primary.prepare("SELECT status FROM entitlements WHERE id='wrong_buyer'").get().status,"active");
  assert.equal(f.primary.prepare("SELECT status FROM entitlements WHERE id='subscription'").get().status,"active");
  await revokePaidOrderAccess(f.clientEnv,orderId,operationId);
  assert.equal(f.owned.prepare("SELECT count(*) n FROM cove_paid_order_denial_ops").get().n,1,
    "Exact replay cannot create duplicate owner command records");
  assert.equal((await f.post({orderId:otherOrder,operationId})).status,503,
    "Operation identity cannot be reused for another order");
  const failed=fixture();failed.setFailWrite(true);
  await assert.rejects(()=>revokePaidOrderAccess(failed.clientEnv,orderId,operationId));
  assert.equal(failed.active(),40);
  assert.equal(failed.primary.prepare("SELECT count(*) n FROM audio_offline_licenses WHERE status='active' AND entitlement_id LIKE 'ent_%'").get().n,40,
    "An aborted canonical batch cannot partially revoke offline licenses");
  assert.equal(failed.primary.prepare("SELECT count(*) n FROM commercial_delivery_grants WHERE user_id='buyer_primary_01' AND status='active'").get().n,40,
    "D1 failure must not produce a partially revoked EPUB grant set");
  assert.equal(failed.owned.prepare("SELECT count(*) n FROM cove_paid_refunded_orders WHERE order_id=?").get(orderId).n,1,
    "Primary failure must not roll back the durable order denial");
  failed.setFailWrite(false);
  await revokePaidOrderAccess(failed.clientEnv,orderId,operationId);
  assert.equal(failed.active(),0,"Same immutable command repairs an interrupted reconciliation");
  assert.equal(failed.primary.prepare("SELECT count(*) n FROM audio_offline_licenses WHERE status='revoked' AND revocation_reason='order_refunded'").get().n,40,
    "A replay must reconcile the offline-license rows after a failed canonical batch");
  assert.equal(failed.primary.prepare("SELECT count(*) n FROM commercial_delivery_grants WHERE user_id='buyer_primary_01' AND status='revoked'").get().n,40,
    "The exact replay must also repair all old EPUB delivery tokens");
  const concurrent=fixture();
  await Promise.all(Array.from({length:8},()=>revokePaidOrderAccess(concurrent.clientEnv,orderId,operationId)));
  assert.equal(concurrent.active(),0);
  assert.equal(concurrent.owned.prepare("SELECT count(*) n FROM cove_paid_order_denial_ops").get().n,1);
  const invalid=fixture();
  for(const input of [{orderId,operationId,userId:"buyer_other_01"},{orderId,operationId,sql:"UPDATE entitlements"},
    {orderId,operationId:12},{orderId:"short",operationId},null,[]])
    assert.equal((await invalid.post(input)).status,400);
  assert.equal((await invalid.post({orderId,operationId},{authorization:"Bearer forged"})).status,401);
  assert.equal((await invalid.post({orderId,operationId},{},"GET")).status,405);
  assert.equal(invalid.writes(),0);assert.equal(invalid.active(),40);
  invalid.ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>revokePaidOrderAccess(invalid.clientEnv,orderId,operationId));
  assert.equal(invalid.writes(),0);
  for(const patch of [{COVE_SSR_STAGING:"0"},{COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_RIGHTS_OWNER_SECRET:"forged"}])
    await assert.rejects(()=>revokePaidOrderAccess({...f.clientEnv,...patch},orderId,operationId));
  for(const receipt of [{orderDenied:true},
    {schema:"cove.paid-order-revocation.v1",orderDenied:true,reconciled:true,orderId:otherOrder,operationId},
    {schema:"cove.paid-order-revocation.v1",orderDenied:true,reconciled:true,orderId,operationId:"old-operation"},
    {schema:"cove.paid-order-revocation.v1",orderDenied:true,reconciled:false,orderId,operationId}])
    await assert.rejects(()=>revokePaidOrderAccess({...f.clientEnv,
      LEGAL_AUTHORITY:{getByName(){return {fetch:async()=>Response.json(receipt)};}}},orderId,operationId));
  const disabled=fixture();
  await revokePaidOrderAccess({...disabled.clientEnv,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},orderId,operationId);
  assert.equal(disabled.writes(),0,"Legacy production behavior is unchanged before enrollment");
  // Original refund API: intent survives owner outage, then resumes its
  // exact provider request instead of returning a permanently pending row.
  const recovery=fixture(),requestKey="refund-recovery-original-01";
  const refundInput={orderId,idempotencyKey:requestKey};
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(recovery.owned.prepare("SELECT count(*) n FROM cove_paid_refunded_orders WHERE order_id=?").get(orderId).n,1,
      "Original refund must revoke before contacting Stripe");
    calls.push({url:String(url),options});
    assert.ok(String(url).startsWith("https://api.stripe.com/v1/refunds"));
    return Response.json({id:"re_original_pending_01",status:"pending"});
  };
  recovery.ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>refundOrder(recovery.clientEnv,refundInput));
  assert.equal(calls.length,0);
  const intent=recovery.primary.prepare("SELECT * FROM commerce_refunds").get();
  assert.equal(intent.status,"pending");
  recovery.ownerEnv.COVE_RIGHTS_OWNER_ENABLED="1";
  const resumed=await refundOrder(recovery.clientEnv,refundInput);
  assert.equal(resumed.id,intent.id);assert.equal(resumed.status,"pending");
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers["Idempotency-Key"],requestKey);
  assert.equal(calls[0].options.body.get("metadata[fore_refund_id]"),intent.id);
  assert.equal(calls[0].options.body.get("amount"),"1000");
  assert.equal(recovery.primary.prepare("SELECT count(*) n FROM commerce_refunds").get().n,1);
  await refundOrder(recovery.clientEnv,refundInput);
  assert.equal(calls.length,2);assert.equal(calls[1].options.method,"GET");
  assert.equal(calls[1].url,"https://api.stripe.com/v1/refunds/re_original_pending_01",
    "Already accepted provider refund must be polled by exact identity");
  for(const changed of [{orderId:otherOrder},{amountMinor:999},{reason:"fraudulent"}])
    await assert.rejects(()=>refundOrder(recovery.clientEnv,{...refundInput,...changed}));
  assert.equal(calls.length,2,"Idempotency collisions must fail before provider access");
  recovery.primary.exec("UPDATE commerce_refunds SET status='succeeded',succeeded_at='2026-10-28T00:00:00Z'");
  recovery.primary.exec("DELETE FROM commerce_order_items");
  const completed=await refundOrder(recovery.clientEnv,refundInput);
  assert.equal(completed.status,"succeeded");assert.equal(calls.length,2);
  const lost=fixture(),lostKey="refund-lost-provider-response-01";
  let providerAttempts=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers["Idempotency-Key"],lostKey);
    providerAttempts++;
    if(providerAttempts===1)throw Error("Provider accepted request but response was lost");
    return Response.json({id:"re_original_recovered_01",status:"pending"});
  };
  await assert.rejects(()=>refundOrder(lost.clientEnv,{orderId,idempotencyKey:lostKey}));
  assert.equal(lost.primary.prepare("SELECT status FROM commerce_refunds").get().status,"pending",
    "Unknown provider outcome must retain the original refund budget reservation");
  await assert.rejects(()=>refundOrder(lost.clientEnv,{orderId,idempotencyKey:"different-refund-key-01"}));
  assert.equal(providerAttempts,1,"A second refund cannot consume the reserved budget");
  assert.equal((await refundOrder(lost.clientEnv,{orderId,idempotencyKey:lostKey})).providerRefundId,"re_original_recovered_01");
  assert.equal(providerAttempts,2);
  const competing=fixture();let competingProviderCalls=0;
  globalThis.fetch=async()=>{competingProviderCalls++;
    return Response.json({id:"re_competing_budget_01",status:"pending"});};
  const outcomes=await Promise.allSettled([
    refundOrder(competing.clientEnv,{orderId,idempotencyKey:"competing-refund-key-01"}),
    refundOrder(competing.clientEnv,{orderId,idempotencyKey:"competing-refund-key-02"}),
  ]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1,
    "Different concurrent request keys cannot both reserve a full refund");
  assert.equal(competing.primary.prepare("SELECT count(*) n FROM commerce_refunds").get().n,1);
  assert.equal(competing.primary.prepare("SELECT sum(amount_minor) n FROM commerce_refunds").get().n,1000);
  assert.equal(competingProviderCalls,1,"Only the atomically reserved refund may contact Stripe");
  console.log("PASS: original refund request resumes after owner outage using one persisted intent, original Stripe key, exact provider polling and request-bound replay");
  console.log("PASS: real paid-order revoke command owns exact D1 reconciliation, deny-first durable failure recovery, replay/collision/concurrency safety, strict receipts and disabled production refusal");
} finally {globalThis.fetch=originalFetch;for(const db of stores)db.close();rmSync(directory,{recursive:true,force:true});}
