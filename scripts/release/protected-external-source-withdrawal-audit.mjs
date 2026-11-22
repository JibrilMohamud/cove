/* eslint-disable prettier/prettier -- Protected source-withdrawal inventory is select-only and deny-first. */
/**
 * Read current source feed/freshness/provenance and local withdrawal counters.
 * A source scan is NEVER interpreted as complete legal withdrawal history.
 * Only protected workflow_dispatch on reviewed main can invoke --live.
 */
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {createProtectedD1ReadThrottle} from "./protected-d1-read-throttle.mjs";
import {checkedHistoricalD1Response} from "./primary-historical-rights-inventory-policy.mjs";
import {SOURCE_SQL,checkedSourceCoverageRows,sourceCoverageReport,
  verifySourceSql} from "./external-source-withdrawal-policy.mjs";

const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
const URL="https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+
  "/d1/database/"+PRIMARY+"/query";
const KINDS=["sources","grants","cache","external","chronology"];
const MAX_BYTES=48_000;
const REPORT="artifacts/production-rights-history/external-source-withdrawal-coverage.json";
function permission(env=process.env,args=process.argv){
  if(args.length!==3||args[2]!=="--live"||
    env.GITHUB_ACTIONS!=="true"||env.GITHUB_EVENT_NAME!=="workflow_dispatch"||
    env.GITHUB_REF!=="refs/heads/main"||env.CF_ACCOUNT_ID!==ACCOUNT||
    env.COVE_PRODUCTION_D1_ID!==PRIMARY||
    env.COVE_PRODUCTION_EXTERNAL_SOURCE_AUDIT_ONLY!=="1"||
    typeof env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN!=="string"||
    env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN.length<20)
    throw Error("protected_external_source_permission_missing");
}
async function boundedJson(res){
  if(!res.body)throw Error("protected_external_source_response_missing");
  const reader=res.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let raw="",n=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      n+=part.value.byteLength;
      if(n>MAX_BYTES){
        await reader.cancel().catch(()=>undefined);
        throw Error("protected_external_source_response_too_large");
      }
      raw+=decoder.decode(part.value,{stream:true});
    }
    raw+=decoder.decode();
    return JSON.parse(raw);
  }catch{throw Error("protected_external_source_response_invalid");}
  finally{reader.releaseLock();}
}
function artifact(report){
  mkdirSync("artifacts/production-rights-history",{recursive:true});
  writeFileSync(REPORT,JSON.stringify(report,null,2)+"\n",{mode:0o600});
}
if(process.argv.includes("--self-test")){
  verifySourceSql();
  assert.deepEqual(Object.keys(SOURCE_SQL),KINDS);
  for(const env of [{},{GITHUB_ACTIONS:"true"}])
    assert.throws(()=>permission(env,["node","entry","--live"]));
  console.log("PASS: fixed source evidence SQL and protected live-only read permission");
}else{
  verifySourceSql();permission();
  artifact({schema:"cove.external-source-withdrawal-incomplete.v1",
    complete:false,authorizing:false,permitsPublication:false,
    currentOwnerVerified:false,releaseCertified:false});
  const token=process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN;
  const throttle=createProtectedD1ReadThrottle({
    maxAttempts:12,max429Responses:2,maxRetryWaitMs:180_000,
    minRequestGapMs:3500,
    onThrottle:({retry,delayMs})=>
      console.log(JSON.stringify({event:"external_source_read_throttled",retry,delayMs})),
  });
  async function read(kind){
    if(!KINDS.includes(kind)||typeof SOURCE_SQL[kind]!=="string")
      throw Error("protected_external_source_query_not_reviewed");
    const response=await throttle.request(()=>fetch(URL,{
      method:"POST",
      headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({sql:SOURCE_SQL[kind]}),
      signal:AbortSignal.timeout(45_000),
    }));
    if(!response.ok)throw Error("protected_external_source_http_"+response.status);
    const parsed=await boundedJson(response);
    const rows=checkedHistoricalD1Response(parsed);
    return checkedSourceCoverageRows(kind,rows);
  }
  try{
    const first={},second={};
    for(const kind of KINDS)first[kind]=await read(kind);
    for(const kind of KINDS)second[kind]=await read(kind);
    const evaluated=sourceCoverageReport(first,second);
    const result={...evaluated,complete:true,
      primaryReadAttempts:throttle.stats().httpAttempts,
      at:new Date().toISOString()};
    artifact(result);
    const lines=[
      "## Protected external-source/withdrawal evidence inventory",
      "",
      "Source registry rows: "+result.sourceCount,
      "Active primary grants: "+result.activeGrantRows,
      "Total primary grants: "+result.recordedGrantRows,
      "Ambiguous historical grant IDs: "+result.evidence.conflictingChronology.ambiguous_grants,
      "Currently active ambiguous grants: "+result.evidence.conflictingChronology.ambiguous_active_grants,
      "Historical terminal-to-active grants: "+result.evidence.conflictingChronology.reactivated_grants,
      "Historical backdated grants: "+result.evidence.conflictingChronology.backdated_grants,
      "Double-read unchanged: "+result.unchangedAcrossRead,
      "External withdrawal ledger independently complete: NO",
      "Owner denial epoch current/verified: NO",
      "Authorizing: NO; release certified: NO",
      "Blocked proof classes: "+result.blockers.join(", "),
    ];
    const summary=lines.join("\n")+"\n";
    console.log(summary);
    if(process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
    if(!result.unchangedAcrossRead)
      throw Error("protected_external_source_changed_during_audit");
  }catch{
    // No exception payload, source identifiers or private evidence is logged.
    artifact({schema:"cove.external-source-withdrawal-incomplete.v1",
      complete:false,authorizing:false,permitsPublication:false,
      currentOwnerVerified:false,releaseCertified:false,
      primaryReadAttempts:throttle.stats().httpAttempts,
      reason:"source_inventory_not_completed"});
    throw Error("protected_external_source_audit_failed_closed");
  }
}
