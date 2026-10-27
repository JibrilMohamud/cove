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
const origin="https://"+callerName+".cove-jibrilmohamud.workers.dev";
const primary="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const primaryName="cove-paid-commerce-legal-qa-20261027";
const gate=randomBytes(32).toString("hex");
const secret=randomBytes(32).toString("hex");
const expires=Date.now()+12*60_000;
const temp=fs.mkdtempSync(path.join(process.cwd(),".cove-paid-proof-"));
const ownerCfg=path.join(process.cwd(),".cove-paid-owner-proof-"+runId+".jsonc");
const callerCfg=path.join(process.cwd(),".cove-paid-caller-proof-"+runId+".jsonc");
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
const api=async(method,resource)=>{
  const r=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+resource,{
    method,headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(18000)
  });
  const j=await r.json().catch(()=>null);
  if(!r.ok||!j?.success)throw Error("Cloudflare control plane "+method+" "+r.status);
  return j.result;
};
const deploy=(file,secrets)=>{
  const keyfile=path.join(temp,path.basename(file)+".secrets.json");
  fs.writeFileSync(keyfile,JSON.stringify(secrets),{mode:0o600});
  try { cli(["deploy","--config",file,"--secrets-file",keyfile]); }
  finally { fs.rmSync(keyfile,{force:true}); }
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
let ownerCreated=false,callerCreated=false;
let cleanupError=null;
try {
  const original=JSON.parse(fs.readFileSync("wrangler.legal-paid-authority.example.jsonc","utf8"));
  assertNoRoute(original);
  original.name=ownerName;
  original.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  original.vars.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=String(expires);
  fs.writeFileSync(ownerCfg,JSON.stringify(original));
  ownerCreated=true;
  deploy(ownerCfg,{COVE_RIGHTS_OWNER_SECRET:secret});
  await verifySecrets(ownerName,["COVE_RIGHTS_OWNER_SECRET"]);
  const caller=JSON.parse(fs.readFileSync("wrangler.legal-paid-caller.example.jsonc","utf8"));
  assert.equal(caller.workers_dev,false);
  assert.deepEqual(caller.routes,[]);
  assert.equal(caller.services?.[0]?.service,"cove-paid-legal-authority-qa");
  caller.name=callerName;
  caller.workers_dev=true;
  caller.services[0].service=ownerName;
  caller.vars.COVE_LEGAL_QA_CALLER_ENABLED="1";
  caller.vars.COVE_LEGAL_QA_EXPIRES_AT=String(expires);
  fs.writeFileSync(callerCfg,JSON.stringify(caller));
  callerCreated=true;
  deploy(callerCfg,{COVE_LEGAL_QA_GATE:gate,COVE_RIGHTS_OWNER_SECRET:secret});
  await verifySecrets(callerName,["COVE_LEGAL_QA_GATE","COVE_RIGHTS_OWNER_SECRET"]);
  await readyOwner();
  // Real canonical D1 rights evaluation. No fabricated grant/contract IDs
  // accepted from the caller; strong owner verifies them itself before ACK.
  const publish=await post("/commercial/publish-verified",{
    productId:test.productId,territory:"US",channel:"retail"
  });
  assert.equal(publish.status,200,"Positive canonical paid rights were not verified");
  assert.equal(publish.body?.applied,true);
  const rights=await read("/commercial/authorize-batch",{
    ids:[test.productId],territory:"US",channel:"retail"
  });
  assert.equal(rights.body?.rows?.length,1,"Owner failed to store paid grant");
  assert.equal(rights.body.rows[0].grant_id,"rgrant_paid_qa_20261027");
  assert.equal(rights.body.rows[0].contract_version_id,"rcv_paid_qa_20261027");
  // Positive price publication is a distinct canonical D1 check. A rights
  // grant cannot fabricate a paid retail offer or change its currency.
  const retail=await post("/storefront/publish-commercial",{
    productId:test.productId,territory:"US",currency:"USD"
  });
  assert.equal(retail.status,200,"Canonical retail offer was not verified");
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
  const ent=await post("/commercial/entitlement/publish-verified",{
    entitlementId:test.entitlementId,userId:test.userId,productId:test.productId,
    territory:"US",channel:"retail"
  });
  assert.equal(ent.status,200,"Canonical paid order did not publish real buyer receipt");
  assert.equal(ent.body?.applied,true);
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
  const denied=await post("/commercial/order/deny-next",refund);
  assert.equal(denied.status,200,"Owner must ACK durable order withdrawal");
  assert.equal(denied.body?.applied,true);
  const after=await read("/commercial/entitlement/authorize",input);
  assert.equal(after.body?.allowed,false,"Refund MUST immediately revoke protected paid entitlement");
  const replay=await post("/commercial/order/deny-next",refund);
  assert.deepEqual(replay.body,denied.body,"Refund replay must be idempotent");
  const forbidden=await post("/commercial/entitlement/publish-verified",input);
  assert.notEqual(forbidden.status,200,"Old paid order must never resurrect entitlement");
  console.log("PASS: deployed full-schema paid owner, canonical grant and price, exact buyer, territory, refund and replay; no capacity D1 writes");
} finally {
  // Physically distinct QA scripts and expiring credentials prevent production
  // exposure. DELETE is limited to names built from this exact CI run ID.
  for(const [name,created] of [[callerName,callerCreated],[ownerName,ownerCreated]]){
    if(!created)continue;
    try{await api("DELETE","/workers/scripts/"+name);}
    catch(e){cleanupError=e;console.error("QA script cleanup failed: "+name);}
  }
  fs.rmSync(ownerCfg,{force:true});
  fs.rmSync(callerCfg,{force:true});
  fs.rmSync(temp,{force:true,recursive:true});
  if(cleanupError)throw cleanupError;
}
