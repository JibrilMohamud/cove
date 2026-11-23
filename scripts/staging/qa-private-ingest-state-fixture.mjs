/* eslint-disable prettier/prettier -- Isolated QA owner transport for asset capacity tests.
 * Runs only in synthetic localBindings SQLite. Not a production API or legal grant.
 * Positive publication remains separately verified by the caller's owner stub.
 */
import {createHash} from "node:crypto";
const now=()=>new Date().toISOString();
const bad=()=>new Response(null,{status:409});
const exact=(p,names)=>Object.keys(p).length===names.length&&names.every(k=>Object.hasOwn(p,k));
export async function respondQaPrivateIngestState(db,request){
 const path=new URL(request.url).pathname;
 if(path!=="/catalog/private-ingest-state"||request.method!=="POST")return bad();
 const {action,payload:p}=await request.json();
 if(!p||typeof p!=="object"||Array.isArray(p))return bad();
 let result={saved:true};
 switch(action){
  case "recover-interrupted":{
   if(!exact(p,[]))return bad();
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Recovered after an interrupted EPUB download.',updated_at=? WHERE epub_status='downloading' AND updated_at<? AND ingest_status<>'quarantined'")
    .bind(now(),new Date(Date.now()-15*60_000).toISOString()).run();
   break;
  }
  case "mark-unavailable":{
   if(!exact(p,["cacheId"])||typeof p.cacheId!=="string")return bad();
   const row=await db.prepare("SELECT source_id FROM gutenberg_source_cache WHERE id=? AND ingest_status<>'quarantined'").bind(p.cacheId).first();
   if(!row)return bad();
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status='unavailable',epub_last_error='No supported source asset was provided.' WHERE id=? AND ingest_status<>'quarantined'").bind(p.cacheId).run();
   break;
  }
  case "claim-download":{
   if(!exact(p,["cacheId"])||typeof p.cacheId!=="string")return bad();
   const at=now();
   const claimed=await db.prepare("UPDATE gutenberg_source_cache SET epub_status='downloading',epub_last_error='',updated_at=? WHERE id=? AND epub_status IN ('pending','retry') AND (epub_next_attempt_at='' OR epub_next_attempt_at<=?) AND ingest_status<>'quarantined' AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_cache.source_id AND s.enabled=1) RETURNING id")
    .bind(at,p.cacheId,at).first();
   result={claimed:!!claimed};
   break;
  }
  case "touch-attempt":{
   if(!exact(p,["sourceId"])||!["pg_us","pg_ca","pg_au","pg_eu"].includes(p.sourceId))return bad();
   await db.prepare("UPDATE gutenberg_source_states SET epub_last_attempt_at=? WHERE source_id=? AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_states.source_id AND s.enabled=1)")
    .bind(now(),p.sourceId).run();
   break;
  }
  case "set-backoff":{
   if(!exact(p,["sourceId","retryAt"])||!["pg_us","pg_ca","pg_au","pg_eu"].includes(p.sourceId)||
      !Number.isFinite(Date.parse(p.retryAt))||Date.parse(p.retryAt)<Date.now()+59_000||
      Date.parse(p.retryAt)>Date.now()+24*3600_000+10_000)return bad();
   await db.prepare("UPDATE gutenberg_source_states SET epub_retry_after=? WHERE source_id=?")
    .bind(p.retryAt,p.sourceId).run();
   break;
  }
  case "mark-failure":{
   if(!exact(p,["cacheId","attempts","status","retryAt","message"])||
      !Number.isInteger(p.attempts)||p.attempts<1||p.attempts>100||
      !["retry","failed"].includes(p.status)||typeof p.message!=="string"||
      typeof p.retryAt!=="string"||typeof p.cacheId!=="string")return bad();
   const prior=await db.prepare("SELECT epub_attempts FROM gutenberg_source_cache WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'").bind(p.cacheId).first();
   if(!prior||Number(prior.epub_attempts)+1!==p.attempts||
     (p.status==="retry"&&(!Number.isFinite(Date.parse(p.retryAt))||Date.parse(p.retryAt)>Date.now()+24*3600_000)))return bad();
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status=?,epub_attempts=?,epub_next_attempt_at=?,epub_last_error=? WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'")
    .bind(p.status,p.attempts,p.retryAt,p.message,p.cacheId).run();
   break;
  }
  case "acquire-regional":{
   if(!exact(p,["sourceId","leaseToken"])||!["pg_ca","pg_au","pg_eu"].includes(p.sourceId)||
      typeof p.leaseToken!=="string")return bad();
   const exists=await db.prepare("SELECT id FROM gutenberg_sources WHERE id=? AND enabled=1").bind(p.sourceId).first();
   if(!exists)return bad();
   const at=now(),until=new Date(Date.now()+5*60_000).toISOString();
   const claimed=await db.prepare("UPDATE gutenberg_source_states SET status='running',lease_token=?,lease_until=?,last_run_at=?,last_error='',updated_at=? WHERE source_id=? AND (lease_until IS NULL OR lease_until='' OR lease_until<?) AND (next_run_at IS NULL OR next_run_at='' OR next_run_at<=?) RETURNING source_id")
     .bind(p.leaseToken,until,at,at,p.sourceId,at,at).first();
   result={claimed:!!claimed};
   break;
  }
  case "mark-degraded":{
   if(!exact(p,["sourceId","leaseToken","message"])||typeof p.message!=="string")return bad();
   const at=now(),next=new Date(Date.now()+6*3600_000).toISOString();
   const run=await db.prepare("UPDATE gutenberg_source_states SET status='degraded',last_error=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=? AND status='running'")
     .bind(p.message,next,at,p.sourceId,p.leaseToken).run();
   result={saved:Number(run.meta?.changes||0)>0};break;
  }
  case "mark-regional-failed":{
   if(!exact(p,["sourceId","leaseToken","message","attempts","retryAt"]))return bad();
   const prior=await db.prepare("SELECT attempts FROM gutenberg_source_states WHERE source_id=? AND lease_token=? AND status='running'").bind(p.sourceId,p.leaseToken).first();
   if(!prior||Number(prior.attempts)+1!==p.attempts||Date.parse(p.retryAt)>Date.now()+24*3600_000)return bad();
   await db.prepare("UPDATE gutenberg_source_states SET status='failed',last_error=?,attempts=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=? AND status='running'")
    .bind(p.message,p.attempts,p.retryAt,now(),p.sourceId,p.leaseToken).run();
   break;
  }
  default:return bad();
 }
 return Response.json({schema:"cove.owner-ingestion-state-qa.v1",ownerFirst:true,action,result});
}
/* The QA source fixture independently checks the live lease/run on the same
 * isolated DB used by the backend. It cannot approve rights or a paid grant. */
export async function respondQaRegionalCheckpoint(db,request){
 if(new URL(request.url).pathname!=="/catalog/regional-state"||request.method!=="POST")return bad();
 const input=await request.json();
 if(input?.action!=="unchanged"||!["pg_ca","pg_au","pg_eu"].includes(input.sourceId)||
    typeof input.leaseToken!=="string"||typeof input.runId!=="string"||
    !input.data||!Number.isFinite(Date.parse(input.data.next)))return bad();
 const at=now();
 const lease=await db.prepare("SELECT source_id FROM gutenberg_source_states WHERE source_id=? AND status='running' AND lease_token=? AND lease_until>?")
    .bind(input.sourceId,input.leaseToken,at).first();
 const run=await db.prepare("SELECT id FROM gutenberg_ingest_runs WHERE id=? AND source_id=? AND status='running'")
    .bind(input.runId,input.sourceId).first();
 if(!lease||!run)return bad();
 await db.prepare("UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?,attempts=0,next_run_at=?,lease_token=NULL,lease_until=NULL,etag=COALESCE(NULLIF(?,''),etag),last_modified=COALESCE(NULLIF(?,''),last_modified),updated_at=? WHERE source_id=? AND lease_token=?")
    .bind(at,input.data.next,input.data.etag||"",input.data.lastModified||"",at,input.sourceId,input.leaseToken).run();
 return Response.json({schema:"cove.owner-regional-state.v1",ownerFirst:true,sourceId:input.sourceId,runId:input.runId,action:input.action,acquired:true});
}


/** Test-only stand-in for the private verified US EPUB completion command.
 * Independently checks local SQLite evidence and actual stored object bytes.
 * Never imported by the deployed legal owner or public API. */
export async function respondQaUsEpubCompletion(db,bucket,request,secret,validateEpub){
 if(new URL(request.url).pathname!=="/catalog/complete-us-epub-ingest"||
    request.method!=="POST"||
    request.headers.get("authorization")!=="Bearer "+secret)return bad();
 const input=await request.json();
 if(!input||typeof input!=="object"||Array.isArray(input)||
    !exact(input,["cacheId","sha256"])||
    !/^[0-9]{1,10}$/.test(input.cacheId)||
    !/^[a-f0-9]{64}$/.test(input.sha256))return bad();
 const active=await db.prepare(
   "SELECT c.id FROM gutenberg_source_cache c JOIN gutenberg_sources s ON s.id=c.source_id AND s.enabled=1 WHERE c.id=? AND c.source_id='pg_us' AND c.copyright=0 AND c.rights_status='public-domain' AND c.commercial_use_status='approved' AND c.ingest_status='active' AND c.epub_status='downloading' AND c.rights_territories_json='[\"US\"]' AND EXISTS(SELECT 1 FROM gutenberg_rights_evidence e WHERE e.cache_id=c.id AND e.status='approved' AND e.determination='public-domain' AND e.territory_code='US')"
 ).bind(input.cacheId).first();
 if(!active)return bad();
 const object=await bucket.get("epubs/"+input.cacheId+".epub");
 if(!object||!Number.isSafeInteger(object.size)||object.size<100||
    object.size>25*1024*1024)return bad();
 const bytes=new Uint8Array(await object.arrayBuffer());
 if(bytes.byteLength!==object.size)return bad();
 try{await validateEpub(bytes);}catch{return bad();}
 const actual=createHash("sha256").update(bytes).digest("hex");
 if(actual!==input.sha256)return bad();
 const result=await db.prepare(
   "UPDATE gutenberg_source_cache SET epub_status='completed',epub_cached_at=?,epub_last_error='',epub_next_attempt_at='',content_hash=?,canonicalization_version='pgus-upstream-v1' WHERE id=? AND source_id='pg_us' AND copyright=0 AND rights_status='public-domain' AND commercial_use_status='approved' AND ingest_status='active' AND epub_status='downloading' AND rights_territories_json='[\"US\"]' AND EXISTS(SELECT 1 FROM gutenberg_rights_evidence e WHERE e.cache_id=gutenberg_source_cache.id AND e.status='approved' AND e.determination='public-domain' AND e.territory_code='US')"
 ).bind(now(),actual,input.cacheId).run();
 if(Number(result.meta?.changes||0)!==1)return bad();
 return Response.json({schema:"cove.owner-us-epub-ingest.v1",ownerFirst:true,
  cacheId:input.cacheId,sha256:actual,saved:true});
}
