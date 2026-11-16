/* eslint-disable prettier/prettier -- Private audit witness safety, no customer code. */
/**
 * Fail-closed witness selection for the protected production rights audit.
 * Pure and offline-testable: no SQL, fetch, filesystem, DB writes or logs.
 * The callsite separately enforces the fixed SQL row LIMIT and read-only D1
 * response attestations. Never include product identifiers in CI output.
 */
export const POSITIVE_WITNESSES=8;
export const NEGATIVE_WITNESSES=4;
export const TERRITORY_WITNESSES=4;

export function addRightsWitnesses(destination,rows,limit,excluded=new Set()){
  if(!(destination instanceof Set)||!(excluded instanceof Set)||
    !Array.isArray(rows)||!Number.isSafeInteger(limit)||limit<1||limit>16)
    throw Error('rights_spot_audit_invalid_witness_cohort');
  let selected=0;
  for(const row of rows){
    const id=String(row?.product_id||'');
    if(!/^[a-zA-Z0-9_:-]{1,128}$/.test(id)||id.startsWith('perf-synth-'))
      throw Error('rights_spot_audit_invalid_identifier');
    if(destination.size>=limit)continue;
    if(!destination.has(id)&&!excluded.has(id)){destination.add(id);selected++;}
  }
  return selected;
}
export function assertRightsWitnessCoverage(positive,suspended,territory){
  if(!(positive instanceof Set)||!(suspended instanceof Set)||
    !(territory instanceof Set)||
    positive.size!==POSITIVE_WITNESSES||
    suspended.size!==NEGATIVE_WITNESSES||
    territory.size!==TERRITORY_WITNESSES||
    [...suspended].some(id=>positive.has(id))||
    [...territory].some(id=>positive.has(id)||suspended.has(id)))
    throw Error('rights_spot_audit_insufficient_three_policy_witnesses');
}
export function verifyNegativeRightsVerdict(verdict,legacy,expectedReason){
  if(verdict?.allowed!==false||legacy!==false||
    verdict?.reasonCode!==expectedReason)
    throw Error('rights_spot_audit_deny_policy_exposed');
}
