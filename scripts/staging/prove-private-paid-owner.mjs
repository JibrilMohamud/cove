/* eslint-disable prettier/prettier -- Ephemeral private paid-owner proof; never route production or trust caller price. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes,createHash,generateKeyPairSync} from "node:crypto";
import {pathToFileURL} from "node:url";
import {isPaidOwnerQaSchemaTable} from "./paid-owner-schema-policy.mjs";
import {provisionPublishedQaAudio} from "./provision-original-audio-qa.mjs";
import JSZip from "jszip";
import {build} from "esbuild";
import {spawnSync,spawn} from "node:child_process";
import {createServer} from "node:http";

// A GitHub Actions rerun reuses GITHUB_RUN_ID. Isolate fresh synthetic
// payments, owners and order idempotency keys by the actual attempt as well.
// Never reuse a prior attempt's potentially paid or refunded QA order.
const runId=process.env.GITHUB_RUN_ID+"-"+(process.env.GITHUB_RUN_ATTEMPT||"1");
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.match(runId||"",/^\d{8,15}-\d{1,5}$/);
assert.match(account||"",/^[a-f0-9]{32}$/);
assert.ok(token,"Cloudflare QA authorization required");
const stripeSecret=process.env.COVE_SANDBOX_SECRET_KEY||"";
assert.match(stripeSecret,/^(?:sk|rk|rkcs)_test_[A-Za-z0-9]+$/,"Independent owner requires a real TEST Stripe credential");
const interruptTrigger="qa_settlement_interrupt_"+runId.replaceAll("-","_");
let interruptTriggerCreated=false;
const ownerName="cove-paid-legal-owner-"+runId;
const callerName="cove-paid-legal-caller-"+runId;
const writerName="cove-paid-legal-writer-"+runId;
const settlementName="cove-paid-settlement-qa-"+runId;
const mediaBucketName="cove-paid-private-media-qa-"+runId;
const settlementOrigin="https://"+settlementName+".cove-jibrilmohamud.workers.dev";
const origin="https://"+callerName+".cove-jibrilmohamud.workers.dev";
const primary="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const primaryName="cove-paid-commerce-legal-qa-20261027";
const gate=randomBytes(32).toString("hex");
const secret=randomBytes(32).toString("hex");
const writerSecret=randomBytes(32).toString("hex");
let expires=Date.now()+12*60_000;
const temp=fs.mkdtempSync(path.join(process.cwd(),".cove-paid-proof-"));
const ownerCfg=path.join(process.cwd(),".cove-paid-owner-proof-"+runId+".jsonc");
const callerCfg=path.join(process.cwd(),".cove-paid-caller-proof-"+runId+".jsonc");
const writerCfg=path.join(process.cwd(),".cove-paid-writer-proof-"+runId+".jsonc");
const settlementCfg=path.join(process.cwd(),".cove-paid-settlement-proof-"+runId+".jsonc");
const test={
  productId:"prd_paid_qa_20261027",
  entitlementId:"ent_paid_qa_20261027",
  userId:"user_paid_qa_20261027",
  orderId:"order_paid_qa_20261027",
};
const cli=(args)=>{
  const result=spawnSync("npm",["exec","--yes","--package=wrangler@4.151.0","--","wrangler",...args],{
    encoding:"utf8",timeout:160000,env:{...process.env,CLOUDFLARE_SEND_METRICS:"false"}
  });
  if(result.status!==0)throw Error("wrangler_"+args[0]+"_failed "+
    String(result.stderr||"").replace(/Bearer\s+\S+/g,"Bearer [redacted]").slice(-450));
};
const api=async(method,resource,body)=>{
  const r=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+resource,{
    method,headers:{authorization:"Bearer "+token,
      "content-type":"application/json"},
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(18000)
  });
  const j=await r.json().catch(()=>null);
  if(!r.ok||!j?.success)throw Error("Cloudflare control plane "+method+" "+r.status+" "+JSON.stringify((j?.errors||[]).map(e=>({code:e.code,message:String(e.message).slice(0,220)}))).slice(0,400));
  return j.result;
};
const deploy=async(file,secrets)=>{
  const keyfile=path.join(temp,path.basename(file)+".secrets.json");
  fs.writeFileSync(keyfile,JSON.stringify(secrets),{mode:0o600});
  try {
    for(let attempt=1;attempt<=3;attempt++){
      try {
        cli(["deploy","--config",file,"--secrets-file",keyfile]);
        return;
      }catch(e){
        // Cloudflare's Worker versions API briefly returns 10007 for a
        // brand-new script immediately after creation. Retry ONLY this
        // pre-traffic provisioning race, never a paid owner mutation.
        if(attempt===3||!/Worker does not exist|code:\s*10007/i.test(String(e)))throw e;
        console.warn("QA Worker provisioning delayed (10007); retry "+attempt);
        await new Promise(r=>setTimeout(r,1500*attempt));
      }
    }
  }finally { fs.rmSync(keyfile,{force:true}); }
};
const qaSql=async(sql,params=[])=>{
  const results=await api("POST","/d1/database/"+primary+"/query",{sql,params});
  assert.equal(results?.[0]?.success,true,"Only the dedicated synthetic legal QA D1 may be used");
  return results[0];
};
/**
 * QA ONLY: copy schema, never rows, from the separate synthetic catalog
 * acceptance D1 into the isolated paid legal QA primary. The paid fixture
 * formerly had only 45 tables, which prevented a first Stripe settlement:
 * no ledger, royalties, outbox, retail events or reader state schema.
 * This is a strict source/destination allowlist; never use a production D1.
 */
const schemaSource="e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
async function prepareInitialCommerceQaSchema(){
  const records=await api("POST","/d1/database/"+schemaSource+"/query",{
    sql:"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name"
  });
  assert.equal(records?.[0]?.success,true);
  const present=(await qaSql("SELECT type,name FROM sqlite_master WHERE type IN ('table','index')")).results;
  const existing=new Set(present.map(x=>x.type+":"+x.name));
  const allowed=isPaidOwnerQaSchemaTable;
  const targetTables=new Set(records[0].results
    .filter(x=>x.type==="table"&&allowed(x.name)&&!x.name.startsWith("sqlite_"))
    .map(x=>x.name));
  assert.ok(targetTables.has("commerce_ledger_entries") &&
    targetTables.has("publishing_outbox") &&
    targetTables.has("royalty_holds") &&
    targetTables.has("reading_states"),"Synthetic schema source missing real payment dependencies");
  let installed=0;
  for(const row of records[0].results){
    if(row.type==="table"&&!targetTables.has(row.name))continue;
    if(row.type==="index"&&!targetTables.has(row.tbl_name))continue;
    if(existing.has(row.type+":"+row.name))continue;
    // Schema source is a pinned synthetic Cloudflare fixture, not user SQL.
    // Never import source rows or execute arbitrary statements.
    assert.match(row.sql,/^CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s/i);
    assert.ok(row.sql.length<20000);
    await qaSql(row.sql);
    installed++;
  }
  // Apply the exact new recovery schema ONLY to this fixed, distinct QA D1.
  const settlementDdl=fs.readFileSync("drizzle/0089_atomic_paid_settlement.sql","utf8").replace(/--[^\n]*/g,"");
  for(const statement of settlementDdl.split(";").map(x=>x.trim()).filter(Boolean))await qaSql(statement);
  console.log("QA schema-only dependencies ready: "+installed+" missing tables/indexes added");
}
const initialOrder="order_initial_qa_"+runId;
const initialBuyer="user_initial_qa_"+runId;
const initialItem="item_initial_qa_"+runId;
async function seedInitialPendingOrder(){
  const quote=name=>'"'+name.replaceAll('"','""')+'"';
  async function clone(table,sourceId,sourceKey,overrides){
    const columns=(await qaSql("PRAGMA table_info("+table+")")).results.map(x=>x.name);
    assert.ok(columns.length>5&&columns.includes(sourceKey));
    const replacements=Object.keys(overrides);
    for(const key of replacements)assert.ok(columns.includes(key),table+" missing "+key);
    const expressions=columns.map(name=>
      Object.hasOwn(overrides,name)?"?":quote(name));
    const params=columns.filter(name=>Object.hasOwn(overrides,name))
      .map(name=>overrides[name]);
    const result=await qaSql(
      "INSERT INTO "+table+"("+columns.map(quote).join(",")+") SELECT "+
      expressions.join(",")+" FROM "+table+" WHERE "+quote(sourceKey)+"=?",
      [...params,sourceId]
    );
    assert.equal(result.meta?.changes,1,table+" initial transaction clone failed");
  }
  await clone("commerce_orders",test.orderId,"id",{
    id:initialOrder,user_id:initialBuyer,
    invoice_number:"QA-"+runId,idempotency_key:"qa:initial:"+runId,
    status:"pending_payment",
    stripe_payment_intent_id:null,stripe_charge_id:null,
    receipt_url:null,paid_at:null
  });
  const sourceLines=(await qaSql(
    "SELECT id FROM commerce_order_items WHERE order_id=? ORDER BY id LIMIT 2",
    [test.orderId]
  )).results;
  assert.equal(sourceLines.length,1,
    "Synthetic QA source must have exactly one immutable purchase line");
  await clone("commerce_order_items",sourceLines[0].id,"id",{
    id:initialItem,order_id:initialOrder,
    entitlement_status:"pending",fulfillment_status:"pending"
  });
  const state=await qaSql(
    "SELECT status,stripe_due_minor,currency FROM commerce_orders WHERE id=?",
    [initialOrder]);
  assert.deepEqual(state.results?.[0],
    {status:"pending_payment",stripe_due_minor:399,currency:"USD"});
  const line=await qaSql(
    "SELECT id,product_id,rights_snapshot_json FROM commerce_order_items WHERE id=?",
    [initialItem]);
  assert.equal(line.results?.[0]?.product_id,test.productId);
  assert.ok(line.results?.[0]?.rights_snapshot_json,
    "Pending order must preserve the original exact purchased legal scope");
}

const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const post=async(route,body)=>{
  const response=await fetch(origin+route,{
    method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+gate},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12000)
  });
  return {status:response.status,body:response.status===200?await response.json():null,
    ray:response.headers.get("cf-ray"),
    unavailableLayer:response.headers.get("x-cove-qa-unavailable-layer")};
};
const read=async(route,body)=>{
  let result;
  for(let i=0;i<10;i++){
    try {result=await post(route,body);}
    catch(e){if(i===9)throw e;await pause(800);continue;}
    if(result.status===200||![404,503].includes(result.status))return result;
    if(i<9)await pause(800);
  }
  return result;
};
// During initial deployment, Workers metadata can be visible before the
// per-colo route/service-binding/DO activation has propagated. This bounded
// readiness probe is NOT a paid owner mutation and NOT a latency benchmark.
// Count every HTTP 500, 404 and 503; require an exact positive 200/read result
// before issuing ANY irreversible legal publication request.
const verifySecrets=async(name,keys)=>{
  let present=[];
  for(let i=0;i<8;i++){
    const config=await api("GET","/workers/scripts/"+name+"/settings");
    present=(config?.bindings||[]).filter(x=>x.type==="secret_text").map(x=>x.name);
    if(keys.every(x=>present.includes(x)))return;
    await pause(700);
  }
  throw Error("private_paid_qa_secret_binding_not_ready:"+
    keys.filter(x=>!present.includes(x)).join(","));
};
const readyOwner=async()=>{
  const statusCounts=new Map();
  const input={ids:[test.productId],territory:"US",channel:"retail"};
  // Budget 48s for propagation, independently of the 12-minute expiry.
  for(let i=0;i<24;i++){
    await pause(2000);
    try{
      const result=await post("/commercial/authorize-batch",input);
      if(result.status===200){
        assert.deepEqual(result.body,{schema:"cove.commercial-legal.v1",rows:[]},
          "New DO must start without a fabricated paid grant");
        if(statusCounts.size)console.log("QA provisioning preflight recovered: "+
          JSON.stringify(Object.fromEntries(statusCounts)));
        return;
      }
      const key="HTTP_"+result.status;
      statusCounts.set(key,(statusCounts.get(key)||0)+1);
      // A non-transient 4xx signals a broken contract/authorization, not
      // Workers route propagation. Never turn it into a green QA run.
      if(![404,500,502,503,504].includes(result.status))break;
    }catch(e){
      const key="NETWORK_"+(e instanceof Error?e.name:"unknown");
      statusCounts.set(key,(statusCounts.get(key)||0)+1);
    }
  }
  throw Error("paid_owner_readiness_failed:"+JSON.stringify(Object.fromEntries(statusCounts)));
};
const assertNoRoute=(config)=>{
  assert.equal(config.workers_dev,false);
  assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);
  assert.equal(config.d1_databases?.[0]?.database_id,primary);
  assert.equal(config.d1_databases?.[0]?.database_name,primaryName);
  assert.equal(config.vars?.COVE_RIGHTS_OWNER_ENABLED,"0");
};
let ownerCreated=false,callerCreated=false,writerCreated=false,settlementCreated=false;
let cleanupError=null,listener=null,webhookServer=null,webhookSigningSecret="";
let paymentIntentId=null,initialPaymentIntentId=null,mediaBucketCreated=false;
let matchedPackets=[],initialOutageInjected=false;
const until=async(check,label,ms=45000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){
    const result=await check();
    if(result)return result;
    await pause(250);
  }
  throw Error("qa_signed_stripe_"+label+"_timeout");
};
const stripeRequest=async(route,body)=>{
  const key=process.env.COVE_SANDBOX_SECRET_KEY||"";
  assert.match(key,/^(?:sk|rk|rkcs)_test_[A-Za-z0-9]+$/,"Only Stripe sandbox credentials may be used");
  const response=await fetch("https://api.stripe.com/v1/"+route,{
    method:"POST",headers:{authorization:"Bearer "+key,
      "content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(body),signal:AbortSignal.timeout(20000)
  });
  const result=await response.json();
  assert.equal(response.status,200,
    "Stripe TEST API rejected isolated purchase: "+String(result?.error?.code||response.status));
  if(route.startsWith("payment_intents"))
    assert.equal(result.livemode,false,"Never exercise live Stripe payments in QA");
  else
    assert.ok(result.livemode===undefined||result.livemode===false,
      "Provider refund must never be in live mode");
  return result;
};
try {
  await prepareInitialCommerceQaSchema();
  await seedInitialPendingOrder();
  // Schema-only bootstrap can take minutes; the *authorization* lifetime
  // begins only after staging data is ready, not during isolated DDL.
  expires=Date.now()+12*60_000;
  const original=JSON.parse(fs.readFileSync("wrangler.legal-paid-authority.example.jsonc","utf8"));
  assertNoRoute(original);
  original.name=ownerName;
  original.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  original.vars.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=String(expires);
  original.vars.STRIPE_LIVEMODE="false";
  original.vars.STRIPE_TAX_ENABLED="false";
  fs.writeFileSync(ownerCfg,JSON.stringify(original));
  ownerCreated=true;
  await deploy(ownerCfg,{COVE_RIGHTS_OWNER_SECRET:secret,STRIPE_SECRET_KEY:stripeSecret});
  await verifySecrets(ownerName,["COVE_RIGHTS_OWNER_SECRET","STRIPE_SECRET_KEY"]);
  const writer=JSON.parse(fs.readFileSync(
    "wrangler.legal-paid-writer.example.jsonc","utf8"));
  assert.equal(writer.workers_dev,false);
  assert.deepEqual(writer.routes,[]);
  assert.equal(writer.d1_databases?.[0]?.database_id,primary);
  assert.equal(writer.vars?.COVE_LEGAL_WRITER_ENABLED,"0");
  assert.equal(writer.services?.[0]?.service,"cove-paid-legal-authority-qa");
  writer.name=writerName;
  writer.services[0].service=ownerName;
  writer.vars.COVE_LEGAL_WRITER_ENABLED="1";
  writer.vars.COVE_LEGAL_WRITER_EXPIRES_AT=String(expires);
  fs.writeFileSync(writerCfg,JSON.stringify(writer));
  writerCreated=true;
  await deploy(writerCfg,{
    COVE_LEGAL_WRITER_SECRET:writerSecret,COVE_RIGHTS_OWNER_SECRET:secret
  });
  await verifySecrets(writerName,["COVE_LEGAL_WRITER_SECRET","COVE_RIGHTS_OWNER_SECRET"]);
  const caller=JSON.parse(fs.readFileSync("wrangler.legal-paid-caller.example.jsonc","utf8"));
  assert.equal(caller.workers_dev,false);
  assert.deepEqual(caller.routes,[]);
  assert.equal(caller.services?.[0]?.service,"cove-paid-legal-authority-qa");
  caller.name=callerName;
  caller.workers_dev=true;
  caller.services[0].service=ownerName;
  caller.services.push({binding:"LEGAL_WRITER",service:writerName});
  caller.vars.COVE_LEGAL_QA_CALLER_ENABLED="1";
  caller.vars.COVE_LEGAL_QA_EXPIRES_AT=String(expires);
  fs.writeFileSync(callerCfg,JSON.stringify(caller));
  callerCreated=true;
  await deploy(callerCfg,{COVE_LEGAL_QA_GATE:gate,COVE_RIGHTS_OWNER_SECRET:secret,
    COVE_LEGAL_WRITER_SECRET:writerSecret});
  await verifySecrets(callerName,["COVE_LEGAL_QA_GATE","COVE_RIGHTS_OWNER_SECRET",
    "COVE_LEGAL_WRITER_SECRET"]);
  await readyOwner();
  // Confirm the *writer* route has propagated independently of the owner read
  // route. An empty JSON object is rejected by the writer's validation before
  // any owner call or D1 mutation; only HTTP 400 proves this path is live.
  // A later positive publication uses one immutable operation ID. Retry only\n  // HTTP 404 (route not yet installed in a different colo), never ambiguous\n  // 500/503, network errors or a rejected canonical/owner receipt.
  let writerReady=false;
  const writerReadinessStatuses=new Map();
  for(let attempt=0;attempt<24;attempt++){
    const probe=await post("/commercial/retail/publish-verified",{});
    if(probe.status===400){writerReady=true;break;}
    const key="HTTP_"+probe.status;
    writerReadinessStatuses.set(key,(writerReadinessStatuses.get(key)||0)+1);
    if(![404,503].includes(probe.status))
      throw Error("paid_writer_readiness_unexpected_status:"+probe.status);
    await pause(1500);
  }
  assert.equal(writerReady,true,"paid_writer_route_unavailable:"+
    JSON.stringify(Object.fromEntries(writerReadinessStatuses)));
  if(writerReadinessStatuses.size)
    console.log("QA writer routing preflight recovered: "+
      JSON.stringify(Object.fromEntries(writerReadinessStatuses)));
  // The private writer below intentionally reconciles the synthetic buyer
  // entitlement to 'revoked'. Recover only this exact test identity from a
  // prior interrupted run; never write the capacity or customer database.
  const restored=await qaSql(
    "UPDATE entitlements SET status='active' WHERE id=? AND user_id=? AND product_id=? AND source='commerce' AND entitlement_type='purchase' AND status='revoked'",
    [test.entitlementId,test.userId,test.productId]
  );
  assert.ok(Number.isInteger(restored.meta?.changes));
  // Real canonical D1 rights evaluation. No fabricated grant/contract IDs
  // accepted from the caller; strong owner verifies them itself before ACK.
  // Explicit private writer owns both positive rights and matching retail
  // offer publication. Direct public caller-to-owner positive grant would
  // bypass the canonical publisher integration this QA is meant to certify.
  const publication={
    productId:test.productId,territory:"US",currency:"USD",
    operationId:"qa:"+runId+":positive-retail-publication"
  };
  let publish=await post("/commercial/retail/publish-verified",publication);
  const publication404=[];
  for(let attempt=1;publish.status===404&&attempt<5;attempt++){
    publication404.push(publish.ray||"no-ray");
    await pause(1500);
    // A 404 cannot come from an accepted retail publication command: the
    // exact writer route returns 200, 400, 405 or 503. Reuse immutable ID.
    publish=await post("/commercial/retail/publish-verified",publication);
  }
  if(publication404.length)
    console.warn("QA retail writer route propagation: "+publication404.length+
      " non-mutating HTTP 404 responses before final status "+publish.status);
  assert.equal(publish.status,200,"Private positive canonical retail writer unavailable "+
    JSON.stringify({status:publish.status,ray:publish.ray,layer:publish.unavailableLayer}));
  assert.equal(publish.body?.published,true);
  assert.ok(Number.isSafeInteger(publish.body?.ownerEpoch)&&publish.body.ownerEpoch>0);
  const rights=await read("/commercial/authorize-batch",{
    ids:[test.productId],territory:"US",channel:"retail"
  });
  assert.equal(rights.body?.rows?.length,1,"Owner failed to store paid grant");
  assert.equal(rights.body.rows[0].grant_id,"rgrant_paid_qa_20261027");
  assert.equal(rights.body.rows[0].contract_version_id,"rcv_paid_qa_20261027");
  // Positive price publication is a distinct canonical D1 check. A rights
  // grant cannot fabricate a paid retail offer or change its currency.
  // The previously verified private writer must already have published the
  // exact price. Read through owner without a second positive publication.
  const shelf=await read("/storefront/authorize-batch",{
    ids:[test.productId],territory:"US",currency:"USD"
  });
  assert.equal(shelf.body?.schema,"cove.storefront-owner.v1");
  assert.equal(shelf.body?.rows?.length,1,"Owner rejected verified retail book");
  assert.equal(shelf.body.rows[0].product_id,test.productId);
  const displayOffer=JSON.parse(shelf.body.rows[0].offer_json);
  assert.equal(displayOffer.currency,"USD");
  assert.equal(displayOffer.amountMinor,399);
  const wrongCurrency=await read("/storefront/authorize-batch",{
    ids:[test.productId],territory:"US",currency:"EUR"
  });
  assert.deepEqual(wrongCurrency.body?.rows,[],"Currency cannot inherit a USD proof");
  const wrongRegion=await read("/commercial/authorize-batch",{
    ids:[test.productId],territory:"CA",channel:"retail"
  });
  assert.deepEqual(wrongRegion.body?.rows,[],"Territory isolation required");
  // Certified payment publication must flow through Cove's actual stage
  // settlement function, not only a direct test POST to the DO. This Worker
  // can operate on ONLY the fixed synthetic buyer and order in the separate
  // canonical paid QA D1. It has an expiring gate and no customer routing.
  // The test charge originates in a genuine Stripe TEST account. The
  // official CLI signs its webhook, which this local relay forwards with the
  // original bytes to the *deployed* staged Cove stripeWebhook implementation.
  // This QA fixture is already canonically paid: the signed event proves the
  // paid-webhook-to-owner recovery branch, not initial ledger settlement.
  assert.match(stripeSecret,/^(?:sk|rk|rkcs)_test_[A-Za-z0-9]+$/,
    "Full-schema paid owner requires real TEST Stripe credential for signed event");
  webhookServer=createServer(async(req,res)=>{
    try{
      let raw="";
      for await(const chunk of req){
        raw+=chunk.toString();
        if(raw.length>20000)throw Error("oversized_qa_stripe_event");
      }
      const event=JSON.parse(raw);
      if(event?.type!=="payment_intent.succeeded" ||
         ![test.orderId,initialOrder].includes(
           event?.data?.object?.metadata?.fore_order_id)){
        res.writeHead(200);res.end("ignored");return;
      }
      const isInitial=event.data.object.metadata.fore_order_id===initialOrder;
      const fault=isInitial&&!initialOutageInjected;
      if(fault)initialOutageInjected=true;
      const response=await fetch(settlementOrigin+"/signed-stripe-settlement",{
        method:"POST",headers:{"content-type":"application/json",
          "stripe-signature":String(req.headers["stripe-signature"]||""),
          authorization:"Bearer "+gate,
          ...(fault?{"x-cove-qa-interrupt-postpaid":"1"}:{})},
        body:raw,signal:AbortSignal.timeout(15000)
      });
      const content=await response.json().catch(()=>null);
      matchedPackets.push({eventId:event.id,status:response.status,body:content,raw,
        signature:String(req.headers["stripe-signature"]||"")});
      res.writeHead(response.status,{"content-type":"application/json"});
      res.end(JSON.stringify(content||{ok:false}));
    }catch{
      res.writeHead(503);res.end("{}");
    }
  });
  await new Promise(resolve=>webhookServer.listen(0,"127.0.0.1",resolve));
  const localWebhook="http://127.0.0.1:"+webhookServer.address().port+"/stripe";
  listener=spawn("stripe",["listen","--events","payment_intent.succeeded",
    "--forward-to",localWebhook],{
    env:{...process.env,STRIPE_API_KEY:stripeSecret},
    detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]
  });
  let output="";
  for(const stream of [listener.stdout,listener.stderr])
    stream.on("data",chunk=>{
      output+=chunk.toString().slice(0,2000);
      const match=/whsec_[A-Za-z0-9]+/.exec(output);
      if(match)webhookSigningSecret=match[0];
      if(output.length>6000)output=output.slice(-3000);
    });
  listener.on("error",()=>{});
  await until(()=>webhookSigningSecret,"listener_ready");
  // Only isolated QA canonical D1 receives this durable dedupe table.
  // Real production event storage and canonical settlement are not touched.
  await qaSql(`CREATE TABLE IF NOT EXISTS commerce_webhook_events (
    provider_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,livemode INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,status TEXT NOT NULL,
    received_at TEXT NOT NULL,processing_token TEXT,
    processing_lease_until TEXT,processed_at TEXT,error TEXT
  )`);
  // A separate, ephemeral R2 bucket proves actual stored binary bytes.
  // Its two ORIGINAL, generated fixture files are not customer content,
  // never uploaded to production storage or CDN.
  const zip=new JSZip();
  zip.file("mimetype","application/epub+zip",{compression:"STORE"});
  zip.file("META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file("OEBPS/content.opf",
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">cove-qa-original</dc:identifier><dc:title>Private Rights Fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-27T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file("OEBPS/chapter.xhtml",
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>QA</title></head><body><p>Owner-controlled original QA chapter.</p></body></html>');
  const epubBytes=await zip.generateAsync({
    type:"nodebuffer",compression:"DEFLATE",mimeType:"application/epub+zip"
  });
  const audioBytes=Buffer.alloc(44+8000*2);
  audioBytes.write("RIFF",0);audioBytes.writeUInt32LE(audioBytes.length-8,4);
  audioBytes.write("WAVEfmt ",8);audioBytes.writeUInt32LE(16,16);
  audioBytes.writeUInt16LE(1,20);audioBytes.writeUInt16LE(1,22);
  audioBytes.writeUInt32LE(8000,24);audioBytes.writeUInt32LE(16000,28);
  audioBytes.writeUInt16LE(2,32);audioBytes.writeUInt16LE(16,34);
  audioBytes.write("data",36);audioBytes.writeUInt32LE(audioBytes.length-44,40);
  const epubFile=path.join(temp,"qa-book.epub"),
    audioFile=path.join(temp,"qa-chapter.wav");
  fs.writeFileSync(epubFile,epubBytes,{mode:0o600});
  fs.writeFileSync(audioFile,audioBytes,{mode:0o600});
  cli(["r2","bucket","create",mediaBucketName]);
  mediaBucketCreated=true;
  cli(["r2","object","put",mediaBucketName+"/qa/book.epub",
    "--file",epubFile,"--remote"]);
  cli(["r2","object","put",mediaBucketName+"/qa/chapter.wav",
    "--file",audioFile,"--remote"]);
  const rightsBytes=Buffer.from(
    "This recording is generated synthetic silence for the isolated Cove QA campaign "+runId+
    ". No outside recording, narrator or publication rights are claimed.\n","utf8"
  );
  const rightsFile=path.join(temp,"qa-rights.txt");
  fs.writeFileSync(rightsFile,rightsBytes,{mode:0o600});
  cli(["r2","object","put",mediaBucketName+"/qa/rights.txt",
    "--file",rightsFile,"--remote"]);
  const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
  const epubSha=digest(epubBytes),audioSha=digest(audioBytes);
  // The ORIGINAL delivery service resolves the buyer's real canonical
  // product/edition/asset, rights snapshot, device and per-entitlement
  // download policy. These rows are synthetic, fixed to this run and do not
  // modify real catalog products or other customers.
  const product=(await qaSql(
    "SELECT id,edition_id FROM products WHERE id=?",
    [test.productId]
  )).results?.[0];
  assert.equal(product?.id,test.productId);
  const existingEpub=(await qaSql(
    "SELECT id FROM digital_assets WHERE edition_id=? AND kind='epub' LIMIT 1",
    [product.edition_id]
  )).results;
  // An earlier successful synthetic campaign may have left its QA-only asset
  // referenced by a historic test grant. Preserve that foreign-key chain
  // and append a new immutable asset version, never replace real catalog.
  const priorAsset=existingEpub?.[0]?.id;
  if(priorAsset)assert.match(priorAsset,/^qa_epub_asset_[0-9]{8,15}(?:-[0-9]{1,5})?$/,
    "Original route cannot mutate a non-synthetic edition asset");
  const runAsset=priorAsset||"qa_epub_asset_"+runId;
  const runVersion="qa_epub_version_"+runId;
  const nowSql=new Date().toISOString();
  if(!priorAsset){
    await qaSql(
      "INSERT INTO digital_assets(id,edition_id,kind,current_version_id,drm_status,downloadable,created_at,updated_at) VALUES(?,?,'epub',?,'none',1,?,?)",
      [runAsset,product.edition_id,runVersion,nowSql,nowSql]
    );
  }
  const latest=priorAsset?(await qaSql(
    "SELECT COALESCE(MAX(version_number),0) n FROM asset_versions WHERE asset_id=?",
    [runAsset]
  )).results[0]?.n:0;
  await qaSql(
    "INSERT INTO asset_versions(id,asset_id,version_number,object_key,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,'application/epub+zip',?,?,?)",
    [runVersion,runAsset,Number(latest)+1,"qa/book.epub",epubBytes.length,epubSha,nowSql]
  );
  if(priorAsset)await qaSql(
    "UPDATE digital_assets SET current_version_id=?,updated_at=? WHERE id=?",
    [runVersion,nowSql,runAsset]
  );
  const qaDeviceId="device_paid_qa_"+runId;
  const qaDeviceKey="device-qa-"+runId+"-registered";
  await qaSql(
    "INSERT INTO devices(id,user_id,device_key,name,platform,last_seen_at,created_at) VALUES(?,?,?,'Isolated QA EPUB reader','qa',?,?)",
    [qaDeviceId,initialBuyer,qaDeviceKey,nowSql,nowSql]
  );
  const oldPolicy=(await qaSql(
    "SELECT require_device_registration,allow_file_download FROM commercial_delivery_policies WHERE product_id=?",
    [test.productId]
  )).results;
  if(oldPolicy?.length){
    assert.equal(oldPolicy[0].require_device_registration,1);
    assert.equal(oldPolicy[0].allow_file_download,1);
  }else await qaSql(
    "INSERT INTO commercial_delivery_policies(product_id,require_device_registration,allow_file_download,allow_browser_read,created_at,updated_at) VALUES(?,1,1,1,?,?)",
    [test.productId,nowSql,nowSql]
  );
  console.log("QA original EPUB/registered device private assets provisioned");
  await provisionPublishedQaAudio(qaSql,{
    runId,productId:test.productId,buyerId:initialBuyer,
    objectKey:"qa/chapter.wav",sha:audioSha,sizeBytes:audioBytes.length,
    evidenceSha:digest(rightsBytes),evidenceSize:rightsBytes.length
  });
  const {privateKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const offlineSigningJwk=JSON.stringify(privateKey.export({format:"jwk"}));
  const settlement=JSON.parse(fs.readFileSync(
    "wrangler.legal-paid-settlement-stage-qa.example.jsonc","utf8"));
  assert.equal(settlement.workers_dev,false);
  assert.equal(settlement.preview_urls,false);
  assert.deepEqual(settlement.routes,[]);
  assert.equal(settlement.d1_databases?.[0]?.database_id,primary);
  assert.equal(settlement.vars?.COVE_PAID_STAGE_QA_ENABLED,"0");
  assert.equal(settlement.services?.[0]?.service,"cove-paid-legal-authority-qa");
  settlement.name=settlementName;
  settlement.workers_dev=true;
  settlement.r2_buckets=[{binding:"QA_MEDIA",bucket_name:mediaBucketName}];
  settlement.services[0].service=ownerName;
  settlement.vars.COVE_PAID_STAGE_QA_ENABLED="1";
  settlement.vars.STRIPE_LIVEMODE="false";
  settlement.vars.COVE_PAID_STAGE_QA_EXPIRES_AT=String(expires);
  settlement.vars.COVE_PAID_INITIAL_ORDER=initialOrder;
  settlement.vars.COVE_PAID_INITIAL_BUYER=initialBuyer;
  fs.writeFileSync(settlementCfg,JSON.stringify(settlement));
  settlementCreated=true;
  await deploy(settlementCfg,{
    COVE_PAID_STAGE_QA_GATE:gate,COVE_RIGHTS_OWNER_SECRET:secret,
    STRIPE_WEBHOOK_SECRET:webhookSigningSecret,
    FORE_OFFLINE_AUDIO_SIGNING_JWK:offlineSigningJwk
  });
  await verifySecrets(settlementName,
    ["COVE_PAID_STAGE_QA_GATE","COVE_RIGHTS_OWNER_SECRET",
      "STRIPE_WEBHOOK_SECRET","FORE_OFFLINE_AUDIO_SIGNING_JWK"]);
  const postSettlement=async(route,orderId=test.orderId,userId=test.userId)=>{
    const response=await fetch(settlementOrigin+route,{
      method:"POST",headers:{"content-type":"application/json",
        "authorization":"Bearer "+gate},
      body:JSON.stringify({orderId,userId}),
      signal:AbortSignal.timeout(12000)
    });
    return {status:response.status,body:response.status===200?await response.json():null,
      ray:response.headers.get("cf-ray")};
  };
  // An ephemeral workers.dev route can intermittently return the platform's
  // own 404 even after other paths have been served. An owner authorization
  // QUERY makes no mutation, so a bounded route-only retry is safe. Record
  // every such 404 with its Cloudflare Ray. NEVER retry positive publishing,
  // signed Stripe payment/refund, or measured hosted-capacity requests here.
  const readDelivery=async()=>{
    let response;
    for(let attempt=0;attempt<3;attempt++){
      response=await postSettlement("/authorize-delivery");
      if(response.status!==404)return response;
      console.error("QA read-only workers.dev route 404",
        JSON.stringify({attempt:attempt+1,ray:response.ray}));
      if(attempt<2)await pause((attempt+1)*500);
    }
    return response;
  };
  // Do not repeat positive owner mutations on a network timeout. Wait for
  // route propagation using only an already-PAID preflight refusal: no
  // canonical writes, owner changes or payment charged at readiness.
  let stageReady=false;
  for(let n=0;n<24;n++){
    await pause(1500);
    let response;
    try{response=await postSettlement("/preflight-paid");}
    catch{continue;}
    if(response.status===409){stageReady=true;break;}
    if(![404,500,502,503,504].includes(response.status))
      throw Error("Unexpected paid settlement QA stage readiness HTTP "+response.status);
  }
  assert.equal(stageReady,true,"Canonical QA settlement stage never became available");
  const ent=await post("/commercial/entitlement/publish-verified",{
    entitlementId:test.entitlementId,userId:test.userId,productId:test.productId,
    territory:"US",channel:"retail"
  });
  assert.equal(ent.status,200,"Canonical paid order did not publish real buyer receipt");
  assert.equal(ent.body?.applied,true);
  // Confirm one real $3.99 TEST payment, then process its Stripe CLI-signed
  // payment_intent.succeeded through *Cove's original webhook handler* on the
  // deployed paid-stage Worker, into the same private owner as EPUB QA.
  const payment=await stripeRequest("payment_intents",{
    amount:"399",currency:"usd",
    "metadata[fore_order_id]":test.orderId,
    "description":"Cove isolated full-schema legal-owner QA (test only)"
  });
  paymentIntentId=payment.id;
  assert.match(paymentIntentId,/^pi_[a-zA-Z0-9]+$/);
  const linked=await qaSql(
    "UPDATE commerce_orders SET stripe_payment_intent_id=? WHERE id=? AND status='paid' AND stripe_due_minor=399 AND currency='USD'",
    [paymentIntentId,test.orderId]
  );
  assert.equal(linked.meta?.changes,1,
    "Only the exact already-paid synthetic order may be linked to Stripe TEST");
  const confirmed=await stripeRequest("payment_intents/"+
    encodeURIComponent(paymentIntentId)+"/confirm",{
      payment_method:"pm_card_visa",return_url:"https://example.invalid/cove-paid-qa"
    });
  assert.equal(confirmed.status,"succeeded");
  assert.equal(confirmed.amount_received,399);
  const received=await until(()=>matchedPackets.find(x=>x.eventId&&x.status===200),
    "deployed_signed_webhook",60000);
  assert.equal(received.body?.ok,true,
    "Actual signed Cove webhook must publish strong owner entitlement");
  assert.equal(received.body?.duplicate,false);
  const signedReplay=await fetch(settlementOrigin+"/signed-stripe-settlement",{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+gate,"stripe-signature":received.signature},
    body:received.raw,signal:AbortSignal.timeout(12000)
  });
  assert.equal(signedReplay.status,200,"Signed Stripe delivery replay failed");
  assert.equal((await signedReplay.json()).duplicate,true,
    "Idempotent signed payment event must not duplicate owner settlement");
  const proof=await qaSql(
    "SELECT status FROM commerce_webhook_events WHERE provider_event_id=?",
    [received.eventId]
  );
  assert.equal(proof.results?.[0]?.status,"processed",
    "Real signed payment event must have a durable canonical D1 dedupe receipt");
  const stagePublished=await postSettlement("/certify-paid");
  assert.equal(stagePublished.status,200,
    "Real deployed Cove paid-settlement function must reverify full-schema canonical buyer");
  assert.equal(stagePublished.body?.ok,true);
  const deliveryAllowed=await readDelivery();
  assert.equal(deliveryAllowed.status,200,
    "Protected paid delivery must require and accept the actual buyer-specific owner proof");
  assert.equal(deliveryAllowed.body?.ok,true);
  const input={entitlementId:test.entitlementId,userId:test.userId,
    productId:test.productId,territory:"US",channel:"retail"};
  const allowed=await read("/commercial/entitlement/authorize",input);
  assert.equal(allowed.body?.allowed,true,"Paid buyer denied after verified settlement");
  assert.equal(allowed.body?.proof?.order_id,test.orderId);
  const stolen=await read("/commercial/entitlement/authorize",{
    ...input,userId:"user_other_qa_20261027"
  });
  assert.equal(stolen.body?.allowed,false,"Cross-buyer access leaked");
  // Verify actual test-mode provider refund before the private canonical
  // writer receives its immutable operation ID. This is still a synthetic
  // already-paid order: it certifies the provider refund -> durable owner
  // denial boundary, not the full production refund-ledger webhook handler.
  const providerRefund=await stripeRequest("refunds",{
    payment_intent:paymentIntentId,reason:"requested_by_customer"
  });
  assert.match(providerRefund.id,/^re_[a-zA-Z0-9]+$/);
  assert.equal(providerRefund.payment_intent,paymentIntentId);
  assert.equal(providerRefund.amount,399);
  assert.equal(providerRefund.currency,"usd");
  assert.equal(providerRefund.status,"succeeded",
    "Stripe TEST refund must succeed before owner-first canonical revocation");
  const refund={orderId:test.orderId,operationId:"stripe-test-refund:"+providerRefund.id};
  const denied=await post("/commercial/entitlement/revoke-order",refund);
  assert.equal(denied.status,200,
    "Private canonical refund writer must durably deny owner before D1 reconciliation");
  assert.equal(denied.body?.orderDenied,true);
  const revoked=await qaSql(
    "SELECT status FROM entitlements WHERE id=? AND user_id=? AND product_id=?",
    [test.entitlementId,test.userId,test.productId]
  );
  assert.equal(revoked.results?.[0]?.status,"revoked",
    "Owner-first refund must reconcile the synthetic canonical entitlement");
  const after=await read("/commercial/entitlement/authorize",input);
  assert.equal(after.body?.allowed,false,"Refund MUST immediately revoke protected paid entitlement");
  const revokedDelivery=await readDelivery();
  assert.equal(revokedDelivery.status,451,
    "Protected paid delivery must deny the exact buyer after durable owner refund");
  const stageReplayed=await postSettlement("/certify-paid");
  assert.notEqual(stageReplayed.status,200,
    "After refund, actual staged paid settlement must never resurrect protected access");
  const replay=await post("/commercial/entitlement/revoke-order",refund);
  assert.deepEqual(replay.body,denied.body,"Refund replay must be idempotent");
  const forbidden=await post("/commercial/entitlement/publish-verified",input);
  assert.notEqual(forbidden.status,200,"Old paid order must never resurrect entitlement");
  console.log("PASS: deployed canonical full-schema QA, actual Stripe TEST payment/refund and CLI-signed Cove webhook dedupe, owner-first publication, protected buyer check, private refund/replay; synthetic already-paid order; no production/capacity D1 writes");

  // Second scenario: a genuinely UNPAID canonical order with the same
  // immutable purchased grant but a distinct buyer and order-item identity.
  // This exercises Cove's original first-payment finalizer, not the already
  // paid recovery path tested above.
  const noPrematureAccess=await postSettlement("/authorize-initial",
    initialOrder,initialBuyer);
  assert.equal(noPrematureAccess.status,451,
    "No new buyer may fetch content before initial ledger settlement");
  for(const route of ["/qa/epub-bytes","/qa/audio-bytes","/qa/offline-epub-license"]){
    const check=await postSettlement(route,initialOrder,initialBuyer);
    assert.equal(check.status,451,
      "No EPUB/audio bytes or offline license may issue before Stripe settlement");
  }
  // Real payee terms are required: the atomic engine will not silently
  // swallow a missing royalty contract. All records are synthetic and scoped
  // to this exact QA product, never a default contract for customer titles.
  const financeParty="qa_party_"+runId,financeContract="qa_contract_"+runId,financeVersion="qa_contract_v_"+runId;
  await qaSql("INSERT INTO finance_parties(id,party_type,display_name,created_at,updated_at) VALUES(?,'author','Synthetic settlement payee',?,?)",[financeParty,nowSql,nowSql]);
  await qaSql("INSERT INTO finance_royalty_contracts(id,name,product_id,effective_from,created_at,updated_at) VALUES(?,'Synthetic QA settlement terms',?,?,?,?)",[financeContract,test.productId,nowSql,nowSql,nowSql]);
  await qaSql("INSERT INTO finance_royalty_contract_versions(id,contract_id,version,effective_from,created_at) VALUES(?,?,1,?,?)",[financeVersion,financeContract,nowSql,nowSql]);
  await qaSql("INSERT INTO finance_royalty_splits(id,contract_version_id,party_id,share_bps,created_at) VALUES(?,?,?,10000,?)",["qa_split_"+runId,financeVersion,financeParty,nowSql]);
  // An actual canonical D1 fault AFTER the financial transaction prevents
  // owner publication. No fault-injection knob exists on the owner command.
  assert.match(initialOrder,/^order_initial_qa_\d{8,15}-\d{1,5}$/);
  await qaSql("CREATE TRIGGER "+interruptTrigger+" BEFORE UPDATE OF effects_completed_at ON commerce_settlement_receipts WHEN NEW.order_id='"+initialOrder+"' BEGIN SELECT RAISE(ABORT,'isolated_settlement_effect_interruption'); END");
  interruptTriggerCreated=true;
  const initialPI=await stripeRequest("payment_intents",{
    amount:"399",currency:"usd",
    "metadata[fore_order_id]":initialOrder,
    "description":"Cove isolated first-payment settlement QA (test only)"
  });
  initialPaymentIntentId=initialPI.id;
  const initialLink=await qaSql(
    "UPDATE commerce_orders SET stripe_payment_intent_id=? WHERE id=? AND status='pending_payment' AND stripe_due_minor=399 AND currency='USD'",
    [initialPaymentIntentId,initialOrder]);
  assert.equal(initialLink.meta?.changes,1,
    "Only the exact fresh pending order may link to a Stripe TEST payment");
  const initialConfirmation=await stripeRequest(
    "payment_intents/"+encodeURIComponent(initialPaymentIntentId)+"/confirm",{
    payment_method:"pm_card_visa",
    return_url:"https://example.invalid/cove-initial-qa"
  });
  assert.equal(initialConfirmation.status,"succeeded");
  const interrupted=await until(()=>matchedPackets.find(x=>
    x.raw?.includes(initialPaymentIntentId)&&x.status===503),
    "initial_signed_webhook_interruption",60000);
  assert.equal(initialOutageInjected,true);
  // Stripe's asynchronous balance transaction can appear after the success
  // event. Preserve every failed attempt; replay the same signed event until
  // the independently verified fee permits the atomic batch to commit.
  await until(async()=>{
    const state=await qaSql("SELECT status FROM commerce_orders WHERE id=?",[initialOrder]);
    if(state.results?.[0]?.status==="paid")return true;
    const retry=await fetch(settlementOrigin+"/signed-stripe-settlement",{method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer "+gate,"stripe-signature":interrupted.signature},
      body:interrupted.raw,signal:AbortSignal.timeout(15000)});
    assert.equal(retry.status,503,"Injected effect fault must prevent any successful ACK");
    await pause(1000);return false;
  },"independently_verified_atomic_payment",60000);
  const initialPaid=await qaSql(
    "SELECT status,paid_at FROM commerce_orders WHERE id=?",[initialOrder]);
  assert.equal(initialPaid.results?.[0]?.status,"paid",
    "A simulated outage AFTER canonical settlement must leave the order paid");
  assert.ok(initialPaid.results?.[0]?.paid_at,
    "Real canonical pending order must have received its first paid timestamp");
  const deniedOnInterrupt=await postSettlement("/authorize-initial",
    initialOrder,initialBuyer);
  assert.equal(deniedOnInterrupt.status,451,
    "An owner publication outage after payment MUST fail closed to the buyer");
  const ledgerBefore=await qaSql(
    "SELECT entry_type,account_code,amount_minor FROM commerce_ledger_entries WHERE order_id=? ORDER BY entry_type,account_code",
    [initialOrder]);
  assert.ok(ledgerBefore.results.length>=2,
    "The actual Cove pending-order finalizer must post financial ledger entries");
  assert.equal(ledgerBefore.results.reduce((sum,r)=>sum+Number(r.amount_minor),0),0,
    "Canonical financial ledger MUST balance");
  const pendingReceipt=await qaSql("SELECT effects_completed_at,owner_published_at FROM commerce_settlement_receipts WHERE order_id=?",[initialOrder]);
  assert.deepEqual(pendingReceipt.results?.[0],{effects_completed_at:null,owner_published_at:null},"Real financial transaction must retain a durable recovery obligation");
  assert.ok(ledgerBefore.results.some(r=>r.entry_type==="processor_fee"),"Verified Stripe fee must be in the atomic journal");
  assert.ok(ledgerBefore.results.some(r=>r.entry_type==="royalty_accrual"),"All royalty allocations must precede owner ACK");
  await qaSql("DROP TRIGGER "+interruptTrigger);interruptTriggerCreated=false;
  const replayHeaders={
    "content-type":"application/json",authorization:"Bearer "+gate,
    "stripe-signature":interrupted.signature
  };
  const recover=await fetch(settlementOrigin+"/signed-stripe-settlement",{
    method:"POST",headers:replayHeaders,body:interrupted.raw,
    signal:AbortSignal.timeout(15000)
  });
  assert.equal(recover.status,200,
    "Replayed signed event must recover owner delivery after postpaid interruption");
  assert.equal((await recover.json()).duplicate,false,
    "The failed event must actually resume settlement, not be mislabeled duplicate");
  const copies=await Promise.all([0,1,2].map(()=>fetch(
    settlementOrigin+"/signed-stripe-settlement",{
      method:"POST",headers:replayHeaders,body:interrupted.raw,
      signal:AbortSignal.timeout(15000)
    })
  ));
  for(const copy of copies){
    assert.equal(copy.status,200,
      "Repeated signed webhook after committed settlement must succeed as duplicate");
    assert.equal((await copy.json()).duplicate,true);
  }
  const ledgerAfter=await qaSql(
    "SELECT entry_type,account_code,amount_minor FROM commerce_ledger_entries WHERE order_id=? ORDER BY entry_type,account_code",
    [initialOrder]);
  assert.deepEqual(ledgerAfter.results,ledgerBefore.results,
    "Signed payment replay must never duplicate the financial ledger");
  const initialEntitlement=await qaSql(
    `SELECT e.id,e.status FROM entitlements e
        JOIN commerce_order_items oi ON oi.id=e.order_item_id
       WHERE oi.order_id=? AND e.user_id=? AND e.source='commerce'
       AND e.entitlement_type='purchase'`,
    [initialOrder,initialBuyer]);
  assert.equal(initialEntitlement.results?.length,1);
  assert.equal(initialEntitlement.results[0].status,"active");
  const initialAccess=await postSettlement("/authorize-initial",
    initialOrder,initialBuyer);
  assert.equal(initialAccess.status,200,
    "Real settled purchase must be readable only after independent owner receipt");

  // End-to-end Byte/receipt checks use the actual, deployed private Cloudflare
  // R2 binding and the same private buyer owner used for settlement. The
  // handlers are QA-only adapters, not production EPUB/audio route replicas.
  const mediaCall=(route,extra={})=>fetch(settlementOrigin+route,{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+gate,...extra},
    body:JSON.stringify({orderId:initialOrder,userId:initialBuyer}),
    signal:AbortSignal.timeout(12000)
  });
  for(const [route,hash,type] of [
    ["/qa/epub-bytes",epubSha,"application/epub+zip"],
    ["/qa/audio-bytes",audioSha,"audio/wav"]
  ]){
    const response=await mediaCall(route);
    assert.equal(response.status,200,"Owner-authorized private R2 byte delivery refused");
    assert.equal(response.headers.get("content-type"),type);
    const delivered=Buffer.from(await response.arrayBuffer());
    assert.equal(digest(delivered),hash,"Private R2 delivered wrong bytes");
    const outage=await mediaCall(route,
      {"x-cove-qa-simulate-owner-outage":"1"});
    assert.equal(outage.status,503,
      "Owner outage must block protected bytes without cached authorization");
  }
  const wrongBuyer=await fetch(settlementOrigin+"/qa/epub-bytes",{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+gate},
    body:JSON.stringify({orderId:initialOrder,userId:"other_qa_buyer_20261027"}),
    signal:AbortSignal.timeout(12000)
  });
  assert.equal(wrongBuyer.status,400,
    "QA identity scope must forbid even attempting cross-buyer R2 delivery");
  const offlineResponse=await mediaCall("/qa/offline-epub-license");
  assert.equal(offlineResponse.status,200,
    "A settled purchase must qualify for private signed EPUB offline receipt");
  const offline=await offlineResponse.json();
  const compiled=path.join(temp,"offline-epub-verifier-qa.mjs");
  await build({
    entryPoints:["src/features/fore/offline-epub-crypto.ts"],outfile:compiled,
    platform:"node",format:"esm",bundle:true,target:"node22",logLevel:"silent"
  });
  const {verifyOfflineEpubReceipt}=await import(pathToFileURL(compiled).href);
  const claims=await verifyOfflineEpubReceipt(
    offline.receipt,offline.verificationKey,{
      userId:initialBuyer,productId:test.productId,
      assetVersionId:offline.assetVersionId,deviceKey:offline.deviceKey,
      expiresAt:offline.expiresAt
    }
  );
  assert.equal(claims.licenseId,"qa_epub_license_"+runId);
  assert.ok(Date.parse(claims.expiresAt)-Date.parse(claims.issuedAt)<=7*86400000,
    "Offline signed lease cannot exceed seven days");
  await assert.rejects(verifyOfflineEpubReceipt(
    offline.receipt,offline.verificationKey,{
      userId:"user_other_qa_20261027",productId:test.productId,
      assetVersionId:offline.assetVersionId,deviceKey:offline.deviceKey,
      expiresAt:offline.expiresAt
    }
  ),/invalid or expired/i,"Signed offline receipt must be bound to exact buyer");
  assert.equal((await mediaCall("/qa/offline-epub-license",
    {"x-cove-qa-simulate-owner-outage":"1"})).status,503,
    "Owner outage must block new offline license issuance");
  // Call ORIGINAL customer functions against complete synthetic asset,
  // registered device, grant usage and current owner proof.
  const originalCall=(route,token,extra={})=>fetch(settlementOrigin+route,{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+gate,...extra},
    body:JSON.stringify({orderId:initialOrder,userId:initialBuyer,
      ...(token?{token}:{})}),
    signal:AbortSignal.timeout(12000)
  });
  const grantResponse=await originalCall("/original/epub-grant");
  assert.equal(grantResponse.status,200,
    "Original commercial EPUB grant must authorize paid registered buyer; status="+grantResponse.status+
    " category="+String((await grantResponse.clone().json().catch(()=>null))?.qaErrorCategory||"missing"));
  const customerGrant=await grantResponse.json();
  assert.ok(customerGrant.url.startsWith("/api/fore/delivery/epub/"));
  assert.match(customerGrant.url.split("/").at(-1),/^[A-Za-z0-9_-]{32,200}$/);
  const customerToken=customerGrant.url.split("/").at(-1);
  const customerEpub=await originalCall("/original/epub-use",customerToken);
  assert.equal(customerEpub.status,200,
    "Original commercial EPUB delivery must accept owner-authorized grant");
  assert.equal(digest(Buffer.from(await customerEpub.arrayBuffer())),epubSha,
    "Original commercial EPUB handler must return real private R2 asset bytes");
  const originalOfflineResponse=await originalCall("/original/offline-epub-license");
  assert.equal(originalOfflineResponse.status,200,
    "Original EPUB offline issuer must verify registered device and owner");
  const originalOffline=await originalOfflineResponse.json();
  await verifyOfflineEpubReceipt(
    originalOffline.receipt,offline.verificationKey,{
      userId:initialBuyer,productId:test.productId,
      assetVersionId:originalOffline.assetVersionId,
      deviceKey:qaDeviceKey,expiresAt:originalOffline.expiresAt
    }
  );
  await assert.rejects(verifyOfflineEpubReceipt(
    originalOffline.receipt,offline.verificationKey,{
      userId:initialBuyer,productId:test.productId,
      assetVersionId:originalOffline.assetVersionId,
      deviceKey:qaDeviceKey,expiresAt:originalOffline.expiresAt,
      nowMs:Date.parse(originalOffline.expiresAt)
    }
  ),/invalid or expired/i,"Original deployed EPUB receipt must expire at its exact signed boundary");
  const outageOriginal=await originalCall("/original/epub-grant",null,
    {"x-cove-qa-simulate-owner-outage":"1"});
  assert.equal(outageOriginal.status,503,
    "Original commercial EPUB grant must fail closed on owner outage");
  assert.equal((await originalCall("/original/offline-epub-license",null,
    {"x-cove-qa-simulate-owner-outage":"1"})).status,503,
    "Original EPUB offline issuer must fail closed on owner outage");
  console.log("PASS: ORIGINAL Cove EPUB grant and token -> private R2 bytes; registered-device offline EPUB issuer -> original P-256 verifier; owner outage denies both");

  const audioPreflight=await originalCall("/original/audio-preflight");
  assert.equal(audioPreflight.status,200);
  const audioProof=await audioPreflight.json();
  assert.equal(audioProof.allowed,true,
    "Original audio canonical rights denied synthetic purchase: "+audioProof.reason);
  assert.equal(audioProof.hasManifest,true,"Original audio publication manifest missing");
  assert.equal(audioProof.narrators,1);
  assert.equal(audioProof.agreements,1);
  assert.equal(audioProof.chapters,1);
  const audioRange=await originalCall("/original/audio-track");
  assert.equal(audioRange.status,206,
    "Original commercial-audio handler must send a real R2 byte range; status="+
    audioRange.status+" category="+
    String((await audioRange.clone().json().catch(()=>null))?.qaErrorCategory||"missing"));
  assert.equal(audioRange.headers.get("content-range"),
    "bytes 0-127/"+audioBytes.length);
  assert.deepEqual(Buffer.from(await audioRange.arrayBuffer()),
    audioBytes.subarray(0,128),
    "Original chapter streaming must return exact R2 PCM bytes, not merely a 206 header");
  const audioOfflineResponse=await originalCall("/original/audio-offline");
  assert.equal(audioOfflineResponse.status,200,
    "Original audiobook offline issuer must verify a paid, registered device");
  let audioLicense=await audioOfflineResponse.json();
  assert.ok(audioLicense.receipt?.signature && audioLicense.licenseId &&
    audioLicense.token && audioLicense.expiresAt);
  const audioVerifierFile=path.join(temp,"offline-audio-verifier-qa.mjs");
  await build({
    entryPoints:["src/features/fore/offline-audio-license.ts"],
    outfile:audioVerifierFile,platform:"node",format:"esm",bundle:true,
    target:"node22",logLevel:"silent"
  });
  const {verifyOfflineAudioLicense}=await import(pathToFileURL(audioVerifierFile).href);
  const expectedAudioEdition={
    id:"ca_qa_audio_draft_"+runId,productId:test.productId,
    tracks:[{id:"qa_audio_chapter_"+runId,sha256:audioSha}]
  };
  const audioClaims=await verifyOfflineAudioLicense(
    audioLicense,audioLicense.verificationKey,{
      userId:initialBuyer,deviceKey:qaDeviceKey,edition:expectedAudioEdition
    }
  );
  assert.equal(audioClaims.userId,initialBuyer);
  assert.ok(Date.parse(audioClaims.expiresAt)-Date.parse(audioClaims.issuedAt)<=30*86400000);
  await assert.rejects(verifyOfflineAudioLicense(
    audioLicense,audioLicense.verificationKey,{
      userId:initialBuyer,deviceKey:qaDeviceKey,edition:expectedAudioEdition,
      nowMs:Date.parse(audioLicense.expiresAt)
    }
  ),/renewed access/i,"Original deployed audio receipt must expire at its exact signed boundary");
  await assert.rejects(verifyOfflineAudioLicense(
    audioLicense,audioLicense.verificationKey,{
      userId:initialBuyer,deviceKey:"wrong-device-qa",
      edition:expectedAudioEdition
    }
  ),/renewed access/i,
    "Original signed audio offline lease must reject a different registered device");
  const audioVerify=await fetch(settlementOrigin+"/original/audio-verify",{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+gate},
    body:JSON.stringify({orderId:initialOrder,userId:initialBuyer,
      token:audioLicense.token,licenseId:audioLicense.licenseId}),
    signal:AbortSignal.timeout(12000)
  });
  assert.equal(audioVerify.status,200,
    "Original commercial audio verify handler must accept genuine saved buyer license");
  assert.equal((await audioVerify.json()).valid,true);
  // Renewal must produce a new token and retire the old online identity.
  // The already downloaded signature remains expiry-bounded while offline.
  const previousAudio=audioLicense;
  const renewedAudioResponse=await originalCall("/original/audio-offline");
  assert.equal(renewedAudioResponse.status,200,
    "A valid registered purchase must be able to renew its offline audio lease");
  audioLicense=await renewedAudioResponse.json();
  assert.notEqual(audioLicense.licenseId,previousAudio.licenseId);
  assert.notEqual(audioLicense.token,previousAudio.token);
  const verifyAudioOnline=license=>fetch(settlementOrigin+"/original/audio-verify",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+gate},
    body:JSON.stringify({orderId:initialOrder,userId:initialBuyer,
      token:license.token,licenseId:license.licenseId}),
    signal:AbortSignal.timeout(12000)
  });
  assert.equal((await verifyAudioOnline(previousAudio)).status,403,
    "Renewal must reject the retired token at the original online verifier");
  assert.equal((await verifyAudioOnline(audioLicense)).status,200,
    "Renewal must preserve the new license's online access");
  assert.equal((await verifyOfflineAudioLicense(
    audioLicense,audioLicense.verificationKey,{
      userId:initialBuyer,deviceKey:qaDeviceKey,edition:expectedAudioEdition
    }
  )).licenseId,audioLicense.licenseId);
  const persistedRenewal=await qaSql(
    "SELECT id,status,expires_at FROM audio_offline_licenses WHERE id IN (?,?) ORDER BY id",
    [previousAudio.licenseId,audioLicense.licenseId]);
  assert.equal(persistedRenewal.results.find(row=>row.id===previousAudio.licenseId)?.status,"revoked");
  const persistedCurrent=persistedRenewal.results.find(row=>row.id===audioLicense.licenseId);
  assert.equal(persistedCurrent?.status,"active");
  assert.equal(persistedCurrent?.expires_at,audioLicense.expiresAt,
    "Stored, returned and authenticated audio expiration must remain identical");
  console.log("PASS: original deployed EPUB/audio signatures enforce exact expiry; audio renewal rotates token and online identity without extending disconnected old receipts");
  assert.equal((await originalCall("/original/audio-track",null,
    {"x-cove-qa-simulate-owner-outage":"1"})).status,503,
    "Original audiobook track must fail closed when independent owner is unavailable");
  assert.equal((await originalCall("/original/audio-offline",null,
    {"x-cove-qa-simulate-owner-outage":"1"})).status,503,
    "Original audio offline issuer must fail closed when independent owner is unavailable");
  console.log("PASS: ORIGINAL commercial audiobook range stream, synthetic frozen narrator publisher proof, offline license issue/verify and owner-outage veto");

  const initialRefund=await stripeRequest("refunds",{
    payment_intent:initialPaymentIntentId,
    reason:"requested_by_customer"
  });
  assert.equal(initialRefund.status,"succeeded");
  const initialDenial=await post("/commercial/entitlement/revoke-order",{
    orderId:initialOrder,operationId:"stripe-initial-qa-refund:"+initialRefund.id
  });
  assert.equal(initialDenial.status,200,
    "Refund denial must be durable before any lagging D1 buyer reconciliation");
  assert.equal((await postSettlement("/authorize-initial",
    initialOrder,initialBuyer)).status,451,
    "Actual first-payment purchase must be denied immediately after owner refund");
  for(const route of ["/qa/epub-bytes","/qa/audio-bytes","/qa/offline-epub-license"]){
    const response=await fetch(settlementOrigin+route,{
      method:"POST",headers:{"content-type":"application/json",
        authorization:"Bearer "+gate},
      body:JSON.stringify({orderId:initialOrder,userId:initialBuyer}),
      signal:AbortSignal.timeout(12000)
    });
    assert.equal(response.status,451,
      "Refund must deny all subsequent private stored bytes and offline issuance: "+route);
  }
  for(const route of ["/original/epub-grant","/original/offline-epub-license",
      "/original/audio-track","/original/audio-offline"]){
    const response=await originalCall(route);
    assert.ok([403,404,410,451,503].includes(response.status),
      "Refunded ORIGINAL media path must fail closed, never return 200/206: "+
      route+" status="+response.status);
  }
  const oldBearer=await originalCall("/original/epub-use",customerToken);
  assert.ok([403,404,410,451,503].includes(oldBearer.status),
    "Previously issued EPUB bearer must fail closed after refund; status="+oldBearer.status);
  const refusedAudioVerify=await fetch(settlementOrigin+"/original/audio-verify",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+gate},
    body:JSON.stringify({orderId:initialOrder,userId:initialBuyer,
      token:audioLicense.token,licenseId:audioLicense.licenseId}),
    signal:AbortSignal.timeout(12000)
  });
  assert.ok([403,404,410,451,503].includes(refusedAudioVerify.status),
    "Original online audiobook license verification must fail closed after refund; status="+
    refusedAudioVerify.status);
  // A truly disconnected device cannot receive a revocation until reconnect.
  // Both previously signed receipts remain locally verifiable until their
  // format-specific expiration (EPUB <=7d, audio <=30d); online access is denied.
  assert.equal((await verifyOfflineEpubReceipt(
    originalOffline.receipt,offline.verificationKey,{
      userId:initialBuyer,productId:test.productId,
      assetVersionId:originalOffline.assetVersionId,
      deviceKey:qaDeviceKey,expiresAt:originalOffline.expiresAt
    }
  )).userId,initialBuyer);
  assert.equal((await verifyOfflineAudioLicense(
    audioLicense,audioLicense.verificationKey,{
      userId:initialBuyer,deviceKey:qaDeviceKey,edition:expectedAudioEdition
    }
  )).userId,initialBuyer);
  console.log("PASS: owner refund definitively denies authorization, original EPUB/audio/grants/old bearers and online license verification fail closed (4xx or 503) with no bytes; disconnected format-specific signed receipts remain valid only until their existing expiry");
  assert.equal((await postSettlement("/certify-initial",
    initialOrder,initialBuyer)).status!==200,true,
    "Any previous signed successful-payment event may not resurrect refunded access");
  console.log("PASS: genuine initial pending_payment to original Stripe webhook, full canonical ledger and outbox, injected postpaid owner outage, replay and concurrency dedupe, buyer lease, provider refund and immediate owner revocation");
  console.log("PASS: private R2 EPUB/WAV exact SHA256 bytes from isolated paid order, wrong-buyer and outage denial, original EPUB/audio receipt expiry and audio renewal, prepayment and refund byte/license veto; isolated QA adapters and original handlers, not production certification");

 } finally {
  if(interruptTriggerCreated){
    try{await qaSql("DROP TRIGGER IF EXISTS "+interruptTrigger);interruptTriggerCreated=false;}
    catch(error){cleanupError=error;console.error("QA settlement interruption cleanup failed");}
  }
  if(listener?.pid){
    try{process.kill(-listener.pid,"SIGTERM");}catch{
      try{listener.kill("SIGTERM");}catch{}
    }
  }
  if(webhookServer)await new Promise(resolve=>webhookServer.close(resolve));
  if(mediaBucketCreated){
    for(const key of ["qa/book.epub","qa/chapter.wav","qa/rights.txt"]){
      try{cli(["r2","object","delete",mediaBucketName+"/"+key,"--remote"]);}
      catch(e){cleanupError=e;console.error("Ephemeral private media object cleanup failed");}
    }
    try{cli(["r2","bucket","delete",mediaBucketName]);}
    catch(e){cleanupError=e;console.error("Ephemeral private R2 bucket cleanup failed");}
  }
  // Physically distinct QA scripts and expiring credentials prevent production
  // exposure. DELETE is limited to names built from this exact CI run ID.
  for(const [name,created] of [[settlementName,settlementCreated],[callerName,callerCreated],[writerName,writerCreated],[ownerName,ownerCreated]]){
    if(!created)continue;
    try{await api("DELETE","/workers/scripts/"+name);}
    catch(e){cleanupError=e;console.error("QA script cleanup failed: "+name);}
  }
  // Revert the exact synthetic order link, even if the signed event fails.
  if(paymentIntentId){
    try{
      await qaSql("UPDATE commerce_orders SET stripe_payment_intent_id=NULL WHERE id=? AND stripe_payment_intent_id=?",
        [test.orderId,paymentIntentId]);
    }catch(e){cleanupError=e;console.error("Synthetic QA Stripe intent unlink failed");}
  }
  // This database contains only our fixed synthetic QA fixture, never live
  // paid customers. Reinstate its test row after all ephemeral owner/writer
  // routes are gone, so cancellation recovery and later campaigns are safe.
  try {
    await qaSql(
      "UPDATE entitlements SET status='active' WHERE id=? AND user_id=? AND product_id=? AND source='commerce' AND entitlement_type='purchase' AND status='revoked'",
      [test.entitlementId,test.userId,test.productId]
    );
  }catch(e){cleanupError=e;console.error("Synthetic QA entitlement restoration failed");}
  fs.rmSync(ownerCfg,{force:true});
  fs.rmSync(callerCfg,{force:true});
  fs.rmSync(writerCfg,{force:true});
  fs.rmSync(settlementCfg,{force:true});
  fs.rmSync(temp,{force:true,recursive:true});
  if(cleanupError)throw cleanupError;
}
