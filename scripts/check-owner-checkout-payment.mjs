/* eslint-disable prettier/prettier -- Adversarial real-SQL checkout owner payment binding tests. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(join(tmpdir(),"cove-owner-checkout-binding-")),sql=new DatabaseSync(":memory:");
const previousFetch=globalThis.fetch;
try{
  const outfile=join(folder,"owner.mjs"),facadeFile=join(folder,"facade.mjs");
  await build({entryPoints:["src/storefront-strangler/checkout-payment-binding-owner-executor.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  await build({entryPoints:["src/storefront-strangler/owner-checkout-payment.server.ts"],
    outfile:facadeFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {executeOwnerCheckoutPaymentBinding:bind}=await import(pathToFileURL(outfile).href);
  const {attachStageOwnerCheckoutPayment:attach}=await import(pathToFileURL(facadeFile).href);
  sql.exec(`CREATE TABLE commerce_orders(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,quote_id TEXT,invoice_number TEXT,
    status TEXT,currency TEXT,stripe_due_minor INTEGER,capture_method TEXT,
    stripe_customer_id TEXT,stripe_payment_intent_id TEXT,updated_at TEXT);
    CREATE TABLE commerce_customers(user_id TEXT PRIMARY KEY,stripe_customer_id TEXT);
    CREATE TABLE commerce_checkout_quotes(id TEXT PRIMARY KEY,user_id TEXT,consumed_at TEXT,expires_at TEXT);
    CREATE TABLE commerce_order_items(id TEXT PRIMARY KEY,order_id TEXT);
    CREATE TABLE commerce_payment_attempts(
      id TEXT PRIMARY KEY,order_id TEXT,provider TEXT,provider_payment_id TEXT,
      status TEXT,amount_minor INTEGER,currency TEXT,provider_payload_json TEXT,
      created_at TEXT,updated_at TEXT);
  `);
  const orderId="ord_binding_qa_01",userId="user_binding_qa_01",
    paymentIntentId="pi_binding_qa_01",customerId="cus_binding_qa_01";
  const cmd={orderId,userId,paymentIntentId,customerId};
  sql.prepare("INSERT INTO commerce_orders(id,user_id,quote_id,invoice_number,status,currency,stripe_due_minor,capture_method) VALUES(?,?,?,'FORE-20261029-TEST','pending_payment','USD',1900,'automatic_async')")
    .run(orderId,userId,"quote_binding_qa_01");
  sql.prepare("INSERT INTO commerce_customers VALUES(?,?)").run(userId,customerId);
  sql.prepare("INSERT INTO commerce_checkout_quotes VALUES(?,?,?,?)")
    .run("quote_binding_qa_01",userId,new Date().toISOString(),new Date(Date.now()+86400000).toISOString());
  sql.prepare("INSERT INTO commerce_order_items VALUES(?,?)").run("oi_binding_qa_01",orderId);
  const db={prepare(query){return {bind(...args){return {
      async first(){return sql.prepare(query).get(...args)||null;},
      async all(){return {results:sql.prepare(query).all(...args)};},
      async run(){return {meta:{changes:sql.prepare(query).run(...args).changes}};}
    };}};},async batch(statements){
      sql.exec("BEGIN");try{const result=[];for(const stmt of statements)result.push(await stmt.run());
        sql.exec("COMMIT");return result;
      }catch(e){sql.exec("ROLLBACK");throw e;}
    }};
  const ownerEnv={PRIMARY_DB:db,STRIPE_SECRET_KEY:"sk_test_local_fixture",STRIPE_LIVEMODE:"false"};
  let stripe={object:"payment_intent",id:paymentIntentId,customer:customerId,livemode:false,
    amount:1900,currency:"usd",status:"requires_payment_method",capture_method:"automatic_async",
    payment_method_types:["card"],
    metadata:{fore_order_id:orderId,fore_user_id:userId,fore_invoice:"FORE-20261029-TEST"}};
  let hits=0;
  globalThis.fetch=async (url,options)=>{
    hits++;
    assert.equal(url,"https://api.stripe.com/v1/payment_intents/"+paymentIntentId);
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers.authorization,"Bearer "+ownerEnv.STRIPE_SECRET_KEY);
    return Response.json(stripe);
  };
  const first=await bind(ownerEnv,cmd);
  assert.equal(first.schema,"cove.owner-checkout-payment-binding.v1");
  assert.equal(first.applied,true);assert.equal(first.bound,true);
  assert.equal(sql.prepare("SELECT stripe_payment_intent_id FROM commerce_orders WHERE id=?").get(orderId).stripe_payment_intent_id,paymentIntentId);
  assert.equal(sql.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  const replay=await bind(ownerEnv,cmd);
  assert.equal(replay.applied,false,"Replay must not produce additional payment attempt rows");
  assert.equal(sql.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  for(const changes of [
    {amount:999},{customer:"cus_other_99"},{currency:"eur"},{livemode:true},
    {metadata:{...stripe.metadata,fore_user_id:"user_other_11"}},
    {capture_method:"manual"},{status:"canceled"}
  ]){
    const prior=stripe;stripe={...stripe,...changes};
    await assert.rejects(()=>bind(ownerEnv,cmd),/owner_checkout_provider_scope_mismatch/);
    stripe=prior;
  }
  await assert.rejects(()=>bind(ownerEnv,{...cmd,paymentIntentId:"pi_other_99999"}),
    /owner_checkout_order_scope_invalid/);
  await assert.rejects(()=>bind(ownerEnv,{...cmd,userId:"user_different_01"}));
  await assert.rejects(()=>bind(ownerEnv,{...cmd,sql:"UPDATE commerce_orders SET status='paid'"}));
  assert.equal(sql.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  assert.equal(hits>=9,true,"Every attempt is independently checked against Stripe");
  const stageEnv={
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_SSR_STAGING:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64),
    LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");
      return {fetch:async(request)=>{
        assert.equal(new URL(request.url).pathname,"/commercial/checkout/attach-payment-intent");
        assert.deepEqual(await request.json(),cmd);
        return Response.json(replay);
      }};
    }}
  };
  assert.deepEqual(await attach(stageEnv,cmd),replay);
  for(const overrides of [
    {COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},{COVE_SSR_STAGING:"0"},
    {COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_RIGHTS_OWNER_SECRET:"bad"},{LEGAL_AUTHORITY:null}
  ])await assert.rejects(()=>attach({...stageEnv,...overrides},cmd));
  await assert.rejects(()=>attach({...stageEnv,LEGAL_AUTHORITY:{getByName(){
    return {fetch:async()=>Response.json({...replay,orderId:"ord_other_qa_99"})};
  }}},cmd),/not acknowledged/);
  assert.equal(sql.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  console.log("PASS: owner independently verifies Stripe quote/order/customer/intent, atomically persists once, rejects replay forgery and stage outages");
}finally{globalThis.fetch=previousFetch;sql.close();rmSync(folder,{recursive:true,force:true});}
