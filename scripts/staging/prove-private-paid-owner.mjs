/* eslint-disable prettier/prettier -- Ephemeral private paid-owner proof; never route production or trust caller price. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";

const runId=process.env.GITHUB_RUN_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.match(runId||"",/^\d{8,15}$/);
assert.match(account||"",/^[a-f0-9]{32}$/);
assert.ok(token,"Cloudflare QA authorization required");
const ownerName="cove-paid-legal-owner-"+runId;
const callerName="cove-paid-legal-caller-"+runId;
const writerName="cove-paid-legal-writer-"+runId;
const settlementName="cove-paid-settlement-qa-"+runId;
const settlementOrigin="https://"+settlementName+".cove-jibrilmohamud.workers.dev";
const origin="https://"+callerName+".cove-jibrilmohamud.workers.dev";
const primary="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const primaryName="cove-paid-commerce-legal-qa-20261027";
const gate=randomBytes(32).toString("hex");
const secret=randomBytes(32).toString("hex");
const writerSecret=randomBytes(32).toString("hex");
const expires=Date.now()+12*60_000;
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
  if(!r.ok||!j?.success)throw Error("Cloudflare control plane "+method+" "+r.status);
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
const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const post=async(route,body)=>{
  const response=await fetch(origin+route,{
    method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+gate},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12000)
  });
  return {status:response.status,body:response.status===200?await response.json():null};
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
let cleanupError=null;
try {
  const original=JSON.parse(fs.readFileSync("wrangler.legal-paid-authority.example.jsonc","utf8"));
  assertNoRoute(original);
  original.name=ownerName;
  original.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  original.vars.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=String(expires);
  fs.writeFileSync(ownerCfg,JSON.stringify(original));
  ownerCreated=true;
  await deploy(ownerCfg,{COVE_RIGHTS_OWNER_SECRET:secret});
  await verifySecrets(ownerName,["COVE_RIGHTS_OWNER_SECRET"]);
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
  const publish=await post("/commercial/retail/publish-verified",{
    productId:test.productId,territory:"US",currency:"USD",
    operationId:"qa:"+runId+":positive-retail-publication"
  });
  assert.equal(publish.status,200,"Private positive canonical retail writer unavailable");
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
  settlement.services[0].service=ownerName;
  settlement.vars.COVE_PAID_STAGE_QA_ENABLED="1";
  settlement.vars.COVE_PAID_STAGE_QA_EXPIRES_AT=String(expires);
  fs.writeFileSync(settlementCfg,JSON.stringify(settlement));
  settlementCreated=true;
  await deploy(settlementCfg,{
    COVE_PAID_STAGE_QA_GATE:gate,COVE_RIGHTS_OWNER_SECRET:secret
  });
  await verifySecrets(settlementName,
    ["COVE_PAID_STAGE_QA_GATE","COVE_RIGHTS_OWNER_SECRET"]);
  const postSettlement=async(route)=>{
    const response=await fetch(settlementOrigin+route,{
      method:"POST",headers:{"content-type":"application/json",
        "authorization":"Bearer "+gate},
      body:JSON.stringify({orderId:test.orderId,userId:test.userId}),
      signal:AbortSignal.timeout(12000)
    });
    return {status:response.status,body:response.status===200?await response.json():null};
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
  const stagePublished=await postSettlement("/certify-paid");
  assert.equal(stagePublished.status,200,
    "Real deployed Cove paid-settlement function must reverify full-schema canonical buyer");
  assert.equal(stagePublished.body?.ok,true);
  const deliveryAllowed=await postSettlement("/authorize-delivery");
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
  const refund={orderId:test.orderId,operationId:"qa:"+runId+":refund-paid-order"};
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
  const revokedDelivery=await postSettlement("/authorize-delivery");
  assert.equal(revokedDelivery.status,451,
    "Protected paid delivery must deny the exact buyer after durable owner refund");
  const stageReplayed=await postSettlement("/certify-paid");
  assert.notEqual(stageReplayed.status,200,
    "After refund, actual staged paid settlement must never resurrect protected access");
  const replay=await post("/commercial/entitlement/revoke-order",refund);
  assert.deepEqual(replay.body,denied.body,"Refund replay must be idempotent");
  const forbidden=await post("/commercial/entitlement/publish-verified",input);
  assert.notEqual(forbidden.status,200,"Old paid order must never resurrect entitlement");
  console.log("PASS: deployed full-schema paid owner, canonical grant and price via private writer, deployed settlement and protected consumer, exact buyer, territory, owner-first canonical refund and replay; no capacity D1 writes");
} finally {
  // Physically distinct QA scripts and expiring credentials prevent production
  // exposure. DELETE is limited to names built from this exact CI run ID.
  for(const [name,created] of [[settlementName,settlementCreated],[callerName,callerCreated],[writerName,writerCreated],[ownerName,ownerCreated]]){
    if(!created)continue;
    try{await api("DELETE","/workers/scripts/"+name);}
    catch(e){cleanupError=e;console.error("QA script cleanup failed: "+name);}
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
