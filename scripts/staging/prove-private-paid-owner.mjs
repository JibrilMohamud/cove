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
  // Only a read is retried while the edge learns a newly deployed QA hostname.
  const absent=await read("/commercial/authorize-batch",{
    ids:[test.productId],territory:"US",channel:"retail"
  });
  assert.equal(absent.status,200,"Deployed owner read must be accessible with private binding");
  assert.deepEqual(absent.body,{schema:"cove.commercial-legal.v1",rows:[]},
    "New DO must start without a fabricated paid grant");
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
  console.log("PASS: deployed full-schema paid owner, canonical grant, exact buyer, territory, refund and replay; no capacity D1 writes");
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
