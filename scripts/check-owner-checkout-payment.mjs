/* eslint-disable prettier/prettier -- Real private Durable Object + SQLite checkout binding tests. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(join(tmpdir(),"cove-owner-checkout-binding-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
const oldFetch=globalThis.fetch;
try{
  const workerFile=join(folder,"worker.mjs"),facadeFile=join(folder,"facade.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:workerFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"durable-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env){ this.ctx=ctx; this.env=env; } }"}));
    }}]});
  await build({entryPoints:["src/storefront-strangler/owner-checkout-payment.server.ts"],
    outfile:facadeFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {CoveLegalAuthority}=await import(pathToFileURL(workerFile).href);
  const {attachStageOwnerCheckoutPayment:attach}=await import(pathToFileURL(facadeFile).href);
  primary.exec(`CREATE TABLE commerce_orders(
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
  primary.prepare("INSERT INTO commerce_orders(id,user_id,quote_id,invoice_number,status,currency,stripe_due_minor,capture_method) VALUES(?,?,?,'FORE-20261029-TEST','pending_payment','USD',1900,'automatic_async')")
    .run(orderId,userId,"quote_binding_qa_01");
  primary.prepare("INSERT INTO commerce_customers VALUES(?,?)").run(userId,customerId);
  primary.prepare("INSERT INTO commerce_checkout_quotes VALUES(?,?,?,?)")
    .run("quote_binding_qa_01",userId,new Date().toISOString(),new Date(Date.now()+86400000).toISOString());
  primary.prepare("INSERT INTO commerce_order_items VALUES(?,?)").run("oi_binding_qa_01",orderId);
  const db={prepare(query){return {bind(...params){return {
      async first(){return primary.prepare(query).get(...params)||null;},
      async all(){return {results:primary.prepare(query).all(...params)};},
      async run(){return {meta:{changes:primary.prepare(query).run(...params).changes}};}
    };}};},async batch(statements){
      primary.exec("BEGIN");try{const out=[];for(const stmt of statements)out.push(await stmt.run());
        primary.exec("COMMIT");return out;
      }catch(error){primary.exec("ROLLBACK");throw error;}
    }};
  const storageSql={exec(query,...params){
    const statement=durable.prepare(query);
    const rows=statement.columns().length?statement.all(...params):
      (statement.run(...params),[]);
    return {toArray:()=>rows};
  }};
  const secret="a".repeat(64),ownerEnv={PRIMARY_DB:db,STRIPE_SECRET_KEY:"sk_test_local_fixture",
    STRIPE_LIVEMODE:"false",COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600_000),
    COVE_RIGHTS_OWNER_SECRET:secret};
  const owner=new CoveLegalAuthority({storage:{sql:storageSql,transactionSync(fn){
    durable.exec("BEGIN");try{const value=fn();durable.exec("COMMIT");return value;}
    catch(error){durable.exec("ROLLBACK");throw error;}
  }}},ownerEnv);
  const stage={COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_SSR_STAGING:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:ownerEnv.COVE_RIGHTS_OWNER_PRIMARY_ID,
    COVE_RIGHTS_OWNER_SECRET:secret,LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return owner;
    }}};
  let pi={object:"payment_intent",id:paymentIntentId,customer:customerId,livemode:false,
    amount:1900,currency:"usd",status:"requires_payment_method",capture_method:"automatic_async",
    payment_method_types:["card"],
    metadata:{fore_order_id:orderId,fore_user_id:userId,fore_invoice:"FORE-20261029-TEST"}};
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;
    assert.equal(url,"https://api.stripe.com/v1/payment_intents/"+paymentIntentId);
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers.authorization,"Bearer "+ownerEnv.STRIPE_SECRET_KEY);
    return Response.json(pi);
  };
  const first=await attach(stage,cmd);
  assert.equal(first.schema,"cove.owner-checkout-payment-binding.v1");
  assert.equal(first.applied,true);assert.equal(first.bound,true);
  assert.equal(primary.prepare("SELECT stripe_payment_intent_id FROM commerce_orders WHERE id=?").get(orderId).stripe_payment_intent_id,paymentIntentId);
  assert.equal(primary.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  const replay=await attach(stage,cmd);
  assert.equal(replay.applied,false,"Replay must not produce additional payment attempts");
  assert.equal(primary.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  for(const changes of [
    {amount:999},{customer:"cus_other_99"},{currency:"eur"},{livemode:true},
    {metadata:{...pi.metadata,fore_user_id:"user_other_11"}},
    {capture_method:"manual"},{status:"canceled"}
  ]){
    const prior=pi;pi={...pi,...changes};
    await assert.rejects(()=>attach(stage,cmd),/not acknowledged/);
    pi=prior;
  }
  await assert.rejects(()=>attach(stage,{...cmd,paymentIntentId:"pi_other_99999"}));
  await assert.rejects(()=>attach(stage,{...cmd,userId:"user_different_01"}));
  await assert.rejects(()=>attach(stage,{...cmd,sql:"UPDATE commerce_orders SET status='paid'"}));
  assert.equal(primary.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  assert.ok(calls>=9,"Each valid request triggers independent Stripe verification");
  for(const overrides of [
    {COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},{COVE_SSR_STAGING:"0"},
    {COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_RIGHTS_OWNER_SECRET:"invalid"},{LEGAL_AUTHORITY:null}
  ])await assert.rejects(()=>attach({...stage,...overrides},cmd));
  ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>attach(stage,cmd),/not acknowledged/);
  assert.equal(primary.prepare("SELECT count(*) n FROM commerce_payment_attempts").get().n,1);
  console.log("PASS: real owner validates checkout order and Stripe, atomically binds PI once, rejects forgery and disabled owner without D1 fallback");
}finally{globalThis.fetch=oldFetch;primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
