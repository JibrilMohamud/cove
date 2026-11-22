/* eslint-disable prettier/prettier -- Execute exact SQLite event replay and adversarial historical denial faults. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {createGrantHistoryReplay,checkedGrantHistoryBoundary,
  HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL,
  HISTORY_BATCH_SIZE} from "./primary-grant-event-replay-policy.mjs";

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE rights_grants(
      id TEXT PRIMARY KEY,edition_id TEXT NOT NULL,rightsholder_id TEXT,
      rightsholder_party_id TEXT,territory_code TEXT NOT NULL DEFAULT 'US',
      scope_summary TEXT NOT NULL DEFAULT '',format TEXT NOT NULL DEFAULT 'ebook',
      sales_channel TEXT NOT NULL DEFAULT 'retail',starts_at TEXT,ends_at TEXT,
      license_type TEXT NOT NULL DEFAULT 'public-domain',contract_id TEXT,
      exclusivity TEXT NOT NULL DEFAULT 'nonexclusive',
      drm_requirement TEXT NOT NULL DEFAULT 'none',
      subscription_permitted INTEGER NOT NULL DEFAULT 0,
      library_permitted INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'allow',
      status TEXT NOT NULL DEFAULT 'active',
      promotion_restrictions_json TEXT NOT NULL DEFAULT '{}',
      contract_reference TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'gutenberg-us',
      source_evidence_id TEXT,notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE rights_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,
      action TEXT NOT NULL,snapshot_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TABLE rights_decisions(id TEXT PRIMARY KEY);
    CREATE TABLE copyright_notices(id TEXT PRIMARY KEY);
  `);
  let serial=0;
  const snapshots=()=>db.prepare(HISTORY_CURRENT_SQL).all("");
  function record(id,action,time){
    const byId=HISTORY_CURRENT_SQL.replace("WHERE g.id>? ORDER BY g.id LIMIT 384",
      "WHERE g.id=?");
    const state=db.prepare(byId).get(id);
    assert.ok(state);
    db.prepare("INSERT INTO rights_grant_audit VALUES(?,?,?,?,?)").run(
      "evt_"+(++serial),id,action,state.snapshot_json,time);
  }
  function insert(id,status="active",time="2026-10-09T00:00:00.000Z"){
    db.prepare("INSERT INTO rights_grants(id,edition_id,status,source_evidence_id) VALUES(?,?,?,?)")
      .run(id,"ed_"+id,status,"ev_"+id);
    record(id,"insert",time);
  }
  function update(id,status,time="2026-10-10T00:00:00.000Z"){
    db.prepare("UPDATE rights_grants SET status=? WHERE id=?").run(status,id);
    record(id,"update",time);
  }
  function scan(){
    const f=checkedGrantHistoryBoundary(db.prepare(HISTORY_BOUNDARY_SQL).all());
    const r=createGrantHistoryReplay();
    let sequence=0;
    for(let page=0;page<1000;page++){
      const rows=db.prepare(HISTORY_EVENTS_SQL).all(sequence);
      for(const row of rows){r.audit(row);sequence=row.event_seq;}
      if(rows.length<HISTORY_BATCH_SIZE)break;
      if(page===999)throw Error("fixture_audit_pagination_unbounded");
    }
    let grantId="";
    for(let page=0;page<1000;page++){
      const rows=db.prepare(HISTORY_CURRENT_SQL).all(grantId);
      for(const row of rows){r.current(row);grantId=row.grant_id;}
      if(rows.length<HISTORY_BATCH_SIZE)break;
      if(page===999)throw Error("fixture_current_pagination_unbounded");
    }
    return r.result(f,checkedGrantHistoryBoundary(
      db.prepare(HISTORY_BOUNDARY_SQL).all()));
  }
  return {db,insert,update,record,scan,snapshots,close:()=>db.close()};
}
test("actual SQLite audit matches current grants, and never authorizes",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");f.insert("grant_02");
    f.update("grant_02","suspended");
    const result=f.scan();
    assert.equal(result.eventsReplayed,3);
    assert.equal(result.grantsCompared,2);
    assert.deepEqual(result.counts,{
      inserts:2,updates:1,suspended:1,missingGrants:0,
      conflictingCurrentGrants:0,orphanReplayedGrants:0,
      ambiguousTimestampGroups:0,backdatedEventTimestamps:0,
      terminalReactivations:0,redundantUpdates:0,
    });
    assert.equal(result.scanBoundaryIdentical,true);
    assert.equal(result.auditedStateEqualsCurrent,true);
    assert.equal(result.historicalRightsReconciled,false);
    assert.equal(result.currentOwnerVerified,false);
    assert.equal(result.authorizing,false);
    assert.equal(result.permitsPublication,false);
    assert.equal(result.releaseCertified,false);
    assert.ok(result.blockers.includes(
      "historical_grant_audit_rowid_not_external_legal_sequence"));
    assert.match(result.replayEventSha256,/^[a-f0-9]{64}$/);
    assert.match(result.currentStateSha256,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes("grant_01"),
      "no grant identifiers or private evidence in report");
  }finally{f.close();}
});
test("equal-time DISTINCT snapshots are ambiguous and block positive legal replay",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");
    f.update("grant_01","suspended","2026-10-09T00:00:00.000Z");
    const r=f.scan();
    assert.equal(r.counts.ambiguousTimestampGroups,1);
    assert.ok(r.blockers.includes("historical_grant_timestamp_order_ambiguous"));
    assert.equal(r.historicalRightsReconciled,false);
    assert.equal(r.counts.conflictingCurrentGrants,0);
  }finally{f.close();}
});
test("backdated legal audit event timestamp is an explicit blocker",()=>{
  const f=fixture();
  try{
    f.insert("grant_01", "active", "2026-10-10T00:00:00.000Z");
    f.update("grant_01","suspended","2026-10-09T00:00:00.000Z");
    const result=f.scan();
    assert.equal(result.counts.backdatedEventTimestamps,1);
    assert.ok(result.blockers.includes("historical_grant_audit_backdated_event_time"));
    assert.equal(result.historicalRightsReconciled,false);
  }finally{f.close();}
});
test("a current unjournaled primary D1 rights edit mismatches replay",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");
    f.db.exec("UPDATE rights_grants SET status='suspended' WHERE id='grant_01'");
    const r=f.scan();
    assert.equal(r.counts.conflictingCurrentGrants,1);
    assert.equal(r.counts.orphanReplayedGrants,1);
    assert.ok(r.blockers.includes("historical_grant_audit_current_state_mismatch"));
    assert.equal(r.auditedStateEqualsCurrent,false);
  }finally{f.close();}
});
test("replay rejects missing inserts, duplicate inserts and terminal resurrection",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");
    f.update("grant_01","suspended");
    f.db.prepare("UPDATE rights_grants SET status='active' WHERE id='grant_01'").run();
    f.record("grant_01","update","2026-10-11T00:00:00.000Z");
    assert.equal(f.scan().counts.terminalReactivations,1);
    f.record("grant_01","insert","2026-10-12T00:00:00.000Z");
    assert.throws(()=>f.scan(),/duplicate_grant_insert/);
    f.db.exec("DELETE FROM rights_grant_audit WHERE action='insert'");
    assert.throws(()=>f.scan(),/update_before_insert/);
  }finally{f.close();}
});
test("an orphan audit event cannot be silently ignored",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");f.insert("grant_02");
    f.db.exec("DELETE FROM rights_grants WHERE id='grant_01'");
    const result=f.scan();
    assert.equal(result.counts.orphanReplayedGrants,1);
    assert.ok(result.blockers.includes("historical_grant_audit_current_state_mismatch"));
  }finally{f.close();}
});
test("audit snapshots reject broken shapes, edited fields, invalid rights",()=>{
  for(const snapshot of [
    "no-json",JSON.stringify({decision:"allow"}),
    JSON.stringify({editionId:"x",status:"active",decision:"forged"}),
  ]){
    const f=fixture();
    try{
      f.insert("grant_01");
      f.db.prepare("UPDATE rights_grant_audit SET snapshot_json=?").run(snapshot);
      assert.throws(()=>f.scan(),/snapshot/);
    }finally{f.close();}
  }
});
test("page boundaries, replay changes and count fences deny drift",()=>{
  const f=fixture();
  try{
    f.insert("grant_01");f.insert("grant_02");
    const old=checkedGrantHistoryBoundary(f.db.prepare(HISTORY_BOUNDARY_SQL).all());
    f.update("grant_01","suspended");
    const r=createGrantHistoryReplay();
    for(const row of f.db.prepare(HISTORY_EVENTS_SQL).all(0))r.audit(row);
    for(const row of f.snapshots())r.current(row);
    const result=r.result(old,checkedGrantHistoryBoundary(
      f.db.prepare(HISTORY_BOUNDARY_SQL).all()));
    assert.equal(result.scanBoundaryIdentical,false);
    assert.ok(result.blockers.includes("historical_primary_changed_during_replay"));
    const b=structuredClone(old);
    for(const change of [
      x=>{x.audit_rows=-1;},x=>{x.audit_rows="5";},
      x=>{x.audit_max_rowid=0;},x=>{x.bogus=1;},
      x=>{delete x.suspended_grants;},
    ]){
      const x=structuredClone(b);change(x);
      assert.throws(()=>checkedGrantHistoryBoundary([x]));
    }
  }finally{f.close();}
});
test("full keyset pagination crosses 384 events and current grants without loss",()=>{
  const f=fixture();
  try{
    for(let i=0;i<HISTORY_BATCH_SIZE+3;i++)
      f.insert("grant_"+String(i).padStart(4,"0"));
    const r=f.scan();
    assert.equal(r.eventsReplayed,HISTORY_BATCH_SIZE+3);
    assert.equal(r.grantsCompared,HISTORY_BATCH_SIZE+3);
    assert.equal(r.counts.missingGrants,0);
    assert.equal(r.counts.conflictingCurrentGrants,0);
    assert.equal(r.counts.orphanReplayedGrants,0);
    assert.equal(r.auditedStateEqualsCurrent,true);
    assert.equal(r.authorizing,false);
  }finally{f.close();}
});
test("transport SQL is read-only and keyset-bounded, not dynamic",()=>{
  assert.equal(HISTORY_BATCH_SIZE,384);
  for(const sql of [HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL]){
    assert.match(sql,/^SELECT\b/);
    assert.doesNotMatch(sql,/;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|VACUUM)\b/i);
  }
  assert.match(HISTORY_EVENTS_SQL,/WHERE rowid>\? ORDER BY rowid LIMIT 384$/);
  assert.match(HISTORY_CURRENT_SQL,/WHERE g.id>\? ORDER BY g.id LIMIT 384$/);
});
