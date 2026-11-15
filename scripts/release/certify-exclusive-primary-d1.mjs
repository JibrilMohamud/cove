/* eslint-disable prettier/prettier -- Strict, read-only infrastructure release audit. */
/**
 * The production D1 writer exclusivity gate checks PHYSICAL Cloudflare access:
 * Worker bindings, active account tokens, and user-token inventory. It never
 * mutates Workers, credentials, routes, D1 records, or payment configuration.
 *
 * Self-test: node scripts/release/certify-exclusive-primary-d1.mjs --self-test
 * Live: CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/release/certify-exclusive-primary-d1.mjs
 * Keep credentials in a protected environment; never paste them into output.
 */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";

const PRODUCTION_DB="4bd657ac-8789-403e-a28c-93aba8d0a989";
const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const OWNER="cove-legal-authority-production";

export function evaluatePhysicalWriterInventory({workers,tokens,userTokensVerified}){
  const problems=[];
  if(!Array.isArray(workers)||!workers.length)
    problems.push("worker_inventory_unavailable");
  const owners=(workers||[]).filter(w=>w.name===OWNER);
  if(owners.length!==1)problems.push("production_owner_missing_or_duplicated");
  const owner=owners[0];
  const ownerBindings=(owner?.bindings||[]).filter(b=>
    (b.type==="d1"||b.type==="d1_database") &&
    (b.id||b.database_id)===PRODUCTION_DB &&
    b.name==="PRIMARY_DB");
  if(ownerBindings.length!==1)
    problems.push("production_owner_primary_d1_not_uniquely_bound");
  if((owner?.bindings||[]).find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED")?.text!=="1")
    problems.push("production_owner_disabled");
  const outsiders=(workers||[]).filter(w=>w.name!==OWNER &&
    (w.bindings||[]).some(b=>
      (b.type==="d1"||b.type==="d1_database") &&
      (b.id||b.database_id)===PRODUCTION_DB));
  if(outsiders.length)problems.push("nonowner_primary_d1_binding");
  if(!Array.isArray(tokens))problems.push("account_token_inventory_unavailable");
  const privileged=(tokens||[]).filter(t=>t.status==="active" &&
    (t.policies||[]).some(p=>(p.permission_groups||[]).some(g=>
      ["D1 Write","Workers Admin","Account API Tokens Write"].includes(g.name))));
  if(privileged.length)problems.push("active_account_token_can_mutate_primary_or_owner");
  if(userTokensVerified!==true)problems.push("user_token_inventory_unverified");
  return {
    schema:"cove.production-exclusive-d1-audit.v1",
    certified:problems.length===0,
    workerCount:workers?.length||0,
    productionD1WorkerBindingCount:(workers||[]).filter(w=>
      (w.bindings||[]).some(b=>
        (b.type==="d1"||b.type==="d1_database") &&
        (b.id||b.database_id)===PRODUCTION_DB)).length,
    nonownerBindingNames:outsiders.map(w=>w.name),
    privilegedAccountTokenNames:privileged.map(t=>t.name),
    userTokensVerified:userTokensVerified===true,
    problems,
  };
}

function selfTest(){
  const owner={name:OWNER,bindings:[
    {type:"d1",name:"PRIMARY_DB",id:PRODUCTION_DB},
    {type:"plain_text",name:"COVE_RIGHTS_OWNER_ENABLED",text:"1"},
  ]};
  const safe=evaluatePhysicalWriterInventory({
    workers:[owner,{name:"safe-replica",bindings:[]}],
    tokens:[{name:"read-only",status:"active",policies:[
      {permission_groups:[{name:"D1 Read"}]},
    ]}],userTokensVerified:true,
  });
  assert.equal(safe.certified,true);
  const unsafe=evaluatePhysicalWriterInventory({
    workers:[{...owner,bindings:owner.bindings.map(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED"?
      {...b,text:"0"}:b)},
      {name:"nonowner",bindings:[{type:"d1",name:"DB",database_id:PRODUCTION_DB}]}],
    tokens:[{name:"broad",status:"active",policies:[
      {permission_groups:[{name:"D1 Write"},{name:"Account API Tokens Write"}]},
    ]}],userTokensVerified:false,
  });
  assert.equal(unsafe.certified,false);
  assert.deepEqual(new Set(unsafe.problems),new Set([
    "production_owner_disabled","nonowner_primary_d1_binding",
    "active_account_token_can_mutate_primary_or_owner",
    "user_token_inventory_unverified",
  ]));
  assert.deepEqual(unsafe.nonownerBindingNames,["nonowner"]);
  assert.deepEqual(unsafe.privilegedAccountTokenNames,["broad"]);
  assert.equal(JSON.stringify(unsafe).includes(PRODUCTION_DB),false);
  console.log("PASS: physical primary-D1 owner inventory self-test is fail-closed");
}

async function cloudflareRead(path,token=process.env.CF_API_TOKEN){
  if(!token||token.length<20)throw Error("Protected inventory credential missing");
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    headers:{authorization:"Bearer "+token},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw Error("Cloudflare inventory unavailable: HTTP "+response.status);
  const payload=await response.json();
  if(payload?.success!==true)throw Error("Cloudflare inventory API unsuccessful");
  return payload;
}

async function main(){
  assert.equal(process.env.CF_ACCOUNT_ID,ACCOUNT,
    "Refuse to audit an unreviewed Cloudflare account");
  assert.ok(process.env.CF_API_TOKEN?.length>20,
    "A protected Cloudflare read-inventory credential is required");
  const root="/accounts/"+ACCOUNT;
  const list=await cloudflareRead(root+"/workers/scripts");
  const scripts=Array.isArray(list.result)?list.result:list.result?.scripts;
  assert.ok(Array.isArray(scripts)&&scripts.length>0,
    "Cloudflare Worker inventory must be complete");
  if(list.result_info?.total_count &&
      list.result_info.total_count!==scripts.length)
    throw Error("Partial Worker inventory must not certify release");
  const workers=[];
  for(let i=0;i<scripts.length;i+=12){
    const group=await Promise.all(scripts.slice(i,i+12).map(async script=>{
      const name=script.id||script.name;
      assert.match(name,/^[a-zA-Z0-9_-]+$/);
      const data=await cloudflareRead(root+"/workers/scripts/"+name+"/settings");
      if(!Array.isArray(data.result?.bindings))
        throw Error("Missing Worker bindings inventory");
      return {name,bindings:data.result.bindings};
    }));
    workers.push(...group);
  }
  const account=await cloudflareRead(root+"/tokens");
  if(!Array.isArray(account.result))
    throw Error("Missing account token permission inventory");
  // User-scoped tokens are distinct from account-scoped tokens. A 403 must
  // BLOCK the physical exclusivity certificate, not silently claim zero.
  let userTokensVerified=false;
  try{
    const users=await cloudflareRead("/user/tokens",process.env.CF_USER_AUDIT_TOKEN);
    userTokensVerified=Array.isArray(users.result) &&
      users.result.filter(x=>x.status==="active").every(t=>
        !(t.policies||[]).some(p=>(p.permission_groups||[]).some(g=>
          ["D1 Write","Workers Admin","Account API Tokens Write"].includes(g.name))));
  }catch{
    userTokensVerified=false;
  }
  const report=evaluatePhysicalWriterInventory({
    workers,tokens:account.result,userTokensVerified,
  });
  console.log(JSON.stringify(report));
  if(!report.certified)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.includes("--self-test"))selfTest();
  else main().catch(e=>{
    // Do not print auth headers, raw API responses, URL, credentials or ids.
    console.error("BLOCKED: production writer inventory could not be certified: "+
      String(e?.message||"unknown").slice(0,160));
    process.exitCode=1;
  });
}
