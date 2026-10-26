/* eslint-disable prettier/prettier -- Restricted live QA service-binding proof and cleanup are security boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";

const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const runId=process.env.GITHUB_RUN_ID;
assert.match(account||"",/^[a-f0-9]{32}$/);
assert.ok(token&&/^\d{8,15}$/.test(runId||""));
const ownerCfg="wrangler.legal-authority.proof.jsonc";
const callerCfg="wrangler.legal-authority.proof-caller.jsonc";
const caller="cove-private-legal-proof-"+runId;
const origin="https://"+caller+".cove-jibrilmohamud.workers.dev";
const gate=randomBytes(32).toString("hex");
const secret=randomBytes(32).toString("hex");
const sourceId=String((Number(runId)%800000000)+100000000);
const expires=Date.now()+12*60*1000;
let authorityEnabled=false,callerStarted=false;
const cli=(args,input)=>{
  const result=spawnSync("npm",["exec","--yes","--package=wrangler@4.151.0","--","wrangler",...args],{
    input,encoding:"utf8",timeout:160000,
    env:{...process.env,CLOUDFLARE_SEND_METRICS:"false"}
  });
  if(result.status!==0)throw Error("wrangler_"+args[0]+"_failed: "+
    String(result.stderr||"").replace(/Bearer\s+\S+/g,"Bearer [masked]").slice(-600));
};
const api=async(method,path)=>{
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    method,headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!result.success)throw Error("cloudflare_control_"+method+"_"+response.status);
  return result.result;
};
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const post=async(path,body,authorization=gate)=>{
  const r=await fetch(origin+path,{
    method:"POST",
    headers:{"authorization":"Bearer "+authorization,"content-type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)
  });
  const payload=r.status===200?await r.json():null;
  return {status:r.status,payload};
};
try{
  const owner=JSON.parse(fs.readFileSync("wrangler.legal-authority.example.jsonc","utf8"));
  assert.equal(owner.workers_dev,false);
  assert.deepEqual(owner.routes,[]);
  assert.equal(owner.d1_databases[0].database_id,"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87");
  owner.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  fs.writeFileSync(ownerCfg,JSON.stringify(owner));
  authorityEnabled=true;
  cli(["deploy","--config",ownerCfg]);
  cli(["secret","put","COVE_RIGHTS_OWNER_SECRET","--config",ownerCfg],secret);

  const proxy=JSON.parse(fs.readFileSync("wrangler.legal-qa-caller.example.jsonc","utf8"));
  assert.equal(proxy.services[0].service,owner.name);
  proxy.name=caller;
  proxy.workers_dev=true;
  proxy.vars.COVE_LEGAL_QA_CALLER_ENABLED="1";
  proxy.vars.COVE_LEGAL_QA_EXPIRES_AT=String(expires);
  fs.writeFileSync(callerCfg,JSON.stringify(proxy));
  callerStarted=true;
  cli(["deploy","--config",callerCfg]);
  cli(["secret","put","COVE_LEGAL_QA_GATE","--config",callerCfg],gate);
  cli(["secret","put","COVE_RIGHTS_OWNER_SECRET","--config",callerCfg],secret);

  // Configuration/Workers metadata can precede propagation of a new
  // workers.dev hostname. The readiness poll is NOT part of a capacity
  // measurement and never warms the future hosted-capacity campaign.
  let ready=false;
  for(let i=0;i<32;i++){
    await sleep(2000);
    try{
      const result=await post("/verify",{sourceId,territory:"US"});
      if(result.status===200 && result.payload?.allowed===false){
        assert.equal(result.payload.revision,null,"Unseeded source must start denied");
        ready=true;break;
      }
    }catch{}
  }
  assert.ok(ready,"QA owner service-binding never became usable");
  assert.equal((await post("/verify",{sourceId,territory:"CA"})).payload?.allowed,false);
  const withdrawal=await post("/deny-next",{
    sourceId,territory:"*",operationId:"qa:"+runId+":source:deny"
  });
  assert.equal(withdrawal.status,200,"Deny-first receipt must be durable");
  assert.equal(withdrawal.payload?.applied,true);
  assert.equal(withdrawal.payload?.revision,1);
  const replay=await post("/deny-next",{
    sourceId,territory:"*",operationId:"qa:"+runId+":source:deny"
  });
  assert.equal(replay.status,200);
  assert.equal(replay.payload?.revision,1,"Repeated writer delivery retains original epoch");
  for(const territory of ["US","CA","AU"]){
    const decision=await post("/verify",{sourceId,territory});
    assert.equal(decision.status,200);
    assert.deepEqual(decision.payload,{allowed:false,revision:1},
      "Same owner must deny every country after source-wide withdrawal");
  }
  const offerings=await post("/authorize-batch",{
    ids:["prd_gutenberg_"+sourceId],territory:"US",currency:"USD"
  });
  assert.equal(offerings.status,200);
  assert.deepEqual(offerings.payload?.rows,[],"Denied source cannot expose stale free retail offer");
  const unauthorized=await post("/verify",{sourceId,territory:"US"},"0".repeat(64));
  assert.equal(unauthorized.status,401);
  console.log("PASS: live protected caller -> private service binding -> SQLite DO: unseeded denial, source withdrawal, replay, 3-territory withdrawal, offer hiding and access control");
}finally{
  const errors=[];
  if(authorityEnabled){
    try{cli(["deploy","--config","wrangler.legal-authority.example.jsonc"]);}
    catch(e){errors.push("owner_disable_"+String(e.message).slice(0,120));}
  }
  if(callerStarted){
    try{await api("DELETE","/accounts/"+account+"/workers/scripts/"+caller);}
    catch(e){errors.push("caller_remove_"+String(e.message).slice(0,120));}
  }
  for(const file of [ownerCfg,callerCfg])try{fs.unlinkSync(file);}catch{}
  if(errors.length)throw Error("legal_qa_rollback_failed:"+errors.join(","));
  console.log("PASS: owner returned to disabled nonroutable configuration and ephemeral public QA caller deleted");
}
