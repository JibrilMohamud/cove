/* eslint-disable prettier/prettier -- Adversarial protected rights withdrawal and territory fixture. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addRightsWitnesses,assertRightsWitnessCoverage,verifyNegativeRightsVerdict,
  POSITIVE_WITNESSES,NEGATIVE_WITNESSES,TERRITORY_WITNESSES} from './protected-rights-witness-policy.mjs';

const rows=(name,n)=>Array.from({length:n},(_,i)=>({product_id:name+i}));
const complete=()=>({
  yes:new Set(rows('allow',8).map(x=>x.product_id)),
  suspended:new Set(rows('suspended',4).map(x=>x.product_id)),
  territory:new Set(rows('territory',4).map(x=>x.product_id)),
});
test('eight allowed, four suspended and four territory-limited are separate hard budgets',()=>{
  const {yes,suspended,territory}=complete();
  assert.equal(POSITIVE_WITNESSES,8);
  assert.equal(NEGATIVE_WITNESSES,4);
  assert.equal(TERRITORY_WITNESSES,4);
  assert.doesNotThrow(()=>assertRightsWitnessCoverage(yes,suspended,territory));
  assert.equal(addRightsWitnesses(yes,rows('extra',2),POSITIVE_WITNESSES),0);
  assert.equal(addRightsWitnesses(suspended,rows('extra',2),NEGATIVE_WITNESSES,yes),0);
  assert.equal(addRightsWitnesses(territory,rows('extra',2),TERRITORY_WITNESSES,
    new Set([...yes,...suspended])),0);
  assert.equal(new Set([...yes,...suspended,...territory]).size,16);
});
test('missing either protected denial class is never certified',()=>{
  const {yes,suspended,territory}=complete();
  suspended.delete('suspended0');
  assert.throws(()=>assertRightsWitnessCoverage(yes,suspended,territory),/insufficient_three_policy_witnesses/);
  suspended.add('suspended0');
  territory.delete('territory0');
  assert.throws(()=>assertRightsWitnessCoverage(yes,suspended,territory),/insufficient_three_policy_witnesses/);
  territory.add('territory0');
  yes.delete('allow0');
  assert.throws(()=>assertRightsWitnessCoverage(yes,suspended,territory),/insufficient_three_policy_witnesses/);
});
test('overlap across any two cohorts is refused, not silently counted twice',()=>{
  const {yes,suspended,territory}=complete();
  territory.delete('territory0');territory.add('allow0');
  assert.throws(()=>assertRightsWitnessCoverage(yes,suspended,territory),/insufficient_three_policy_witnesses/);
  territory.delete('allow0');territory.add('suspended0');
  assert.throws(()=>assertRightsWitnessCoverage(yes,suspended,territory),/insufficient_three_policy_witnesses/);
  const a=new Set(['p0']),b=new Set();
  assert.equal(addRightsWitnesses(a,[{product_id:'p0'},{product_id:'p1'}],8),1);
  assert.equal(addRightsWitnesses(b,[{product_id:'p0'},{product_id:'p2'}],4,a),1);
  assert.deepEqual([...b],['p2']);
});
test('invalid/malicious identifiers or too-large witness budgets fail closed',()=>{
  for(const bad of ['','perf-synth-1','p with space','a;DELETE FROM products','x'.repeat(129)])
    assert.throws(()=>addRightsWitnesses(new Set(),[{product_id:bad}],8),/invalid_identifier/);
  assert.throws(()=>addRightsWitnesses(new Set(),[{}],8),/invalid_identifier/);
  assert.throws(()=>addRightsWitnesses({},rows('p',1),8),/invalid_witness_cohort/);
  assert.throws(()=>addRightsWitnesses(new Set(),rows('p',1),17),/invalid_witness_cohort/);
});
test('a suspended inactive grant must be denied by both implementations',()=>{
  assert.doesNotThrow(()=>verifyNegativeRightsVerdict(
    {allowed:false,reasonCode:'PRODUCT_INACTIVE'},false,'PRODUCT_INACTIVE'));
  for(const [verdict,legacy] of [
    [{allowed:true,reasonCode:'ACTIVE_GRANT'},false],
    [{allowed:false,reasonCode:'PRODUCT_INACTIVE'},true],
    [{allowed:false,reasonCode:'NO_ACTIVE_GRANT'},false],
    [null,false],
  ])assert.throws(()=>verifyNegativeRightsVerdict(verdict,legacy,'PRODUCT_INACTIVE'),
    /deny_policy_exposed/);
});
test('an active Australian-only grant must deny US for NO_ACTIVE_GRANT',()=>{
  assert.doesNotThrow(()=>verifyNegativeRightsVerdict(
    {allowed:false,reasonCode:'NO_ACTIVE_GRANT'},false,'NO_ACTIVE_GRANT'));
  for(const [verdict,legacy] of [
    [{allowed:true,reasonCode:'ACTIVE_GRANT'},false],
    [{allowed:false,reasonCode:'NO_ACTIVE_GRANT'},true],
    [{allowed:false,reasonCode:'PRODUCT_INACTIVE'},false],
    [null,false],
  ])assert.throws(()=>verifyNegativeRightsVerdict(verdict,legacy,'NO_ACTIVE_GRANT'),
    /deny_policy_exposed/);
});
