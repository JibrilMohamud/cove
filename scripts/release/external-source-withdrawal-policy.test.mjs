/* eslint-disable prettier/prettier -- Fail-closed adversarial external-source provenance tests. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {SOURCE_SQL,checkedSourceCoverageRows,sourceCoverageReport,
  verifySourceSql} from "./external-source-withdrawal-policy.mjs";

const NOW=Date.parse("2026-11-22T03:30:00.000Z");
const data=()=>({
  sources:[
    {source_id:"pg_au",enabled:1,scan_status:"idle",
      last_success_at:"2026-11-22T03:10:34.802Z",last_run_at:"2026-11-22T03:10:33.341Z",refresh_seconds:86400},
    {source_id:"pg_ca",enabled:1,scan_status:"idle",
      last_success_at:"2026-11-22T02:25:33.686Z",last_run_at:"2026-11-22T02:25:32.493Z",refresh_seconds:86400},
    {source_id:"pg_eu",enabled:1,scan_status:"degraded",
      last_success_at:null,last_run_at:"2026-11-22T03:00:35.676Z",refresh_seconds:86400},
    {source_id:"pg_us",enabled:1,scan_status:"idle",
      last_success_at:null,last_run_at:null,refresh_seconds:86400},
  ],
  grants:[
    {source_id:"pg_au",status:"active",territory:"AU",
      grant_rows:4253,active_allows:4253,invalid_source_lineage:0,non_sha256_evidence:0},
    {source_id:"pg_ca",status:"suspended",territory:"CA",
      grant_rows:337,active_allows:0,invalid_source_lineage:337,non_sha256_evidence:0},
    {source_id:"pg_us",status:"active",territory:"US",
      grant_rows:77656,active_allows:77656,invalid_source_lineage:0,non_sha256_evidence:77656},
  ],
  cache:[
    {source_id:"pg_au",cache_rows:4304,pending_rows:36,quarantine_rows:15,
      missing_sha256_content:51,first_seen_at:"2026-10-10T23:51:23.156Z",
      last_seen_at:"2026-10-11T00:30:26.859Z"},
    {source_id:"pg_ca",cache_rows:1504,pending_rows:0,quarantine_rows:1504,
      missing_sha256_content:1167,first_seen_at:"2026-10-10T23:50:24.662Z",
      last_seen_at:"2026-10-11T00:05:24.274Z"},
    {source_id:"pg_us",cache_rows:77657,pending_rows:1,quarantine_rows:0,
      missing_sha256_content:910,first_seen_at:"2026-10-09T06:05:56.947Z",
      last_seen_at:"2026-11-22T03:00:34.585Z"},
  ],
  external:[{
    copyright_notices:0,copyright_complaints:0,rights_disputes:0,
    dispute_events:0,explicit_decision_denials:0,grant_audit_events:87742,
    grant_rows:82246,
  }],
  chronology:[{
    ambiguous_grants:116,reactivated_grants:114,backdated_grants:2,
    ambiguous_reactivated_overlap:114,ambiguous_backdated_overlap:2,
    reactivated_backdated_overlap:2,ambiguous_active_grants:112,
    ambiguous_suspended_grants:4,
  }],
});
test("live-shaped aggregates remain nonauthorizing even with no local external notices",()=>{
  const x=data(),r=sourceCoverageReport(x,structuredClone(x),NOW);
  assert.equal(r.schema,"cove.external-source-withdrawal-coverage.v2");
  assert.equal(r.sourceCount,4);
  assert.equal(r.activeGrantRows,81909);
  assert.equal(r.recordedGrantRows,82246);
  assert.deepEqual(r.evidence.conflictingChronology,{
    ambiguous_grants:116,reactivated_grants:114,backdated_grants:2,
    ambiguous_reactivated_overlap:114,ambiguous_backdated_overlap:2,
    reactivated_backdated_overlap:2,ambiguous_active_grants:112,
    ambiguous_suspended_grants:4,
  });
  assert.equal(r.unchangedAcrossRead,true);
  assert.equal(r.authorizing,false);
  assert.equal(r.currentOwnerVerified,false);
  assert.equal(r.externalWithdrawalHistoryComplete,false);
  assert.equal(r.permitsPublication,false);
  assert.equal(r.releaseCertified,false);
  assert.ok(r.blockers.includes("external_source_no_current_successful_scan:pg_us"));
  assert.ok(r.blockers.includes("external_source_cached_items_stale:pg_au"));
  assert.ok(r.blockers.includes("external_source_legacy_evidence_fingerprint:pg_us"));
  assert.ok(r.blockers.includes("external_withdrawal_source_history_not_attested"));
  assert.ok(r.blockers.includes("historical_ambiguous_active_grants_unverified"));
  assert.ok(r.blockers.includes("historical_terminal_reactivation_authority_missing"));
  assert.ok(r.blockers.includes("historical_backdated_legal_event_order_unresolved"));
  assert.ok(r.blockers.includes("external_withdrawals_not_reconciled_to_current_owner_epoch"));
  assert.ok(!r.blockers.some(b=>b.includes("pg_eu")),
    "degraded source with zero live grants does not prove or disprove current retail");
  assert.ok(!r.blockers.some(b=>b.includes("lineage_invalid:pg_ca")),
    "quarantined suspended grants are denied, not malformed active grants");
  assert.ok(!JSON.stringify(r).includes("token"));
});
test("separately reject fresh grant with unverified cache/evidence lineage",()=>{
  const x=data();
  x.grants[0].invalid_source_lineage=1;
  const r=sourceCoverageReport(x,structuredClone(x),NOW);
  assert.ok(r.blockers.includes("external_source_current_lineage_invalid:pg_au"));
  assert.equal(r.authorizing,false);
});
test("a supposedly successful scan may not be offered as complete external withdrawal archive",()=>{
  const x=data();
  x.sources[3].last_success_at="2026-11-22T03:00:00.000Z";
  x.cache[0].last_seen_at="2026-11-22T03:00:00.000Z";
  x.grants[2].non_sha256_evidence=0;
  const r=sourceCoverageReport(x,structuredClone(x),NOW);
  assert.ok(r.blockers.includes("external_withdrawal_source_history_not_attested"));
  assert.ok(r.blockers.includes("historical_reinstatement_independent_authority_unproven"));
  assert.equal(r.externalWithdrawalHistoryComplete,false);
});
test("changed source rows, missing grants and audit regression block publication",()=>{
  const x=data(),changed=structuredClone(x);
  changed.cache[0].last_seen_at="2026-11-22T03:00:00.000Z";
  const drift=sourceCoverageReport(x,changed,NOW);
  assert.equal(drift.unchangedAcrossRead,false);
  assert.ok(drift.blockers.includes("external_source_inventory_changed_during_read"));
  x.grants[0].grant_rows--;
  x.grants[0].active_allows--;
  assert.ok(sourceCoverageReport(x,structuredClone(x),NOW).blockers.includes(
    "external_source_grant_cohort_incomplete"));
  x.grants[0].grant_rows++;
  x.grants[0].active_allows++;
  x.external[0].grant_audit_events=4;
  assert.ok(sourceCoverageReport(x,structuredClone(x),NOW).blockers.includes(
    "external_source_grant_audit_incomplete"));
});
test("unresolved source identity, new source, invalid status and clock fail closed",()=>{
  for(const mutate of [
    x=>{x.sources.push({...x.sources[0],source_id:"pg_zz"});},
    x=>{x.sources[0].source_id="pg_nonexistent";},
    x=>{x.sources[0].scan_status="verified";},
    x=>{x.sources[0].enabled=2;},
    x=>{x.sources[0].last_success_at="not-a-date";},
    x=>{x.sources[0].bogus=true;},
    x=>{x.grants[0].status="granted";},
    x=>{x.grants[0].non_sha256_evidence=5000;},
    x=>{x.grants[0].source_id="pg_u$";},
    x=>{x.grants.push(structuredClone(x.grants[0]));},
    x=>{x.cache[0].cache_rows=-1;},
    x=>{x.cache[0].last_seen_at="not-a-date";},
    x=>{x.external[0].copyright_notices="0";},
    x=>{x.external[0].unknown=7;},
    x=>{x.chronology[0].ambiguous_grants=-1;},
    x=>{x.chronology[0].ambiguous_reactivated_overlap=115;},
    x=>{x.chronology[0].backdated_grants=3;
      x.chronology[0].ambiguous_backdated_overlap=4;},
    x=>{x.chronology[0].ambiguous_active_grants=118;
      x.chronology[0].ambiguous_suspended_grants=5;},
    x=>{x.chronology[0].unknown=true;},
  ]){
    const x=data();mutate(x);
    assert.throws(()=>sourceCoverageReport(x,structuredClone(x),NOW),
      /external_source_coverage_denied/);
  }
  assert.throws(()=>sourceCoverageReport(data(),data(),0),/evaluation_clock/);
  assert.throws(()=>checkedSourceCoverageRows("fake",[]),/unreviewed_response/);
});
test("five fixed SQLs only, no writes or customer-identifying columns",()=>{
  assert.deepEqual(Object.keys(SOURCE_SQL).sort(),["cache","chronology","external","grants","sources"]);
  verifySourceSql();
  for(const sql of Object.values(SOURCE_SQL)){
    assert.match(sql,/^SELECT\b/);
    assert.doesNotMatch(sql,/;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|VACUUM)\b/i);
    assert.doesNotMatch(sql,/\b(?:customer|email|phone|bearer|token|auth_accounts)\b/i);
  }
});
