/* eslint-disable prettier/prettier -- Deny-first historical grant audit replay contract and audited SQL are intentionally explicit. */
/**
 * Replays EVERY audited primary-D1 grant insert/update against current grants.
 * This can detect lost history, contradictory timestamps, source drift and
 * terminal reinstatement, but it is NEVER legal authority or a positive
 * grant. SQLite rowid is an audit transport cursor, not a verified legal
 * sequence number. Externally acknowledged withdrawals and owner denial
 * history are NOT in this dataset.
 *
 * Protected transport outputs only counters, blockers and aggregate digests;
 * never output raw snapshots, grant IDs, source, rightsholder or notes.
 */
import {createHash} from "node:crypto";

export const PRIMARY_GRANT_HISTORY_REPLAY_SCHEMA="cove.primary-grant-event-replay.v1";
export const HISTORY_BATCH_SIZE=384;
export const AUDIT_KEYS=Object.freeze([
  "contractId","contractReference","decision","drmRequirement",
  "editionId","endsAt","exclusivity","format","libraryPermitted",
  "licenseType","notes","promotionRestrictions","rightsholderId",
  "rightsholderPartyId","salesChannel","scopeSummary","source",
  "sourceEvidenceId","startsAt","status","subscriptionPermitted","territory",
].sort());
export const HISTORY_BOUNDARY_SQL=[
  "SELECT (SELECT COUNT(*) FROM rights_grant_audit) audit_rows,",
  "(SELECT COALESCE(MAX(rowid),0) FROM rights_grant_audit) audit_max_rowid,",
  "(SELECT COUNT(*) FROM rights_grants) grant_rows,",
  "(SELECT COUNT(*) FROM rights_grants WHERE status='suspended') suspended_grants,",
  "(SELECT COUNT(*) FROM rights_decisions) decision_rows,",
  "(SELECT COUNT(*) FROM copyright_notices) copyright_notices",
].join(" ");
export const HISTORY_EVENTS_SQL=[
  "SELECT rowid event_seq,grant_id,action,snapshot_json,recorded_at",
  "FROM rights_grant_audit WHERE rowid>? ORDER BY rowid LIMIT 384",
].join(" ");
/** Reconstruct the EXACT audited JSON projection of each current grant.
 * Audit history omits contract_version_id, and it does not encode
 * rights_grant_territory_scopes, expiry re-evaluations, independent owner
 * withdrawal receipts or source-evidence re-verification. Report blockers.
 */
export const HISTORY_CURRENT_SQL=[
  "SELECT g.id grant_id,json_object(",
  "'editionId',g.edition_id,'rightsholderId',g.rightsholder_id,",
  "'rightsholderPartyId',g.rightsholder_party_id,'territory',g.territory_code,",
  "'scopeSummary',g.scope_summary,'format',g.format,",
  "'salesChannel',g.sales_channel,'startsAt',g.starts_at,",
  "'endsAt',g.ends_at,'licenseType',g.license_type,",
  "'contractId',g.contract_id,'exclusivity',g.exclusivity,",
  "'drmRequirement',g.drm_requirement,",
  "'subscriptionPermitted',g.subscription_permitted,",
  "'libraryPermitted',g.library_permitted,'decision',g.decision,",
  "'status',g.status,",
  "'promotionRestrictions',CASE WHEN json_valid(g.promotion_restrictions_json)",
  "THEN json(g.promotion_restrictions_json) ELSE json('{}') END,",
  "'contractReference',g.contract_reference,'source',g.source,",
  "'sourceEvidenceId',g.source_evidence_id,'notes',g.notes)",
  "snapshot_json FROM rights_grants g WHERE g.id>? ORDER BY g.id LIMIT 384",
].join(" ");
const banned=/;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|PRAGMA|VACUUM|RETURNING)\b/i;
for(const sql of [HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL]){
  if(!/^SELECT\b/.test(sql)||banned.test(sql))throw Error("grant_audit_query_contract_modified");
}
const error=(reason)=>{throw Error("grant_history_replay_denied_"+reason);};
const uint=(n)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const keys=(x)=>Object.keys(x).sort().join("|");
const expectedEventKeys="action|event_seq|grant_id|recorded_at|snapshot_json";
const expectedCurrentKeys="grant_id|snapshot_json";
const expectedBoundaryKeys=[
  "audit_rows","audit_max_rowid","grant_rows","suspended_grants",
  "decision_rows","copyright_notices",
].sort().join("|");
const safeId=(x)=>typeof x==="string"&&x.length>=1&&x.length<=200&&
  !/[\x00-\x1f\x7f]/.test(x);
const safeTime=(x)=>typeof x==="string"&&x.length>=10&&x.length<=64&&
  /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(x);
export function checkedGrantHistoryBoundary(rows){
  if(!Array.isArray(rows)||rows.length!==1||!rows[0]||
    keys(rows[0])!==expectedBoundaryKeys)error("boundary_shape");
  const row=rows[0];
  for(const key of expectedBoundaryKeys.split("|"))if(!uint(row[key]))error("boundary_count");
  if(row.audit_rows<1||row.grant_rows<1||row.audit_max_rowid<row.audit_rows||
    row.suspended_grants>row.grant_rows)error("boundary_inconsistent");
  return Object.fromEntries(expectedBoundaryKeys.split("|").map(k=>[k,row[k]]));
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==="object"){
    return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  }
  return value;
}
function snapshot(raw){
  if(typeof raw!=="string"||raw.length<20||raw.length>16_384)error("snapshot_size");
  let value;
  try{value=JSON.parse(raw);}catch{error("invalid_snapshot_json");}
  if(!value||typeof value!=="object"||Array.isArray(value)||
    keys(value)!==AUDIT_KEYS.join("|"))error("snapshot_shape");
  if(!["allow","deny"].includes(value.decision)||
    !["draft","active","suspended","revoked","expired"].includes(value.status)||
    !/^[A-Z]{2}$/.test(value.territory)||
    typeof value.editionId!=="string"||value.editionId.length<1||
    typeof value.format!=="string"||value.format.length<1||
    !value.promotionRestrictions||
    typeof value.promotionRestrictions!=="object"||
    Array.isArray(value.promotionRestrictions))error("invalid_snapshot_value");
  return JSON.stringify(canonical(value));
}
export function createGrantHistoryReplay(){
  const latest=new Map(), timestampGroups=new Map();
  const eventHash=createHash("sha256"),stateHash=createHash("sha256");
  let auditRows=0,insertRows=0,updateRows=0,lastRowid=0;
  let grants=0,suspended=0,missing=0,disagreement=0,orphans=0;
  let ambiguousGroups=0,terminalReactivation=0,repeatedUpdates=0,backdatedEvents=0;
  let lastGrantId="",seenCurrent=new Set();
  let finalized=false;
  const step=()=>{if(finalized)error("already_finalized");};
  function audit(row){
    step();
    if(!row||typeof row!=="object"||keys(row)!==expectedEventKeys||
      !uint(row.event_seq)||row.event_seq<=lastRowid||
      !safeId(row.grant_id)||!safeTime(row.recorded_at)||
      !["insert","update"].includes(row.action))error("event_contract");
    const state=snapshot(row.snapshot_json);
    const timestamp=Date.parse(row.recorded_at.includes("T")?
      row.recorded_at:row.recorded_at.replace(" ","T")+"Z");
    if(!Number.isFinite(timestamp))error("invalid_event_timestamp");
    const earlier=latest.get(row.grant_id);
    if(earlier&&timestamp<earlier.timestamp)backdatedEvents++;
    if(row.action==="insert"){
      if(earlier)error("duplicate_grant_insert");
      insertRows++;
    }else{
      if(!earlier)error("update_before_insert");
      updateRows++;
      if(earlier.state===state)repeatedUpdates++;
      if(["suspended","revoked","expired"].includes(earlier.status)&&
        ["draft","active"].includes(JSON.parse(state).status))
        terminalReactivation++;
    }
    const groupKey=row.grant_id+"\u0000"+row.recorded_at;
    const group=timestampGroups.get(groupKey);
    if(group){
      if(group.state!==state&&!group.ambiguous){
        group.ambiguous=true;ambiguousGroups++;
      }
    }else timestampGroups.set(groupKey,{state,ambiguous:false});
    const obj=JSON.parse(state);
    latest.set(row.grant_id,{state,status:obj.status,timestamp});
    auditRows++;lastRowid=row.event_seq;
    eventHash.update(JSON.stringify([row.event_seq,row.grant_id,row.action,
      row.recorded_at,state])+"\n");
  }
  function current(row){
    step();
    if(!row||typeof row!=="object"||keys(row)!==expectedCurrentKeys||
      !safeId(row.grant_id)||row.grant_id<=lastGrantId||
      seenCurrent.has(row.grant_id))error("current_grant_contract");
    const state=snapshot(row.snapshot_json);
    seenCurrent.add(row.grant_id);
    const previous=latest.get(row.grant_id);
    if(!previous)missing++;
    else if(previous.state!==state)disagreement++;
    else latest.delete(row.grant_id);
    if(JSON.parse(state).status==="suspended")suspended++;
    grants++;lastGrantId=row.grant_id;
    stateHash.update(JSON.stringify([row.grant_id,state])+"\n");
  }
  function result(firstBoundary,lastBoundary){
    step();finalized=true;
    const first=checkedGrantHistoryBoundary([firstBoundary]);
    const last=checkedGrantHistoryBoundary([lastBoundary]);
    orphans=latest.size;
    const blockers=[];
    if(JSON.stringify(first)!==JSON.stringify(last))
      blockers.push("historical_primary_changed_during_replay");
    if(auditRows!==first.audit_rows||lastRowid!==first.audit_max_rowid||
      insertRows!==first.grant_rows)
      blockers.push("historical_grant_audit_event_coverage_mismatch");
    if(grants!==first.grant_rows||suspended!==first.suspended_grants||
      missing>0||disagreement>0||orphans>0)
      blockers.push("historical_grant_audit_current_state_mismatch");
    if(ambiguousGroups>0)
      blockers.push("historical_grant_timestamp_order_ambiguous");
    if(backdatedEvents>0)
      blockers.push("historical_grant_audit_backdated_event_time");
    if(terminalReactivation>0)
      blockers.push("historical_grant_terminal_reactivation_detected");
    // Rowid orders a present SQLite table's append operations only. It cannot
    // attest an independent legal event chronology, especially when recorded
    // times collide. Missing source/market/contract withdrawals are not fixed
    // by a perfect replay of this single table.
    blockers.push("historical_grant_audit_rowid_not_external_legal_sequence");
    blockers.push("historical_grant_contract_version_scope_expiry_not_replayed");
    blockers.push("historical_legacy_source_evidence_not_reauthenticated");
    blockers.push("historical_external_withdrawal_events_not_reconciled");
    blockers.push("historical_current_owner_denial_epoch_not_proven");
    blockers.push("exclusive_primary_d1_writer_not_proven");
    return {
      schema:PRIMARY_GRANT_HISTORY_REPLAY_SCHEMA,
      source:"protected-primary-d1-select-only",
      eventsReplayed:auditRows,grantsCompared:grants,
      counts:{inserts:insertRows,updates:updateRows,suspended,
        missingGrants:missing,conflictingCurrentGrants:disagreement,
        orphanReplayedGrants:orphans,ambiguousTimestampGroups:ambiguousGroups,
        backdatedEventTimestamps:backdatedEvents,
        terminalReactivations:terminalReactivation,redundantUpdates:repeatedUpdates},
      replayEventSha256:eventHash.digest("hex"),
      currentStateSha256:stateHash.digest("hex"),
      scanBoundaryIdentical:JSON.stringify(first)===JSON.stringify(last),
      auditedStateEqualsCurrent:JSON.stringify(first)===JSON.stringify(last) &&
        auditRows===first.audit_rows&&insertRows===first.grant_rows&&
        grants===first.grant_rows&&suspended===first.suspended_grants&&
        missing===0&&disagreement===0&&orphans===0,
      historicalRightsReconciled:false,currentOwnerVerified:false,
      authorizing:false,permitsPublication:false,releaseCertified:false,
      blockers,
    };
  }
  return {audit,current,result};
}
