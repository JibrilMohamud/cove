/* eslint-disable prettier/prettier -- Private owner attestation must remain a narrow, nonauthorizing protocol. */
/**
 * This proves private runtime reachability and the *disabled* state only.
 * It NEVER authorizes rights, publishing, settlement, delivery or cutover.
 */
export const DISABLED_OWNER_ATTEST_ROUTE="/__cove/legal-owner/attest-disabled";
export const DISABLED_OWNER_ATTEST_SCHEMA="cove.production-legal-owner-disabled.v1";
export const PRODUCTION_LEGAL_PRIMARY="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const PRODUCTION_OWNER_OBJECT="cove-staged-legal-global-v1";

type DisabledState={
  COVE_RIGHTS_OWNER_ENABLED?:string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?:string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
};
type OwnerPort={fetch(request:Request):Promise<Response>};
export type DisabledOwnerCallerEnv={
  COVE_RIGHTS_OWNER_SECRET?:string;
  LEGAL_AUTHORITY?:{getByName(name:string):OwnerPort};
};

export function isDisabledProductionOwner(env:DisabledState):boolean {
  return env.COVE_RIGHTS_OWNER_ENABLED==="0" &&
    env.COVE_RIGHTS_OWNER_PRIMARY_ID===PRODUCTION_LEGAL_PRIMARY &&
    !env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"");
}
export function validOwnerChallenge(value:unknown):value is string {
  return typeof value==="string" && /^[a-f0-9]{32}$/.test(value);
}
export function disabledOwnerReceipt(challenge:string) {
  return {schema:DISABLED_OWNER_ATTEST_SCHEMA,challenge,
    primaryId:PRODUCTION_LEGAL_PRIMARY,ownerEnabled:false,
    permitsRightsWrites:false,implementation:"CoveLegalAuthority"};
}
export function verifyDisabledOwnerReceipt(value:unknown,challenge:string):boolean {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const x=value as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
      "challenge,implementation,ownerEnabled,permitsRightsWrites,primaryId,schema" &&
    x.schema===DISABLED_OWNER_ATTEST_SCHEMA &&
    x.challenge===challenge && x.primaryId===PRODUCTION_LEGAL_PRIMARY &&
    x.ownerEnabled===false && x.permitsRightsWrites===false &&
    x.implementation==="CoveLegalAuthority";
}
export async function attestDisabledOwnerFromBackend(env:DisabledOwnerCallerEnv) {
  if(!/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"") ||
     !env.LEGAL_AUTHORITY?.getByName)
    throw Error("disabled_owner_binding_unavailable");
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  const challenge=[...bytes].map(n=>n.toString(16).padStart(2,"0")).join("");
  const response=await env.LEGAL_AUTHORITY.getByName(PRODUCTION_OWNER_OBJECT)
    .fetch(new Request("https://legal-authority.internal"+DISABLED_OWNER_ATTEST_ROUTE,{
      method:"POST",headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
        "content-type":"application/json"},
      body:JSON.stringify({challenge})
    }));
  if(response.status!==200)throw Error("disabled_owner_not_acknowledged");
  const json:unknown=await response.json();
  if(!verifyDisabledOwnerReceipt(json,challenge))
    throw Error("disabled_owner_receipt_mismatch");
  // Only a disabled, unreachable-for-rights Durable Object has responded.
  return {attested:true,ownerEnabled:false,authorizing:false};
}
