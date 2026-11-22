/* eslint-disable prettier/prettier -- Fixed, nonauthorizing external-origin withdrawal coverage inventory. */
/**
 * A current Gutenberg feed poll or approved cache record does NOT prove that
 * every historical external withdrawal arrived and was acknowledged by Cove's
 * legal owner. This module only reports provenance/freshness gaps, counts and
 * denial blockers; it NEVER produces a legal allow receipt.
 *
 * No book IDs, rightsholder details, URLs, source snapshots or bearer tokens
 * may be exposed by the protected report.
 */
export const SOURCE_WITHDRAWAL_SCHEMA="cove.external-source-withdrawal-coverage.v2";
export const SOURCE_SQL=Object.freeze({
  sources: `SELECT s.id source_id,s.enabled,COALESCE(st.status,'absent') scan_status,
    st.last_success_at,st.last_run_at,s.refresh_seconds
    FROM gutenberg_sources s LEFT JOIN gutenberg_source_states st
      ON st.source_id=s.id ORDER BY s.id`,
  grants: `SELECT COALESCE(c.source_id,'unresolved') source_id,
    g.status, g.territory_code territory,
    COUNT(*) grant_rows,
    SUM(CASE WHEN g.status='active' AND g.decision='allow' THEN 1 ELSE 0 END) active_allows,
    SUM(CASE WHEN ev.id IS NULL OR c.id IS NULL
      OR ev.source_id<>c.source_id OR ev.cache_id<>c.id
      OR ev.territory_code<>g.territory_code
      OR ev.status<>'approved' OR ev.determination<>'public-domain'
      OR c.rights_status<>'public-domain'
      OR c.commercial_use_status<>'approved'
      THEN 1 ELSE 0 END) invalid_source_lineage,
    SUM(CASE WHEN ev.id IS NULL OR length(ev.evidence_hash)<>64
      OR ev.evidence_hash GLOB '*[^0-9a-f]*'
      THEN 1 ELSE 0 END) non_sha256_evidence
    FROM rights_grants g
    LEFT JOIN gutenberg_rights_evidence ev ON ev.id=g.source_evidence_id
    LEFT JOIN gutenberg_source_cache c ON c.id=ev.cache_id
    GROUP BY COALESCE(c.source_id,'unresolved'),g.status,g.territory_code
    ORDER BY source_id,g.status,territory`,
  cache: `SELECT source_id,COUNT(*) cache_rows,
    SUM(CASE WHEN rights_status='pending'
       OR commercial_use_status='pending' THEN 1 ELSE 0 END) pending_rows,
    SUM(CASE WHEN rights_status IN ('quarantined','rejected')
       OR commercial_use_status IN ('quarantined','rejected')
       THEN 1 ELSE 0 END) quarantine_rows,
    SUM(CASE WHEN length(content_hash)<>64 OR
      content_hash GLOB '*[^0-9a-f]*' THEN 1 ELSE 0 END) missing_sha256_content,
    MIN(last_seen_at) first_seen_at,MAX(last_seen_at) last_seen_at
    FROM gutenberg_source_cache GROUP BY source_id ORDER BY source_id`,
  external: `SELECT
    (SELECT COUNT(*) FROM copyright_notices) copyright_notices,
    (SELECT COUNT(*) FROM copyright_complaints) copyright_complaints,
    (SELECT COUNT(*) FROM rights_disputes) rights_disputes,
    (SELECT COUNT(*) FROM rights_dispute_events) dispute_events,
    (SELECT COUNT(*) FROM rights_decisions WHERE decision='deny') explicit_decision_denials,
    (SELECT COUNT(*) FROM rights_grant_audit) grant_audit_events,
    (SELECT COUNT(*) FROM rights_grants) grant_rows`,
  chronology: `SELECT * FROM (WITH ambiguous AS (
      SELECT DISTINCT grant_id FROM (
        SELECT grant_id FROM rights_grant_audit
        GROUP BY grant_id,recorded_at HAVING COUNT(DISTINCT snapshot_json)>1
      )
    ), events AS (
      SELECT grant_id,recorded_at,json_extract(snapshot_json,'$.status') status,
        LAG(json_extract(snapshot_json,'$.status'))
          OVER (PARTITION BY grant_id ORDER BY rowid) previous_status,
        LAG(recorded_at) OVER (PARTITION BY grant_id ORDER BY rowid) previous_time
      FROM rights_grant_audit
    ), reactivated AS (
      SELECT DISTINCT grant_id FROM events
      WHERE previous_status IN ('suspended','revoked','expired') AND status='active'
    ), backdated AS (
      SELECT DISTINCT grant_id FROM events WHERE previous_time IS NOT NULL
        AND julianday(recorded_at)<julianday(previous_time)
    ) SELECT
      (SELECT COUNT(*) FROM ambiguous) ambiguous_grants,
      (SELECT COUNT(*) FROM reactivated) reactivated_grants,
      (SELECT COUNT(*) FROM backdated) backdated_grants,
      (SELECT COUNT(*) FROM ambiguous a JOIN reactivated r USING(grant_id))
        ambiguous_reactivated_overlap,
      (SELECT COUNT(*) FROM ambiguous a JOIN backdated b USING(grant_id))
        ambiguous_backdated_overlap,
      (SELECT COUNT(*) FROM reactivated r JOIN backdated b USING(grant_id))
        reactivated_backdated_overlap,
      (SELECT COUNT(*) FROM ambiguous a JOIN rights_grants g ON g.id=a.grant_id
        WHERE g.status='active') ambiguous_active_grants,
      (SELECT COUNT(*) FROM ambiguous a JOIN rights_grants g ON g.id=a.grant_id
        WHERE g.status='suspended') ambiguous_suspended_grants)`,
});
const SHAPES=Object.freeze({
  sources:["source_id","enabled","scan_status","last_success_at","last_run_at","refresh_seconds"],
  grants:["source_id","status","territory","grant_rows","active_allows","invalid_source_lineage","non_sha256_evidence"],
  cache:["source_id","cache_rows","pending_rows","quarantine_rows","missing_sha256_content","first_seen_at","last_seen_at"],
  external:["copyright_notices","copyright_complaints","rights_disputes","dispute_events",
    "explicit_decision_denials","grant_audit_events","grant_rows"],
  chronology:["ambiguous_grants","reactivated_grants","backdated_grants",
    "ambiguous_reactivated_overlap","ambiguous_backdated_overlap",
    "reactivated_backdated_overlap","ambiguous_active_grants",
    "ambiguous_suspended_grants"],
});
const KNOWN=["pg_au","pg_ca","pg_eu","pg_us"];
const deny=(reason)=>{throw Error("external_source_coverage_denied_"+reason);};
const integer=(x,min=0)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=min;
const json=(x)=>JSON.stringify(x);
const epoch=(x)=>typeof x==="string"&&Number.isFinite(Date.parse(x))?Date.parse(x):null;
const keyset=(x)=>Object.keys(x).sort().join("|");
const shape=(kind,row)=>keyset(row)===[...SHAPES[kind]].sort().join("|");
const checkedSource=(id)=>typeof id==="string"&&/^[a-z]{2}_[a-z]{2}$/.test(id);
const checkedTime=(x)=>x===null||epoch(x)!==null;
const checkSourceRows=(rows)=>{
  if(rows.length!==KNOWN.length)deny("unreviewed_source_count");
  const ids=rows.map(r=>r.source_id);
  if(ids.join("|")!==KNOWN.join("|"))deny("unreviewed_source_identity");
  for(const r of rows){
    if(!integer(r.enabled)||r.enabled>1||
      !["absent","idle","running","backoff","degraded","failed"].includes(r.scan_status)||
      !checkedTime(r.last_success_at)||!checkedTime(r.last_run_at)||
      !integer(r.refresh_seconds,300))deny("source_state_invalid");
  }
};
export function checkedSourceCoverageRows(kind,rows){
  if(!Object.prototype.hasOwnProperty.call(SHAPES,kind)||
    !Array.isArray(rows)||rows.length>(kind==="grants"?28:kind==="sources"?8:8))
    deny("unreviewed_response");
  if(["external","chronology"].includes(kind)&&rows.length!==1)
    deny("aggregate_summary_missing");
  if(["sources","grants","cache"].includes(kind)&&!rows.length)
    deny("empty_source_set");
  if(rows.some(r=>!r||typeof r!=="object"||Array.isArray(r)||!shape(kind,r)))
    deny("response_shape");
  if(kind==="sources")checkSourceRows(rows);
  if(kind==="grants"){
    let previous="";
    for(const r of rows){
      if(!(checkedSource(r.source_id)||r.source_id==="unresolved")||
        !["active","suspended","revoked","expired","draft"].includes(r.status)||
        !/^[A-Z]{2}$/.test(r.territory))deny("grant_cohort");
      const id=[r.source_id,r.status,r.territory].join("|");
      if(id<=previous)deny("grant_cohort_order");
      previous=id;
      for(const k of ["grant_rows","active_allows","invalid_source_lineage","non_sha256_evidence"])
        if(!integer(r[k]))deny("grant_count");
      if(!r.grant_rows||r.active_allows>r.grant_rows||
        r.invalid_source_lineage>r.grant_rows||
        r.non_sha256_evidence>r.grant_rows)deny("grant_partition");
    }
  }
  if(kind==="cache"){
    let previous="";
    for(const r of rows){
      if(!checkedSource(r.source_id)||r.source_id<=previous||
        !checkedTime(r.first_seen_at)||!checkedTime(r.last_seen_at)||
        (epoch(r.first_seen_at)||0)>(epoch(r.last_seen_at)||0))deny("cache_cohort");
      previous=r.source_id;
      for(const k of ["cache_rows","pending_rows","quarantine_rows","missing_sha256_content"])
        if(!integer(r[k]))deny("cache_count");
      if(!r.cache_rows||r.pending_rows>r.cache_rows||
        r.quarantine_rows>r.cache_rows||
        r.missing_sha256_content>r.cache_rows)deny("cache_partition");
    }
  }
  if(kind==="external"){
    for(const k of SHAPES.external)if(!integer(rows[0][k]))deny("external_count");
  }
  if(kind==="chronology"){
    const c=rows[0];
    for(const k of SHAPES.chronology)if(!integer(c[k]))deny("chronology_count");
    if(c.ambiguous_reactivated_overlap>Math.min(c.ambiguous_grants,c.reactivated_grants)||
       c.ambiguous_backdated_overlap>Math.min(c.ambiguous_grants,c.backdated_grants)||
       c.reactivated_backdated_overlap>Math.min(c.reactivated_grants,c.backdated_grants)||
       c.ambiguous_active_grants+c.ambiguous_suspended_grants>c.ambiguous_grants)
      deny("chronology_partition");
  }
  return JSON.parse(json(rows));
}
export function sourceCoverageReport(first,second,nowMs=Date.now()){
  if(!integer(nowMs,1))deny("evaluation_clock");
  const data={};
  for(const kind of Object.keys(SOURCE_SQL)){
    const a=checkedSourceCoverageRows(kind,first?.[kind]);
    const b=checkedSourceCoverageRows(kind,second?.[kind]);
    data[kind]=a;
    if(json(a)!==json(b))data.changedDuringRead=true;
  }
  const blockers=[];
  if(data.changedDuringRead)blockers.push("external_source_inventory_changed_during_read");
  const activeBySource=new Map(KNOWN.map(id=>[id,0]));
  const grants=data.grants;
  let totalGrants=0,activeGrants=0;
  for(const r of grants){
    totalGrants+=r.grant_rows;
    activeGrants+=r.active_allows;
    if(r.active_allows)activeBySource.set(r.source_id,
      (activeBySource.get(r.source_id)||0)+r.active_allows);
    // Suspended/quarantined grants are correctly denied. Only invalid
    // *currently active* grants threaten an allow decision.
    if(r.invalid_source_lineage&&r.active_allows)
      blockers.push("external_source_current_lineage_invalid:"+r.source_id);
    if(r.non_sha256_evidence&&r.active_allows)
      blockers.push("external_source_legacy_evidence_fingerprint:"+r.source_id);
    if(r.source_id==="unresolved")
      blockers.push("external_source_grant_mapping_unresolved");
  }
  const e=data.external[0],c=data.chronology[0];
  if(c.ambiguous_grants>e.grant_rows||c.reactivated_grants>e.grant_audit_events||
     c.backdated_grants>e.grant_audit_events||
     c.ambiguous_active_grants>activeGrants)
    deny("chronology_coverage");
  if(c.ambiguous_active_grants>0)
    blockers.push("historical_ambiguous_active_grants_unverified");
  if(c.reactivated_grants>0)
    blockers.push("historical_terminal_reactivation_authority_missing");
  if(c.backdated_grants>0)
    blockers.push("historical_backdated_legal_event_order_unresolved");
  if(totalGrants!==e.grant_rows)
    blockers.push("external_source_grant_cohort_incomplete");
  if(e.grant_audit_events<totalGrants)
    blockers.push("external_source_grant_audit_incomplete");
  const cacheMap=new Map(data.cache.map(r=>[r.source_id,r]));
  const maxCacheAgeMs=30*24*60*60*1000;
  for(const s of data.sources){
    const active=activeBySource.get(s.source_id)||0;
    if(active===0)continue;
    const last=epoch(s.last_success_at);
    if(last===null||last>nowMs||nowMs-last>Math.max(s.refresh_seconds*2000,48*3600*1000))
      blockers.push("external_source_no_current_successful_scan:"+s.source_id);
    const cache=cacheMap.get(s.source_id);
    const lastSeen=cache?epoch(cache.last_seen_at):null;
    // A scan with unchanged item timestamps may still be valid. This is an
    // observable freshness gap, NOT proof of a withdrawal or permission.
    if(lastSeen===null||lastSeen>nowMs||nowMs-lastSeen>maxCacheAgeMs)
      blockers.push("external_source_cached_items_stale:"+s.source_id);
  }
  // The stored source/rights evidence is not a complete append-only stream of
  // external takedowns, rightsholder changes or positive reinstatements.
  // Zero local notices is NOT positive evidence of zero external notices.
  blockers.push("external_withdrawal_source_history_not_attested");
  blockers.push("external_withdrawals_not_reconciled_to_current_owner_epoch");
  blockers.push("historical_reinstatement_independent_authority_unproven");
  blockers.push("exclusive_primary_d1_writer_not_proven");
  return {
    schema:SOURCE_WITHDRAWAL_SCHEMA,
    source:"protected-primary-d1-aggregate-select-only",
    sourceCount:data.sources.length,
    activeGrantRows:activeGrants,
    recordedGrantRows:totalGrants,
    evidence:{sources:data.sources,grantCohorts:data.grants,cache:data.cache,
      externalSummary:e,conflictingChronology:c},
    unchangedAcrossRead:!data.changedDuringRead,
    authorizing:false,permitsPublication:false,
    currentOwnerVerified:false,externalWithdrawalHistoryComplete:false,
    releaseCertified:false,blockers:[...new Set(blockers)],
  };
}
export function verifySourceSql(){
  for(const sql of Object.values(SOURCE_SQL))
    if(!/^SELECT\b/.test(sql)||/;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|VACUUM)\b/i.test(sql))
      deny("unreviewed_sql");
}
verifySourceSql();
