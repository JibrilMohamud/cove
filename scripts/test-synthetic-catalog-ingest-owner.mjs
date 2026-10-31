/* eslint-disable prettier/prettier -- Isolated SQLite test double for privately leased catalog ingestion commands. */
import assert from "node:assert/strict";

/**
 * This test-only transport is intentionally outside application and Worker
 * runtime bundles. It reproduces bounded state transitions in local SQLite,
 * never signs production authority, and never provides a missing-owner fallback.
 */
export function syntheticCatalogIngestOwner(db,secret,otherRoute=null){
 return {async fetch(request){
  assert.equal(request.method,"POST");
  assert.equal(request.headers.get("authorization"),"Bearer "+secret);
  const route=new URL(request.url).pathname;
  if(route!=="/catalog/private-ingest-state"){
   if(otherRoute)return otherRoute(request);
   return new Response(null,{status:404});
  }
  const {action,payload:p}=await request.json();
  const at=new Date().toISOString();
  let result={saved:false};
  if(action==="recover-interrupted"){
   assert.deepEqual(p,{});
   const stale=new Date(Date.now()-15*60_000).toISOString();
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Recovered after an interrupted EPUB download.',updated_at=? WHERE epub_status='downloading' AND updated_at<? AND ingest_status<>'quarantined'")
    .bind(at,stale).run();
   result={saved:true};
  }else if(action==="mark-unavailable"){
   const row=await db.prepare("SELECT id FROM gutenberg_source_cache WHERE id=? AND ingest_status<>'quarantined'").bind(p.cacheId).first();
   if(!row)return new Response(null,{status:409});
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status='unavailable',epub_last_error='No supported source asset was provided.' WHERE id=? AND ingest_status<>'quarantined'").bind(p.cacheId).run();
   result={saved:true};
  }else if(action==="claim-download"){
   const row=await db.prepare("UPDATE gutenberg_source_cache SET epub_status='downloading',epub_last_error='',updated_at=? WHERE id=? AND epub_status IN ('pending','retry') AND (epub_next_attempt_at='' OR epub_next_attempt_at<=?) AND ingest_status<>'quarantined' AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_cache.source_id AND s.enabled=1) RETURNING id").bind(at,p.cacheId,at).first();
   result={claimed:!!row};
  }else if(action==="touch-attempt"){
   await db.prepare("UPDATE gutenberg_source_states SET epub_last_attempt_at=? WHERE source_id=? AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_states.source_id AND s.enabled=1)").bind(at,p.sourceId).run();
   result={saved:true};
  }else if(action==="set-backoff"){
   const end=Date.parse(p.retryAt);
   if(!Number.isFinite(end)||end<Date.now()+59_000||end>Date.now()+24*3600_000+10_000)
    return new Response(null,{status:409});
   await db.prepare("UPDATE gutenberg_source_states SET epub_retry_after=? WHERE source_id=?").bind(p.retryAt,p.sourceId).run();
   result={saved:true};
  }else if(action==="mark-failure"){
   const row=await db.prepare("SELECT epub_attempts FROM gutenberg_source_cache WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'").bind(p.cacheId).first();
   if(!row||Number(row.epub_attempts)+1!==p.attempts||!["retry","failed"].includes(p.status))
    return new Response(null,{status:409});
   if(p.status==="retry"&&(!Number.isFinite(Date.parse(p.retryAt))||Date.parse(p.retryAt)>Date.now()+24*3600_000))
    return new Response(null,{status:409});
   await db.prepare("UPDATE gutenberg_source_cache SET epub_status=?,epub_attempts=?,epub_next_attempt_at=?,epub_last_error=? WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'").bind(p.status,p.attempts,p.retryAt,p.message,p.cacheId).run();
   result={saved:true};
  }else return new Response(null,{status:409});
  return Response.json({schema:"cove.owner-ingestion-state-qa.v1",ownerFirst:true,action,result});
 }};
}
