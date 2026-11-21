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
import {inspectActiveWriterBindings} from "./active-writer-bindings.mjs";
import {inspectSinglePrincipalCoverage} from "./single-principal-coverage.mjs";

const PRODUCTION_DB="4bd657ac-8789-403e-a28c-93aba8d0a989";
const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const OWNER="cove-legal-authority-production";
const PRIVILEGED_GROUPS=new Set([
  "D1 Write","Workers Admin","Workers Editor",
  "Workers Scripts Write","Workers Scripts Edit","Workers CI Write",
  "Individual Workers Admin","Individual Workers Editor",
  "Account API Tokens Write","API Tokens Write",
]);
function tokenCanMutate(token){
  return Array.isArray(token?.policies)&&token.policies.some(p=>
    Array.isArray(p?.permission_groups)&&p.permission_groups
      .some(group=>PRIVILEGED_GROUPS.has(group?.name)));
}
// Never interpret an unrecognized active Cloudflare permission as harmless.
// A reviewable read-only group must END in the exact word "Read"; other
// capabilities are unclassified until reviewed, independently of whether
// the known mutation group list happens to contain the provider's new name.
const READ_ONLY_GROUP=/^[A-Za-z0-9][A-Za-z0-9 &/._()+-]* (?:Read|Read-Only)$/;
// Cloudflare states permission-group names are cosmetic. Verify unexpected
// user-owned group labels against a FRESH provider catalog ID; only these three
// independently documented Read permissions may resolve a name-only mismatch.
// Never infer access from a dashboard category label, substring or suffix alone.
const DOCUMENTED_USER_READ_GROUPS=[
  {name:"API Tokens Read",alias:"API Tokens",scope:"com.cloudflare.api.user"},
  {name:"User Details Read",alias:"User Details",scope:"com.cloudflare.api.user"},
  {name:"Account Analytics Read",alias:"Account Analytics",scope:"com.cloudflare.api.account"},
];
const GROUP_ID=/^[a-f0-9]{32}$/;
async function proveUnreviewedUserGroupsReadOnly(get,userToken,userTokens){
  const unreviewed=userTokens.filter(t=>t.status==="active")
    .flatMap(t=>t.policies.flatMap(p=>p.permission_groups))
    .filter(group=>!PRIVILEGED_GROUPS.has(group.name)&&
      !READ_ONLY_GROUP.test(group.name));
  if(!unreviewed.length)return null;
  if(unreviewed.some(group=>!GROUP_ID.test(group.id||"")))
    return "read_group_identifier_missing";
  const verifiedIds=new Map();
  for(const {name,alias,scope} of DOCUMENTED_USER_READ_GROUPS){
    let page;
    try{
      page=await get("/user/tokens/permission_groups?name="+
        encodeURIComponent(name),userToken);
    }catch(error){
      return ["writer_audit_http_401","writer_audit_http_403"].includes(error?.message)
        ?"read_group_catalog_unauthorized":"read_group_catalog_unavailable";
    }
    const rows=page?.result,info=page?.result_info;
    if(!Array.isArray(rows))return "read_group_catalog_shape_invalid";
    if(rows.length!==1)return "read_group_catalog_not_singleton";
    if(rows[0]?.name!==name)return "read_group_catalog_name_mismatch";
    if(!GROUP_ID.test(rows[0]?.id||""))return "read_group_catalog_identifier_invalid";
    if(!Array.isArray(rows[0]?.scopes)||!rows[0].scopes.includes(scope))
      return "read_group_catalog_scope_mismatch";
    if(info&&(info.page!==1||info.count!==1))
      return "read_group_catalog_page_invalid";
    verifiedIds.set(rows[0].id,alias);
  }
  return unreviewed.every(group=>verifiedIds.get(group.id)===group.name)
    ?null:"read_group_alias_identifier_mismatch";
}
function tokenHasUnreviewedPermissions(token){
  return Array.isArray(token?.policies)&&token.policies.some(p=>
    Array.isArray(p?.permission_groups)&&p.permission_groups.some(group=>
      !PRIVILEGED_GROUPS.has(group?.name)&&
      !READ_ONLY_GROUP.test(group?.name||"")));
}
function completeTokenInventory(tokens){
  if(!Array.isArray(tokens))return false;
  return tokens.every(t=>{
    if(!t||typeof t.name!=="string"||!t.name.trim()||
      !["active","disabled","expired"].includes(t.status))return false;
    if(t.status!=="active")return true;
    return Array.isArray(t.policies)&&t.policies.length>0&&
      t.policies.every(p=>Array.isArray(p?.permission_groups)&&
        p.permission_groups.length>0&&p.permission_groups.every(g=>
          typeof g?.name==="string"&&g.name.trim().length>0));
  });
}

function completeTokenPage(response){
  const data=response?.result,info=response?.result_info;
  // Cloudflare's User Tokens API documents page/count/total_count but
  // not total_pages. total_count === returned count proves a complete page;
  // an explicitly supplied total_pages >1 still fails closed.
  if(!Array.isArray(data)||!info||info.page!==1||
    (info.total_pages!==undefined&&info.total_pages!==1)||
    !Number.isSafeInteger(info.count)||info.count!==data.length||
    !Number.isSafeInteger(info.total_count)||info.total_count!==data.length)
    throw Error("Incomplete Cloudflare token inventory page");
  return data;
}

// User tokens belong to an individual Cloudflare principal, not the account.
// Preserve the strict single-page and permission metadata contract; report
// only a bounded cause code. Never expose token identifiers, policy contents,
// upstream response bodies, credentials or user identities in CI artifacts.
export async function inspectUserTokenEvidence(get,userToken){
  let userTokens;
  try{
    userTokens=completeTokenPage(await get("/user/tokens",userToken));
  }catch(error){
    const code=String(error?.message||"");
    if(code==="writer_audit_http_401"||code==="writer_audit_http_403")
      return {verified:false,reason:"user_token_read_unauthorized"};
    if(code==="Incomplete Cloudflare token inventory page")
      return {verified:false,reason:"user_token_page_incomplete"};
    return {verified:false,reason:"user_token_read_unavailable"};
  }
  if(!completeTokenInventory(userTokens))
    return {verified:false,reason:"user_token_policy_incomplete"};
  if(userTokens.some(t=>t.status==="active"&&tokenCanMutate(t)))
    return {verified:false,reason:"active_user_token_mutation_capability"};
  if(userTokens.some(t=>t.status==="active"&&tokenHasUnreviewedPermissions(t))){
    const detail=await proveUnreviewedUserGroupsReadOnly(get,userToken,userTokens);
    if(detail)return {verified:false,reason:"active_user_token_permission_unreviewed",detail};
  }
  return {verified:true,reason:"current_user_inventory_clear"};
}

export function evaluatePhysicalWriterInventory({
  workers,tokens,userTokensVerified,userPrincipalCoverageVerified=false
}){
  const problems=[];
  if(!Array.isArray(workers)||!workers.length)
    problems.push("worker_inventory_unavailable");
  const owners=(workers||[]).filter(w=>w.name===OWNER);
  if(owners.length!==1)problems.push("production_owner_missing_or_duplicated");
  const owner=owners[0];
  if(owner?.activeVersionCount!==undefined&&owner.activeVersionCount!==1)
    problems.push("production_owner_active_version_ambiguous");
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
  // Provider permission names are extensible. Treat every active non-Read,
  // non-allowlisted group as unproven, not as positive read-only evidence.
  const unreviewed=(tokens||[]).filter(t=>t?.status==="active"&&
    tokenHasUnreviewedPermissions(t));
  if(unreviewed.length)problems.push("active_account_token_permission_unreviewed");
  if(userTokensVerified!==true)problems.push("user_token_inventory_unverified");
  // /user/tokens can attest only its issuing user. An account-wide
  // exclusivity certificate requires independent coverage of ALL account
  // members' user-owned tokens; no single credential establishes that.
  if(userPrincipalCoverageVerified!==true)
    problems.push("all_user_token_principals_unverified");
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
    userPrincipalCoverageVerified:userPrincipalCoverageVerified===true,
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
    ]}],userTokensVerified:true,userPrincipalCoverageVerified:true,
  });
  assert.equal(safe.certified,true);
  const oneUserOnly=evaluatePhysicalWriterInventory({
    workers:[owner],tokens:[],userTokensVerified:true,
  });
  assert.equal(oneUserOnly.certified,false);
  assert.ok(oneUserOnly.problems.includes("all_user_token_principals_unverified"));
  const unsafe=evaluatePhysicalWriterInventory({
    workers:[{...owner,bindings:owner.bindings.map(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED"?
      {...b,text:"0"}:b)},
      {name:"nonowner",bindings:[{type:"d1",name:"DB",database_id:PRODUCTION_DB}]}],
    tokens:[{name:"broad",status:"active",policies:[
      {permission_groups:[{name:"D1 Write"},{name:"Account API Tokens Write"}]},
    ]}],userTokensVerified:false,userPrincipalCoverageVerified:true,
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
  // A per-Worker Editor token can still control an authorized owner Worker;
  // never exempt it based on the role name without verifying scope IDs.
  // User-level API Tokens Write can mint an independently privileged token.
  for(const unsafeGroup of [
    "Individual Workers Editor","Individual Workers Admin",
    "API Tokens Write","Workers Scripts Edit","Workers CI Write"
  ]){
    const report=evaluatePhysicalWriterInventory({
      workers:[owner],tokens:[{name:"new-scope-token",status:"active",
        policies:[{permission_groups:[{name:unsafeGroup}]}]}],
      userTokensVerified:true,userPrincipalCoverageVerified:true,
    });
    assert.equal(report.certified,false);
    assert.ok(report.problems.includes("active_account_token_can_mutate_primary_or_owner"));
  }
  // Real Cloudflare scoped Worker metadata/content readers use Read-Only
  // suffixes. Keep these safe, but never permit Editor or unknown mutations.
  for(const readGroup of ["Workers Metadata Read-Only",
    "Individual Workers Content Read-Only","D1 Read"]){
    const report=evaluatePhysicalWriterInventory({
      workers:[owner],tokens:[{name:"reader",status:"active",
        policies:[{permission_groups:[{name:readGroup}]}]}],
      userTokensVerified:true,userPrincipalCoverageVerified:true,
    });
    assert.equal(report.certified,true);
  }
  for(const unknownName of ["Workers Direct Change","D1 Mutation","API Tokens Manage"]){
    const report=evaluatePhysicalWriterInventory({
      workers:[owner],tokens:[{name:"unknown-privilege",status:"active",
        policies:[{permission_groups:[{name:unknownName}]}]}],
      userTokensVerified:true,userPrincipalCoverageVerified:true,
    });
    assert.equal(report.certified,false);
    assert.ok(report.problems.includes("active_account_token_permission_unreviewed"));
  }
  for(const incomplete of [
    [{name:"missing-policies",status:"active"}],
    [{name:"empty-policies",status:"active",policies:[]}],
    [{name:"no-groups",status:"active",policies:[{}]}],
    [{name:"empty-groups",status:"active",policies:[{permission_groups:[]}]}],
    [{name:"unknown-group",status:"active",policies:[{permission_groups:[{}]}]}],
    [{name:"null-group",status:"active",policies:[{permission_groups:[null]}]}],
    [{name:"null-policy",status:"active",policies:[null]}],
    [{name:"wrong-groups-type",status:"active",policies:[{permission_groups:"Read"}]}],
    [{name:"wrong-policies-type",status:"active",policies:"Read"}],
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
  assert.deepEqual(completeTokenPage({result:[],result_info:{
    page:1,count:0,total_count:0,
  }}),[]);
  for(const info of [
    null,{page:1,total_pages:2,count:1,total_count:2},
    {page:2,total_pages:2,count:0,total_count:0},
    {page:1,total_pages:1,count:1,total_count:1},
    {page:1,count:0,total_count:1},
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
  const contentToken=process.env.CF_WORKERS_CONTENT_READ_TOKEN||workersToken;
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
      const active=await inspectActiveWriterBindings(async path=>{
        const token=path.includes("/versions/")?contentToken:workersToken;
        try{return (await transport.get(path,token)).result;}
        catch(error){
          if(path.includes("/versions/")&&["writer_audit_http_401","writer_audit_http_403"].includes(error?.message))
            throw Error("writer_audit_content_read_unauthorized");
          throw error;
        }
      },root+"/workers/scripts/"+script.id);
      return {name:script.id,...active};
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
  const userEvidence=await inspectUserTokenEvidence(transport.get,userToken);
  const principalEvidence=await inspectSinglePrincipalCoverage(transport.get,accountToken,userToken);
  const report=evaluatePhysicalWriterInventory({
    workers,tokens:accountTokens,userTokensVerified:userEvidence.verified,
    userPrincipalCoverageVerified:principalEvidence.verified,
  });
  console.log(JSON.stringify({
    ...report,
    bindingEvidenceSource:"active-immutable-versions",
    activeVersionCount:workers.reduce((sum,worker)=>sum+worker.activeVersionCount,0),
    userTokenEvidenceReason:userEvidence.reason,
    userTokenEvidenceDetail:userEvidence.detail||null,
    userPrincipalEvidenceReason:principalEvidence.reason,
    userPrincipalScope:principalEvidence.verified?"verified-single-member":"unverified",
    requestStats:transport.stats(),
    inventoryAtomicSnapshot:false,
    tokenScopeEvidenceOnly:true,
    releaseCertified:false,
  }));
  if(!report.certified)process.exitCode=1;
}
// Diagnostic-only: five fixed metadata GETs at most, no Worker enumeration.
// A successful user inventory is never a physical writer/identity certificate.
export async function userTokenPreflight(env=process.env,get){
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.equal(env.CF_ACCOUNT_ID,ACCOUNT);
  assert.ok(typeof env.CF_USER_AUDIT_TOKEN==="string"&&env.CF_USER_AUDIT_TOKEN.length>=20,
    "Missing protected scoped User API Tokens Read credential");
  const transport=get?null:createPhysicalWriterReadTransport();
  const evidence=await inspectUserTokenEvidence(get||transport.get,env.CF_USER_AUDIT_TOKEN);
  return {schema:"cove.user-token-readonly-preflight.v1",...evidence,
    requestStats:transport?.stats()||null,principalCoverageCertified:false,releaseCertified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.includes("--self-test"))selfTest();
  else if(process.argv.slice(2).join(" ")==="--user-token-preflight"){
    userTokenPreflight().then(report=>{console.log(JSON.stringify(report));
      if(!report.verified)process.exitCode=1;
    }).catch(()=>{console.error("BLOCKED: protected user-token preflight unavailable");process.exitCode=1;});
  }
  else main().catch(e=>{
    // Do not print auth headers, raw API responses, URL, credentials or ids.
    console.error("BLOCKED: production writer inventory could not be certified: "+
      String(e?.message||"unknown").slice(0,160));
    process.exitCode=1;
  });
}
