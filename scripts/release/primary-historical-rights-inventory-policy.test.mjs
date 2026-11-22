/* eslint-disable prettier/prettier -- Adversarial aggregate-only primary rights test. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {HISTORICAL_SQL,checkedHistoricalAggregate,checkedHistoricalD1Response,
  verifyHistoricalPrimaryInventory} from "./primary-historical-rights-inventory-policy.mjs";

const valid=()=>({
  state:{product_total:82247,active_products:81909,inactive_products:338,grant_total:82246,
    active_allow_grants:81909,suspended_grants:337,active_uncovered:0,
    inactive_without_grant:1,contracts:0,contract_versions:0,active_markets:23},
  evidence:{joined_grants:82246,missing_evidence:0,unapproved_or_mismatched:0,
    legacy_evidence_hashes:77656,other_evidence_types:0},
  cache:{joined_grants:82246,missing_cache_or_source:0,active_uncleared_cache:0,
    active_unapproved_commercial_cache:0,disabled_source_grants:0,
    source_evidence_pointer_mismatch:0,legacy_cache_content_hashes:910},
  exposure:{retail_rows:81909,scoped_grants:82246,scoped_territories:3,
    explicit_deny_grants:0,copyright_notices:0},
});
test("the entire historical production inventory remains nonauthorizing",()=>{
  const x=valid(),r=verifyHistoricalPrimaryInventory(x,structuredClone(x));
  assert.equal(r.scannedProductCount,82247);
  assert.equal(r.historicalInventoryConsistent,true);
  assert.equal(r.sampleBased,false);
  assert.equal(r.authorizing,false);
  assert.equal(r.currentOwnerVerified,false);
  assert.equal(r.permitsPublication,false);
  assert.equal(r.releaseCertified,false);
  assert.equal(r.historicalRightsReconciled,false);
  assert.ok(r.blockers.includes("historical_legacy_evidence_fingerprints_not_sha256"));
  assert.ok(r.blockers.includes("historical_legacy_cache_content_hashes_not_sha256"));
  assert.ok(r.blockers.includes("current_owner_denial_epoch_not_proven"));
});
test("stale counts and unexplained positive coverage never pass as consistent",()=>{
  const first=valid();
  for(const [kind,key,value,blocker] of [
    ["state","active_uncovered",1,"historical_primary_active_grants_missing"],
    ["state","active_products",81910,"historical_primary_product_partition"],
    ["evidence","joined_grants",82245,"historical_primary_evidence_lineage_incomplete"],
    ["evidence","unapproved_or_mismatched",1,"historical_primary_evidence_lineage_incomplete"],
    ["cache","active_uncleared_cache",1,"historical_primary_current_source_cache_conflict"],
    ["cache","active_unapproved_commercial_cache",1,"historical_primary_current_source_cache_conflict"],
    ["cache","source_evidence_pointer_mismatch",1,"historical_primary_current_source_cache_conflict"],
    ["exposure","scoped_grants",0,"historical_primary_territory_scope_incomplete"],
  ]){
    const x=valid();x[kind][key]=value;
    const r=verifyHistoricalPrimaryInventory(x,structuredClone(x));
    assert.equal(r.historicalInventoryConsistent,false);
    assert.ok(r.blockers.includes(blocker));
    assert.equal(r.authorizing,false);
  }
  const newer=valid();newer.state.grant_total++;
  assert.ok(verifyHistoricalPrimaryInventory(first,newer).blockers.includes(
    "historical_primary_changed_during_inventory"));
});
test("no arbitrary SQL, missing data, negative or unsafe counts",()=>{
  for(const sql of Object.values(HISTORICAL_SQL)){
    assert.match(sql,/^SELECT\b/);
    assert.doesNotMatch(sql,/;|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i);
    assert.doesNotMatch(sql,/\b(?:customer|email|secret|payment_intents|api_tokens)\b/i);
  }
  for(const value of [null,-1,NaN,Infinity,0.5,"1"]){
    const x=valid();x.state.product_total=value;
    assert.throws(()=>checkedHistoricalAggregate("state",[x.state]));
  }
  const x=valid();x.state.unexpected=1;
  assert.throws(()=>checkedHistoricalAggregate("state",[x.state]));
  assert.throws(()=>checkedHistoricalAggregate("unknown",[{}]));
  assert.throws(()=>checkedHistoricalAggregate("state",[]));
  assert.throws(()=>verifyHistoricalPrimaryInventory(null,null));
});
test("D1 must explicitly attest zero writes and exactly one result",()=>{
  const okay={success:true,result:[{success:true,results:[{n:1}],meta:{changed_db:false,changes:0}}]};
  assert.deepEqual(checkedHistoricalD1Response(okay),[{n:1}]);
  for(const mutate of [
    o=>{o.result[0].meta.changed_db=true;},
    o=>{delete o.result[0].meta.changed_db;},
    o=>{o.result[0].meta.changes=1;},
    o=>{o.result[0].success=false;},
    o=>{o.result=[];},
    o=>{o.result.push(o.result[0]);},
    o=>{o.success=false;},
  ]){
    const x=structuredClone(okay);mutate(x);
    assert.throws(()=>checkedHistoricalD1Response(x),/non_readonly_or_invalid/);
  }
});
