/* eslint-disable prettier/prettier -- Bounded protected SELECT-only primary grant-history replay. */
/**
 * Protected manual replay of the immutable primary D1 rights_grant_audit and
 * current rights_grants. NEVER writes to production, NEVER publishes rights,
 * NEVER outputs grant IDs/snapshot JSON or rightsholder details.
 *
 * Runs on reviewed main in protected release-audit environment only. The
 * primary D1 can change between SELECTs: boundary recheck detects structural
 * drift but is NOT an atomic historical snapshot or an owner-denial epoch.
 */
import assert from "node:assert/strict";
import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
import {createProtectedD1ReadThrottle} from "./protected-d1-read-throttle.mjs";
import {checkedHistoricalD1Response} from "./primary-historical-rights-inventory-policy.mjs";
import {createGrantHistoryReplay,checkedGrantHistoryBoundary,
  HISTORY_BATCH_SIZE,HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,
  HISTORY_CURRENT_SQL} from "./primary-grant-event-replay-policy.mjs";

const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
const URL="https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+
  "/d1/database/"+PRIMARY+"/query";
const MAX_BYTES=1_048_576;
function permission(env=process.env,args=process.argv){
  if(args.length!==3||args[2]!=="--live"||env.GITHUB_ACTIONS!=="true"||
    env.GITHUB_EVENT_NAME!=="workflow_dispatch"||
    env.GITHUB_REF!=="refs/heads/main"||env.CF_ACCOUNT_ID!==ACCOUNT||
    env.COVE_PRODUCTION_D1_ID!==PRIMARY||
    env.COVE_PRODUCTION_LEGAL_AUDIT_ONLY!=="1"||
    typeof env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN!=="string"||
    env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN.length<20)
    throw Error("protected_grant_history_replay_permission_missing");
}
function sqlContract(){
  for(const sql of [HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL]){
    if(!sql.startsWith("SELECT ")||/;|\b(?:UPDATE|DELETE|INSERT|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|VACUUM)\b/i.test(sql))
      throw Error("protected_grant_history_sql_mutation_denied");
  }
  assert.match(HISTORY_EVENTS_SQL,/ORDER BY rowid LIMIT 384$/);
  assert.match(HISTORY_CURRENT_SQL,/ORDER BY g.id LIMIT 384$/);
}
async function bounded(response){
  if(!response.body)throw Error("protected_grant_history_missing_body");
  const stream=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let raw="",bytes=0;
  try{
    while(true){
      const item=await stream.read();
      if(item.done)break;
      bytes+=item.value.byteLength;
      if(bytes>MAX_BYTES){
        await stream.cancel().catch(()=>undefined);
        throw Error("protected_grant_history_oversized_d1_response");
      }
      raw+=decoder.decode(item.value,{stream:true});
    }
    raw+=decoder.decode();
    return JSON.parse(raw);
  }catch{
    throw Error("protected_grant_history_invalid_d1_response");
  }finally{stream.releaseLock();}
}
if(process.argv.includes("--self-test")){
  sqlContract();
  for(const env of [{}, {GITHUB_ACTIONS:"true"}])
    assert.throws(()=>permission(env,["node","script","--live"]));
  console.log("PASS: grant replay SELECT-only SQL and protected credential contract");
}else{
  sqlContract();permission();
  const replay=createGrantHistoryReplay();
  const token=process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN;
  const throttle=createProtectedD1ReadThrottle({
    maxAttempts:700,max429Responses:2,maxRetryWaitMs:360_000,
    minRequestGapMs:2500,
    onThrottle:({retry,delayMs})=>console.log(
      JSON.stringify({event:"protected_replay_read_throttled",retry,delayMs})),
  });
  const artifact="artifacts/production-rights-history/grant-event-replay.json";
  const progress={phase:"boundary",eventsReplayed:0,grantsCompared:0};
  function checkpoint(failureClass){
    mkdirSync("artifacts/production-rights-history",{recursive:true});
    writeFileSync(artifact,JSON.stringify({
      schema:"cove.primary-grant-event-replay-incomplete.v1",
      complete:false,...progress,...throttle.stats(),
      ...(failureClass?{failureClass}:{}),
      inspectedAt:new Date().toISOString(),
      historicalRightsReconciled:false,currentOwnerVerified:false,
      authorizing:false,permitsPublication:false,releaseCertified:false,
    },null,2)+"\n");
  }
  checkpoint();
  async function query(sql,params=[]){
    if(![HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL].includes(sql))
      throw Error("protected_grant_history_unreviewed_sql");
    if(sql===HISTORY_BOUNDARY_SQL&&params.length!==0)
      throw Error("protected_grant_history_invalid_params");
    if(sql!==HISTORY_BOUNDARY_SQL&&
      (params.length!==1||(sql===HISTORY_EVENTS_SQL?
        !Number.isSafeInteger(params[0])||params[0]<0:
        typeof params[0]!=="string"||params[0].length>200)))
      throw Error("protected_grant_history_invalid_params");
    const response=await throttle.request(()=>fetch(URL,{
      method:"POST",
      headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({sql,params}),
      signal:AbortSignal.timeout(45_000),
    }));
    if(!response.ok)throw Error("protected_grant_history_http_"+response.status);
    const parsed=await bounded(response);
    return checkedHistoricalD1Response(parsed);
  }
  try{
  const first=checkedGrantHistoryBoundary(await query(HISTORY_BOUNDARY_SQL));
  progress.phase="audit-events";
  let seq=0,events=0;
  const maxAuditPages=Math.ceil(first.audit_rows/HISTORY_BATCH_SIZE)+1;
  for(let page=0;page<maxAuditPages;page++){
    const rows=await query(HISTORY_EVENTS_SQL,[seq]);
    if(rows.length>HISTORY_BATCH_SIZE)
      throw Error("protected_grant_history_event_page_oversized");
    for(const row of rows){
      replay.audit(row);
      seq=row.event_seq;
      events++;
      progress.eventsReplayed=events;
    }
    checkpoint();
    if(events>first.audit_rows)
      throw Error("protected_grant_history_audit_count_changed");
    if(rows.length<HISTORY_BATCH_SIZE)break;
    if(page===maxAuditPages-1)
      throw Error("protected_grant_history_audit_pagination_unbounded");
  }
  let grantId="",grants=0;
  progress.phase="current-grants";
  const maxGrantPages=Math.ceil(first.grant_rows/HISTORY_BATCH_SIZE)+1;
  for(let page=0;page<maxGrantPages;page++){
    const rows=await query(HISTORY_CURRENT_SQL,[grantId]);
    if(rows.length>HISTORY_BATCH_SIZE)
      throw Error("protected_grant_history_current_page_oversized");
    for(const row of rows){
      replay.current(row);
      grantId=row.grant_id;
      grants++;
      progress.grantsCompared=grants;
    }
    checkpoint();
    if(grants>first.grant_rows)
      throw Error("protected_grant_history_grants_count_changed");
    if(rows.length<HISTORY_BATCH_SIZE)break;
    if(page===maxGrantPages-1)
      throw Error("protected_grant_history_grants_pagination_unbounded");
  }
  progress.phase="final-boundary";checkpoint();
  const second=checkedGrantHistoryBoundary(await query(HISTORY_BOUNDARY_SQL));
  const reviewed=replay.result(first,second);
  const result={...reviewed,complete:true,sourceReadOnly:true,
    primaryHttpAttempts:throttle.stats().httpAttempts,
    rateLimitedResponses:throttle.stats().rateLimitedResponses,
    rateLimitWaitMs:throttle.stats().rateLimitWaitMs,
    inspectedAt:new Date().toISOString()};
  mkdirSync("artifacts/production-rights-history",{recursive:true});
  writeFileSync(artifact,
    JSON.stringify(result,null,2)+"\n");
  const summary=[
    "## Protected full primary grant-event replay — diagnostic only",
    "",
    "Audit events: "+result.eventsReplayed+"; current grants: "+result.grantsCompared,
    "Inserts: "+result.counts.inserts+"; updates: "+result.counts.updates,
    "Ambiguous event-timestamp cohorts: "+result.counts.ambiguousTimestampGroups,
    "Backdated audit events: "+result.counts.backdatedEventTimestamps,
    "Grants with unresolved chronology: "+result.chronologyUnresolvedGrants,
    "Currently active/allow in that unresolved cohort: "+result.chronologyUnresolvedActiveAllowGrants,
    "Mismatched current grant snapshots: "+result.counts.conflictingCurrentGrants,
    "Lost/current grant IDs: "+result.counts.missingGrants,
    "Replay boundary identical: "+result.scanBoundaryIdentical,
    "Rights still NOT reconciled; production owner NOT verified.",
    "Current D1 writer exclusivity NOT certified. NO GO.",
    "Blocker classes: "+result.blockers.join(", "),
    "Replay fingerprints: "+result.replayEventSha256+" / "+result.currentStateSha256,
  ].join("\n")+"\n";
  console.log(summary);
  if(process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  if(!result.scanBoundaryIdentical||result.counts.missingGrants>0||
    result.counts.conflictingCurrentGrants>0||
    result.counts.orphanReplayedGrants>0)
    throw Error("protected_grant_history_current_parity_failed");
  // Even a perfectly replayed grant audit CANNOT be used to publish rights.
  // The missing independent owner denial and real provenance remain blockers.
  }catch(error){
    // Never copy an exception body (which might carry SQL, a URL or evidence)
    // to the artifact. Preserve only a fixed error class and aggregate progress.
    const message=error instanceof Error?error.message:"";
    const failureClass=/rate_limited/.test(message)?"rate-limited":
      /http_(401|403)$/.test(message)?"authentication-denied":
      /current_parity_failed/.test(message)?"current-parity-failed":
      /Timeout|Abort/.test(message)?"transport-timeout":"protocol-or-transport-failed";
    if(failureClass!=="current-parity-failed")checkpoint(failureClass);
    throw Error("protected_grant_history_incomplete_"+failureClass);
  }
}
