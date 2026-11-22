/* eslint-disable prettier/prettier -- Protected primary legal-history SELECT-only transport. */
/**
 * Full production historical inventory. This is NOT an owner receipt, is NOT
 * a right to sell or restore, and must not be imported into serving code.
 * Only protected workflow_dispatch on reviewed main may read production.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
import {createProtectedD1ReadThrottle} from "./protected-d1-read-throttle.mjs";
import {HISTORICAL_SQL,checkedHistoricalAggregate,checkedHistoricalD1Response,
  verifyHistoricalPrimaryInventory} from "./primary-historical-rights-inventory-policy.mjs";

const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
const URL="https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+"/d1/database/"+PRIMARY+"/query";
const KINDS=Object.freeze(["state","evidence","exposure"]);
const MAX_BYTES=16_384;
function permission(env=process.env,args=process.argv){
  if(args.length!==3||args[2]!=="--live"||
     env.GITHUB_ACTIONS!=="true"||env.GITHUB_EVENT_NAME!=="workflow_dispatch"||
     env.GITHUB_REF!=="refs/heads/main"||env.CF_ACCOUNT_ID!==ACCOUNT||
     env.COVE_PRODUCTION_D1_ID!==PRIMARY||
     env.COVE_PRODUCTION_LEGAL_AUDIT_ONLY!=="1"||
     typeof env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN!=="string"||
     env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN.length<20)
    throw Error("historical_primary_protected_read_permission_missing");
}
async function boundedJson(response){
  if(!response.body)throw Error("historical_primary_empty_response");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let out="",bytes=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      bytes+=next.value.byteLength;
      if(bytes>MAX_BYTES){
        await reader.cancel().catch(()=>undefined);
        throw Error("historical_primary_response_oversized");
      }
      out+=decoder.decode(next.value,{stream:true});
    }
    out+=decoder.decode();
    return JSON.parse(out);
  }catch{
    throw Error("historical_primary_response_unavailable");
  }finally{
    reader.releaseLock();
  }
}
if(process.argv.includes("--self-test")){
  assert.equal(Object.keys(HISTORICAL_SQL).sort().join(","),[...KINDS].sort().join(","));
  for(const sql of Object.values(HISTORICAL_SQL)){
    assert.match(sql,/^SELECT\b/);
    assert.doesNotMatch(sql,/;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|PRAGMA|VACUUM)\b/i);
  }
  const sample={state:[{product_total:2,active_products:1,inactive_products:1,
    grant_total:1,active_allow_grants:1,suspended_grants:0,
    active_uncovered:0,inactive_without_grant:1,contracts:0,contract_versions:0,
    active_markets:1}],evidence:[{joined_grants:1,missing_evidence:0,
    unapproved_or_mismatched:0,legacy_evidence_hashes:1,other_evidence_types:0}],
    exposure:[{retail_rows:1,scoped_grants:1,scoped_territories:1,
      explicit_deny_grants:0,copyright_notices:0}]};
  const data=Object.fromEntries(KINDS.map(k=>[k,checkedHistoricalAggregate(k,sample[k])]));
  assert.equal(verifyHistoricalPrimaryInventory(data,structuredClone(data)).releaseCertified,false);
  for(const bad of [[],["--live"],["a","b","--live"]])
    assert.throws(()=>permission({},bad));
  console.log("PASS: bounded, nonauthorizing full-primary historical inventory self-test");
}else{
  permission();
  const token=process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN;
  const throttle=createProtectedD1ReadThrottle({
    maxAttempts:6,max429Responses:0,minRequestGapMs:750,
  });
  async function read(kind){
    const sql=HISTORICAL_SQL[kind];
    if(!KINDS.includes(kind)||!sql||!/^SELECT\b/.test(sql))
      throw Error("historical_primary_sql_not_reviewed");
    const res=await throttle.request(()=>fetch(URL,{
      method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({sql}),signal:AbortSignal.timeout(30_000),
    }));
    if(!res.ok)throw Error("historical_primary_d1_http_"+res.status);
    const parsed=await boundedJson(res);
    return checkedHistoricalAggregate(kind,checkedHistoricalD1Response(parsed));
  }
  async function capture(){
    const data={};
    for(const kind of KINDS)data[kind]=await read(kind);
    return data;
  }
  const first=await capture(),second=await capture();
  const result=verifyHistoricalPrimaryInventory(first,second);
  const digest=createHash("sha256").update(JSON.stringify({first,second})).digest("hex");
  const report={...result,aggregateSha256:digest,
    primaryReadRequests:throttle.stats().httpAttempts,
    at:new Date().toISOString()};
  mkdirSync("artifacts/production-rights-history",{recursive:true});
  writeFileSync("artifacts/production-rights-history/inventory.json",
    JSON.stringify(report,null,2)+"\n");
  const summary=[
    "## Protected primary historical-rights inventory (NOT release approval)",
    "",
    "Products: "+result.scannedProductCount+"; active: "+first.state.active_products+
      "; inactive: "+first.state.inactive_products,
    "Grants: "+first.state.grant_total+"; suspended: "+first.state.suspended_grants+
      "; approved evidence linkage gaps: "+first.evidence.missing_evidence,
    "Legacy non-SHA-256 evidence fingerprints: "+first.evidence.legacy_evidence_hashes,
    "Historical aggregate structural consistency: "+result.historicalInventoryConsistent,
    "Current owner authorization: NOT PROVEN. Atomic publication: NOT PROVEN.",
    "Release decision: NO-GO; aggregate fingerprint: "+digest,
    "Blocking proof classes: "+result.blockers.join(", "),
  ].join("\n")+"\n";
  console.log(summary);
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  // Missing current owner and cryptographic history cannot be converted into
  // positive rights by any downstream consumer. Only structural corruption
  // fails the diagnostic run; the report itself remains NO-GO always.
  if(!result.historicalInventoryConsistent)
    throw Error("historical_primary_source_structure_not_reconciled");
}
