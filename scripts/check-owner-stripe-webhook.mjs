/* eslint-disable prettier/prettier -- Test actual private owner webhook lease against independent SQLite. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(join(tmpdir(),"cove-owner-webhook-"));
const dbs=[];
try{
  const workerFile=join(folder,"worker.mjs"),portFile=join(folder,"port.mjs"),stateFile=join(folder,"state.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:workerFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"durable-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env){ this.ctx=ctx; this.env=env; } }"}));
    }}]});
  await build({entryPoints:["src/storefront-strangler/owner-stripe-webhook.server.ts"],
    outfile:portFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  await build({entryPoints:["src/storefront-strangler/owner-stripe-payment-status.server.ts"],
    outfile:stateFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {CoveLegalAuthority}=await import(pathToFileURL(workerFile).href);
  const {claimStageOwnerStripeWebhook:claim,finishStageOwnerStripeWebhook:finish}=
    await import(pathToFileURL(portFile).href);
  const {updateStageOwnerPaymentState:updateState}=await import(pathToFileURL(stateFile).href);
  const secret="b".repeat(64);
  function fixture(){
    const primary=new DatabaseSync(":memory:"),owned=new DatabaseSync(":memory:");
    dbs.push(primary,owned);
    primary.exec(`CREATE TABLE commerce_webhook_events(
      provider_event_id TEXT PRIMARY KEY NOT NULL,event_type TEXT NOT NULL,
      livemode INTEGER NOT NULL,payload_sha256 TEXT NOT NULL,status TEXT NOT NULL,
      received_at TEXT NOT NULL,processing_token TEXT NOT NULL,
      processing_lease_until TEXT NOT NULL,error TEXT DEFAULT '',
      processed_at TEXT)`);
    primary.exec(`CREATE TABLE commerce_orders(
      id TEXT PRIMARY KEY,status TEXT NOT NULL,stripe_payment_intent_id TEXT,
      authorized_at TEXT,updated_at TEXT,canceled_at TEXT,
      failure_code TEXT,failure_message TEXT);
      CREATE TABLE commerce_balance_reservations(order_id TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE commerce_promo_redemptions(order_id TEXT,status TEXT,updated_at TEXT)`);
    const db={prepare(query){return {bind(...params){return {
      async first(){return primary.prepare(query).get(...params)||null;},
      async run(){return {meta:{changes:primary.prepare(query).run(...params).changes}};}
    };}};},async batch(statements){
      primary.exec("BEGIN");try{
        const result=[];for(const statement of statements)result.push(await statement.run());
        primary.exec("COMMIT");return result;
      }catch(error){primary.exec("ROLLBACK");throw error;}
    }};
    const sql={exec(query,...params){const statement=owned.prepare(query);
      const out=statement.columns().length?statement.all(...params):(statement.run(...params),[]);
      return {toArray:()=>out};}};
    const ownerEnv={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
      COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600_000),
      COVE_RIGHTS_OWNER_SECRET:secret};
    const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){
      owned.exec("BEGIN");try{const result=fn();owned.exec("COMMIT");return result;}
      catch(error){owned.exec("ROLLBACK");throw error;}
    }}},ownerEnv);
    const clientEnv={DB:db,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
      COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
      COVE_LEGAL_WRITER_PRIMARY_ID:ownerEnv.COVE_RIGHTS_OWNER_PRIMARY_ID,
      COVE_RIGHTS_OWNER_SECRET:secret,
      LEGAL_AUTHORITY:{getByName(n){assert.equal(n,"cove-staged-legal-global-v1");return owner;}}};
    return {primary,owned,ownerEnv,clientEnv,owner};
  }
  const f=fixture(),payloadSha256="3".repeat(64),
    base={eventId:"evt_verified_qa_01",eventType:"payment_intent.succeeded",payloadSha256,livemode:false};
  const first=await claim(f.clientEnv,base);
  assert.equal(first.claimed,true);
  assert.equal(first.duplicate,false);
  assert.match(first.token,/^[a-f0-9-]{36}$/);
  assert.equal(f.primary.prepare("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?")
    .get(base.eventId).status,"received");
  await assert.rejects(()=>claim(f.clientEnv,base),/Webhook owner could not claim/);
  await assert.rejects(()=>claim(f.clientEnv,{...base,payloadSha256:"4".repeat(64)}));
  await assert.rejects(()=>claim(f.clientEnv,{...base,eventType:"charge.refunded"}));
  await assert.rejects(()=>claim(f.clientEnv,{...base,livemode:true}));
  await assert.rejects(()=>claim(f.clientEnv,{...base,eventId:"evt_bad/../path"}));
  const finishBase={eventId:base.eventId,payloadSha256,token:first.token};
  await assert.rejects(()=>finish(f.clientEnv,{...finishBase,token:crypto.randomUUID(),outcome:"processed"}));
  await assert.rejects(()=>finish(f.clientEnv,{...finishBase,payloadSha256:"4".repeat(64),outcome:"processed"}));
  assert.equal(f.primary.prepare("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?").get(base.eventId).status,"received");
  await finish(f.clientEnv,{...finishBase,outcome:"failed"});
  assert.equal(f.primary.prepare("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?").get(base.eventId).status,"failed");
  const retry=await claim(f.clientEnv,base);
  assert.equal(retry.claimed,true);
  assert.notEqual(retry.token,first.token);
  await assert.rejects(()=>finish(f.clientEnv,{...finishBase,outcome:"processed"}));
  await finish(f.clientEnv,{...finishBase,token:retry.token,outcome:"processed"});
  const duplicate=await claim(f.clientEnv,base);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.token,null);
  await assert.rejects(()=>finish(f.clientEnv,{...finishBase,token:retry.token,outcome:"failed"}));
  assert.equal(f.primary.prepare("SELECT status FROM commerce_webhook_events WHERE provider_event_id=?").get(base.eventId).status,"processed",
    "Duplicate, failed and stale-owner completion cannot regress processed event");
  const isolated=fixture(),newEvent={...base,eventId:"evt_owner_outage_02"};
  for(const patch of [
    {COVE_SSR_STAGING:"0"},{COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},
    {COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_RIGHTS_OWNER_SECRET:"forged"}
  ])await assert.rejects(()=>claim({...isolated.clientEnv,...patch},newEvent));
  isolated.ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>claim(isolated.clientEnv,newEvent));
  assert.equal(isolated.primary.prepare("SELECT count(*) n FROM commerce_webhook_events").get().n,0,
    "Disabled owner cannot cause a caller-owned webhook claim or side effect");
  const wrongResponse={...f.clientEnv,LEGAL_AUTHORITY:{getByName(){return {
    fetch:async()=>Response.json({schema:"cove.owner-webhook-claim.v1",
      eventId:base.eventId,payloadSha256,claimed:true,duplicate:false,token:null})
  };}}};
  await assert.rejects(()=>claim(wrongResponse,newEvent),
    /Webhook owner could not claim/);
  // Payment status transitions use the same private owner, with exact
  // canonical payment intent linkage and immutable paid-order denial.
  const payment=fixture(),orderId="order_owner_payment_01",paymentIntentId="pi_owner_payment_01";
  payment.primary.prepare("INSERT INTO commerce_orders(id,status,stripe_payment_intent_id) VALUES(?,'pending_payment',?)")
    .run(orderId,paymentIntentId);
  payment.primary.prepare("INSERT INTO commerce_balance_reservations VALUES(?,'reserved',NULL)").run(orderId);
  payment.primary.prepare("INSERT INTO commerce_promo_redemptions VALUES(?,'reserved',NULL)").run(orderId);
  const command={orderId,paymentIntentId,failureCode:null};
  await assert.rejects(()=>updateState(payment.clientEnv,{...command,state:"canceled",paymentIntentId:"pi_other_12345"}));
  assert.equal(payment.primary.prepare("SELECT status FROM commerce_orders WHERE id=?").get(orderId).status,"pending_payment");
  assert.equal((await updateState(payment.clientEnv,{...command,state:"processing"})).applied,true);
  assert.equal((await updateState(payment.clientEnv,{...command,state:"authorized"})).applied,true);
  assert.equal((await updateState(payment.clientEnv,{...command,state:"payment_failed",failureCode:"insufficient_funds"})).applied,true);
  assert.equal(payment.primary.prepare("SELECT failure_code FROM commerce_orders WHERE id=?").get(orderId).failure_code,"insufficient_funds");
  assert.equal((await updateState(payment.clientEnv,{...command,state:"canceled"})).applied,true);
  assert.equal(payment.primary.prepare("SELECT status FROM commerce_orders WHERE id=?").get(orderId).status,"canceled");
  assert.equal(payment.primary.prepare("SELECT status FROM commerce_balance_reservations").get().status,"released");
  assert.equal(payment.primary.prepare("SELECT status FROM commerce_promo_redemptions").get().status,"released");
  assert.equal((await updateState(payment.clientEnv,{...command,state:"canceled"})).applied,false);
  assert.equal((await updateState(payment.clientEnv,{...command,state:"authorized"})).applied,false);
  await assert.rejects(()=>updateState(payment.clientEnv,{...command,state:"processing",failureCode:"forged"}));
  payment.primary.prepare("INSERT INTO commerce_orders(id,status,stripe_payment_intent_id) VALUES('order_paid_01','paid','pi_paid_01')").run();
  const paid={orderId:"order_paid_01",paymentIntentId:"pi_paid_01",failureCode:null};
  assert.equal((await updateState(payment.clientEnv,{...paid,state:"canceled"})).applied,false,
    "A stale cancellation must not revert a paid order or release its tender");
  assert.equal((await updateState(payment.clientEnv,{...paid,state:"processing"})).applied,false);
  assert.equal(payment.primary.prepare("SELECT status FROM commerce_orders WHERE id='order_paid_01'").get().status,"paid");
  payment.ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>updateState(payment.clientEnv,{...command,state:"processing"}));
  console.log("PASS: owner payment transitions validate exact PI, preserve paid terminal states, atomically cancel and release tender, fail closed without owner");
  console.log("PASS: signed-event journal owner enforces scoped claim, active lease, immutable hash/mode, replay, stale token and outage-deny");
}finally{for(const x of dbs)x.close();rmSync(folder,{recursive:true,force:true});}
