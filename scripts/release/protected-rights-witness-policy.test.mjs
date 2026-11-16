/* eslint-disable prettier/prettier -- Adversarial protected rights withdrawal fixture. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addRightsWitnesses,assertRightsWitnessCoverage,verifyNegativeRightsVerdict,
  POSITIVE_WITNESSES,NEGATIVE_WITNESSES} from './protected-rights-witness-policy.mjs';

const rows=(name,n)=>Array.from({length:n},(_,i)=>({product_id:name+i}));
test('positive and suspended witnesses stay independently budgeted',()=>{
  const yes=new Set(),no=new Set();
  assert.equal(addRightsWitnesses(yes,rows('allow',8),POSITIVE_WITNESSES),8);
  assert.equal(addRightsWitnesses(no,rows('deny',4),NEGATIVE_WITNESSES,yes),4);
  assert.doesNotThrow(()=>assertRightsWitnessCoverage(yes,no));
  assert.equal(addRightsWitnesses(yes,rows('allowExtra',4),POSITIVE_WITNESSES),0);
  assert.equal(addRightsWitnesses(no,rows('denyExtra',4),NEGATIVE_WITNESSES,yes),0);
  assert.equal(yes.size,8);
  assert.equal(no.size,4);
});
test('absence of real suspended grants is not a passing denial result',()=>{
  const allow=new Set(rows('a',8).map(x=>x.product_id));
  const deny=new Set(rows('d',3).map(x=>x.product_id));
  assert.throws(()=>assertRightsWitnessCoverage(allow,deny),/insufficient_deny_and_allow_witnesses/);
  deny.add('d3');
  assert.doesNotThrow(()=>assertRightsWitnessCoverage(allow,deny));
  allow.delete('a0');
  assert.throws(()=>assertRightsWitnessCoverage(allow,deny),/insufficient_deny_and_allow_witnesses/);
});
test('no duplicate witness and no positive/negative overlap',()=>{
  const a=new Set(['p0']),b=new Set();
  assert.equal(addRightsWitnesses(a,[{product_id:'p0'},{product_id:'p1'}],8),1);
  assert.equal(addRightsWitnesses(b,[{product_id:'p0'},{product_id:'p2'}],4,a),1);
  assert.deepEqual([...b],['p2']);
  const allow=new Set(rows('p',8).map(x=>x.product_id));
  const deny=new Set(rows('d',4).map(x=>x.product_id));
  deny.delete('d0');deny.add('p0');
  assert.throws(()=>assertRightsWitnessCoverage(allow,deny),/insufficient_deny_and_allow_witnesses/);
});
test('malformed IDs, pseudo-synthetic IDs, oversized IDs and invalid input fail closed',()=>{
  for(const bad of ['','perf-synth-1','p with space','a;DELETE FROM products','x'.repeat(129)])
    assert.throws(()=>addRightsWitnesses(new Set(),[{product_id:bad}],8),/invalid_identifier/);
  assert.throws(()=>addRightsWitnesses(new Set(),[{}],8),/invalid_identifier/);
  assert.throws(()=>addRightsWitnesses({},rows('p',1),8),/invalid_witness_cohort/);
  assert.throws(()=>addRightsWitnesses(new Set(),rows('p',1),13),/invalid_witness_cohort/);
});
test('a suspended grant only counts as denial when both policies deny, with expected reason',()=>{
  assert.doesNotThrow(()=>verifyNegativeRightsVerdict({allowed:false,reasonCode:'PRODUCT_INACTIVE'},false));
  for(const [verdict,legacy] of [
    [{allowed:true,reasonCode:'ALLOWED'},false],
    [{allowed:false,reasonCode:'PRODUCT_INACTIVE'},true],
    [{allowed:false,reasonCode:'NO_ACTIVE_GRANT'},false],
    [{allowed:false},false],
    [null,false],
  ])assert.throws(()=>verifyNegativeRightsVerdict(verdict,legacy),/suspended_grant_exposed/);
});
