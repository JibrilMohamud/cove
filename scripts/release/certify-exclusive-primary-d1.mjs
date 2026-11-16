/* eslint-disable prettier/prettier -- Strict, read-only infrastructure release audit. */
/**
 * The production D1 writer exclusivity gate checks PHYSICAL Cloudflare access:
 * Worker bindings, active account tokens, and user-token inventory. It never
 * mutates Workers, credentials, routes, D1 records, or payment configuration.
 *
 * Self-test: node scripts/release/certify-exclusive-primary-d1.mjs --self-test
 * Live: protected workflow_dispatch on main with three separate metadata-only
 * Cloudflare read credentials. Never use a D1-only or broad deployment token.
 * Keep credentials in the protected environment, not command lines or logs.
 */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {createPhysicalWriterReadTransport} from "./physical-d1-writer-read-transport.mjs";

const PRODUCTION_DB="4bd657ac-8789-403e-a28c-93aba8d0a989";
const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const OWNER="cove-legal-authority-production";
const PRIVILEGED_GROUPS=new Set([
  "D1 Write","Workers Admin","Workers Editor",
  "Workers Scripts Write","Account API Tokens Write",
]);
function tokenCanMutate(token){
  return (token.policies||[]).some(p=>(p.permission_groups||[])
    .some(group=>PRIVILEGED_GROUPS.has(group.name)));
}
function completeTokenInventory(tokens){
  if(!Array.isArray(tokens))return false;
  return tokens.every(t=>{
    if(!t||typeof t.name!=="string"||!t.name.trim()||
      !["active","disabled","expired"].includes(t.status))return false;
    if(t.status!=="active")return true;
    return Array.isArray(t.policies)&&t.policies.length>0&&
      t.policies.every(p=>Array.isArray(p.permission_groups)&&
        p.permission_groups.length>0&&p.permission_groups.every(g=>
          typeof g?.name==="string"&&g.name.trim().length>0));
  });
}

function completeTokenPage(response){
  const data=response?.result,info=response?.result_info;
  if(!Array.isArray(data)||!info||info.page!==1||info.total_pages!==1||
    !Number.isSafeInteger(info.count)||info.count!==data.length||
    !Number.isSafeInteger(info.total_count)||info.total_count!==data.length)
    throw Error("Incomplete Cloudflare token inventory page");
  return data;
}

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
  const enabled=(owner?.bindings||[]).filter(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED");
  if(enabled.length!==1||enabled[0].type!=="plain_text"||enabled[0].text!=="1")
    problems.push("production_owner_disabled");
  const primaryId=(owner?.bindings||[]).filter(b=>b.name==="COVE_RIGHTS_OWNER_PRIMARY_ID");
  if(primaryId.length!==1||primaryId[0].type!=="plain_text"||
    primaryId[0].text!==PRODUCTION_DB)
    problems.push("production_owner_primary_id_mismatch");
  const outsiders=(workers||[]).filter(w=>w.name!==OWNER &&
    (w.bindings||[]).some(b=>
      (b.type==="d1"||b.type==="d1_database") &&
      (b.id||b.database_id)===PRODUCTION_DB));
  if(outsiders.length)problems.push("nonowner_primary_d1_binding");
  if(!Array.isArray(tokens))problems.push("account_token_inventory_unavailable");
  if(!completeTokenInventory(tokens))
    problems.push("account_token_permission_metadata_incomplete");
  const privileged=(tokens||[]).filter(t=>t?.status==="active"&&tokenCanMutate(t));
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
    {type:"plain_text",name:"COVE_RIGHTS_OWNER_PRIMARY_ID",text:PRODUCTION_DB},
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
  for(const incomplete of [
    [{name:"missing-policies",status:"active"}],
    [{name:"empty-policies",status:"active",policies:[]}],
    [{name:"no-groups",status:"active",policies:[{}]}],
    [{name:"empty-groups",status:"active",policies:[{permission_groups:[]}]}],
    [{name:"unknown-group",status:"active",policies:[{permission_groups:[{}]}]}],
    [{name:"unknown-status",status:"pending"}],
  ]){
    const report=evaluatePhysicalWriterInventory({
      workers:[owner],tokens:incomplete,userTokensVerified:true,
    });
    assert.equal(report.certified,false);
    assert.ok(report.problems.includes("account_token_permission_metadata_incomplete"));
  }
  assert.deepEqual(completeTokenPage({result:[],result_info:{
    page:1,total_pages:1,count:0,total_count:0,
  }}),[]);
  for(const info of [
    null,{page:1,total_pages:2,count:1,total_count:2},
    {page:2,total_pages:2,count:0,total_count:0},
    {page:1,total_pages:1,count:1,total_count:1},
  ])assert.throws(()=>completeTokenPage({result:[],result_info:info}),
    /Incomplete Cloudflare token inventory page/);
  for(const flag of ["COVE_RIGHTS_OWNER_ENABLED","COVE_RIGHTS_OWNER_PRIMARY_ID"]){
    const duplicate={...owner,bindings:[...owner.bindings,
      owner.bindings.find(b=>b.name===flag)]};
    const report=evaluatePhysicalWriterInventory({
      workers:[duplicate],tokens:[],userTokensVerified:true,
    });
    assert.equal(report.certified,false);
    assert.ok(report.problems.includes(flag==="COVE_RIGHTS_OWNER_ENABLED"?
      "production_owner_disabled":"production_owner_primary_id_mismatch"));
  }
  console.log("PASS: physical primary-D1 owner inventory self-test is fail-closed");
}

async function main(){
  assert.equal(process.env.GITHUB_REPOSITORY,"JibrilMohamud/cove",
    "Refuse unprotected repository context");
  assert.equal(process.env.GITHUB_EVENT_NAME,"workflow_dispatch",
    "Protected live Writer inventory must be manually dispatched");
  assert.equal(process.env.GITHUB_REF,"refs/heads/main",
    "Protected live Writer inventory requires main");
  assert.equal(process.env.CF_ACCOUNT_ID,ACCOUNT,
    "Refuse to audit an unreviewed Cloudflare account");
  const workersToken=process.env.CF_WORKERS_METADATA_READ_TOKEN;
  const accountToken=process.env.CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN;
  const userToken=process.env.CF_USER_AUDIT_TOKEN;
  for(const [label,token] of [
    ["Workers Metadata Read",workersToken],
    ["Account API Tokens Read",accountToken],
    ["User API Tokens Read",userToken]
  ])assert.ok(typeof token==="string"&&token.length>=20,
    "Missing protected, scoped "+label+" credential");
  const transport=createPhysicalWriterReadTransport();
  const root="/accounts/"+ACCOUNT;
  function verifiedScripts(payload){
    const scripts=Array.isArray(payload.result)?payload.result:payload.result?.scripts;
    if(!Array.isArray(scripts)||scripts.length<2||scripts.length>1000)
      throw Error("Incomplete Worker inventory");
    if(payload.result_info?.total_count!==undefined&&
       payload.result_info.total_count!==scripts.length)
      throw Error("Partial Worker inventory must not certify release");
    const records=scripts.map(s=>{
      const id=s.id||s.name;
      if(typeof id!=="string"||!/^[a-z0-9_-]{3,128}$/.test(id)||
         typeof s.modified_on!=="string"||!Number.isFinite(Date.parse(s.modified_on)))
        throw Error("Invalid Worker inventory identifier or revision");
      return {id,modified_on:s.modified_on};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    if(new Set(records.map(s=>s.id)).size!==records.length)
      throw Error("Duplicate Worker inventory identifier");
    return records;
  }
  const baseline=verifiedScripts(await transport.get(root+"/workers/scripts",workersToken));
  const workers=[];
  // Existing group processing stays bounded, but the shared transport now
  // serializes all actual Cloudflare GET request starts (<=2/sec).
  for(let i=0;i<baseline.length;i+=12){
    const group=await Promise.all(baseline.slice(i,i+12).map(async script=>{
      const data=await transport.get(root+"/workers/scripts/"+script.id+"/settings",workersToken);
      if(!Array.isArray(data.result?.bindings))
        throw Error("Missing Worker bindings inventory");
      return {name:script.id,bindings:data.result.bindings};
    }));
    workers.push(...group);
  }
  // An inventory taken over minutes is never an atomic snapshot; at least
  // reject configuration changes detectable by Worker modification watermarks.
  const final=verifiedScripts(await transport.get(root+"/workers/scripts",workersToken));
  if(JSON.stringify(baseline)!==JSON.stringify(final))
    throw Error("Worker inventory modified during protected read");
  const accountTokens=completeTokenPage(
    await transport.get(root+"/tokens",accountToken));
  // User-scoped API token inventory is an independent credential and source.
  // 403 or missing permissions block certification; never convert to zero.
  let userTokensVerified=false;
  try{
    const userTokens=completeTokenPage(
      await transport.get("/user/tokens",userToken));
    userTokensVerified=completeTokenInventory(userTokens)&&
      userTokens.every(t=>t.status!=="active"||!tokenCanMutate(t));
  }catch{
    userTokensVerified=false;
  }
  const report=evaluatePhysicalWriterInventory({
    workers,tokens:accountTokens,userTokensVerified,
  });
  console.log(JSON.stringify({
    ...report,
    requestStats:transport.stats(),
    inventoryAtomicSnapshot:false,
    tokenScopeEvidenceOnly:true,
    releaseCertified:false,
  }));
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
