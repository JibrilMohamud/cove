/* eslint-disable prettier/prettier -- production role and route boundary */
import { PRODUCTION_LEGAL_PRIMARY } from "./production-disabled-owner-attestation";
import type { BackendEnv } from "../persistence-backend.worker";

export const PRODUCTION_PRIMARY=PRODUCTION_LEGAL_PRIMARY;
export const PRODUCTION_OWNER_OBJECT="cove-staged-legal-global-v1";
export const BIOSYNC_PATH="/__cove/biosync/publish-checked";
export const OWNER_BIOSYNC_PATH="/biosync/publish-checked";
export const OWNER_SCHEDULE_PATH="/production/private-backend-scheduled-tick";
export const PRODUCTION_SCHEDULES=Object.freeze([
  "* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"
]);
type Port={fetch(request:Request):Promise<Response>};
export type ProductionPersistenceEnv=Partial<BackendEnv>&{
  COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED?:string;
  COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED?:string;
  COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED?:string;
  COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED?:string;
  COVE_BIOSYNC_CLIENT_TOKEN_SHA256?:string;
  COVE_RIGHTS_OWNER_ENABLED?:string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?:string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
  PRIMARY_DB?:BackendEnv["DB"];
  LITERARY_CONTENT_DB?:BackendEnv["DB"];
  LEGAL_AUTHORITY?:{getByName(name:string):Port};
};
export const noStore={"cache-control":"no-store","x-content-type-options":"nosniff"};
export const refuse=(status=503)=>new Response(null,{status,headers:noStore});
export const hashConfigured=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const native=(x:unknown)=>!!x&&typeof x==="object"&&typeof (x as {prepare?:unknown}).prepare==="function";
export async function checkToken(value:string,expected:unknown){
  if(!hashConfigured(expected)||value.length<24||value.length>4096)return false;
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
  const actual=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  let diff=0;
  for(let i=0;i<64;i++)diff|=actual.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}
/** Production physical ownership is separate from legal positive authority.
 * A production maintenance enrollment cannot turn on QA flags or issue an
 * unverified grant. The distinct literary database is never lent to business
 * code; its actual resource identity is also checked by the deployment plan.
 */
export function productionPersistenceEnrolled(env:ProductionPersistenceEnv){
  return env.COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED==="1"&&
    env.FORE_ENVIRONMENT==="production"&&env.FORE_AUTH_MODE==="supabase"&&
    env.COVE_SSR_STAGING!=="1"&&env.COVE_RIGHTS_OWNER_ENABLED==="0"&&
    env.COVE_RIGHTS_OWNER_PRIMARY_ID===PRODUCTION_PRIMARY&&
    env.COVE_LEGAL_WRITER_PRIMARY_ID===PRODUCTION_PRIMARY&&
    !env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT&&
    hashConfigured(env.FORE_BACKEND_TOKEN_SHA256)&&hashConfigured(env.COVE_RIGHTS_OWNER_SECRET)&&
    env.FORE_BACKEND_TOKEN_SHA256!==env.COVE_RIGHTS_OWNER_SECRET&&
    !env.FORE_BACKEND_TOKEN&&
    native(env.PRIMARY_DB)&&typeof env.PRIMARY_DB?.batch==="function"&&
    native(env.LITERARY_CONTENT_DB)&&env.PRIMARY_DB!==env.LITERARY_CONTENT_DB&&
    typeof env.LEGAL_AUTHORITY?.getByName==="function"&&
    Object.entries(env).every(([key,value])=>
      (!native(value)||["PRIMARY_DB","LITERARY_CONTENT_DB"].includes(key))&&
      (!key.startsWith("COVE_QA_")||value===undefined||value==="0"))&&
    [undefined,"0"].includes(env.COVE_PUBLICATION_COMMANDS_ENABLED)&&
    [undefined,"0"].includes(env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE)&&
    [undefined,"0"].includes(env.COVE_COMMERCE_OWNER_D1_FENCE)&&
    [undefined,"0"].includes(env.COVE_CANONICAL_LEGAL_WRITE_LOCK)&&
    [undefined,"0"].includes(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED);
}
/** Only explicitly nonauthorizing original backend operations may run before
 * the real production consumer/rights and commerce commands are enrolled.
 * Unknown methods, query variations and every catalog/offer/asset route
 * fail closed, rather than serving a cached or D1-only unverified allow.
 */
const operations=new Set([
  "GET /__cove/health",
  "POST /api/fore/account/preferences",
  "GET /api/fore/reader/settings",
  "POST /api/fore/reader/settings",
  "GET /api/fore/notifications/preferences",
  "POST /api/fore/notifications/preferences"
]);
export function maintenanceBusinessRoute(request:Request){
  const u=new URL(request.url);
  return !u.search&&operations.has(request.method+" "+u.pathname);
}
export function productionBiosyncEnrolled(env:ProductionPersistenceEnv){
  return productionPersistenceEnrolled(env)&&
    [undefined,"0"].includes(env.COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED)&&
    env.COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED==="1"&&
    hashConfigured(env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256)&&
    env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256!==env.FORE_BACKEND_TOKEN_SHA256&&!!env.BUCKET?.get;
}
export function bearer(request:Request){
  const value=request.headers.get("authorization")||"";
  return value.startsWith("Bearer ")?value.slice(7):"";
}
export function productionBiosyncRequest(request:Request){
  const u=new URL(request.url);
  return u.pathname===BIOSYNC_PATH&&!u.search&&request.method==="POST"&&
    request.headers.get("content-type")?.split(";")[0]?.trim()==="application/json"&&
    !request.headers.has("cookie");
}
export function productionOwnerInternalRequest(request:Request,secret:string){
  return request.method==="POST"&&request.headers.get("authorization")==="Bearer "+secret&&
    request.headers.get("content-type")?.split(";")[0]?.trim()==="application/json"&&
    !new URL(request.url).search&&!request.headers.has("cookie");
}

/** Independent production BioSync enrollment, while the customer backend
 * and its schedules remain unchanged. This cannot enable any legal grants,
 * customer request or ordinary business mutation. No backend secrets needed.
 */
export function productionBiosyncBridgeEnrolled(env:ProductionPersistenceEnv){
  return env.COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED==="1"&&
    [undefined,"0"].includes(env.COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED)&&
    [undefined,"0"].includes(env.COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED)&&
    [undefined,"0"].includes(env.COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED)&&
    env.FORE_ENVIRONMENT==="production"&&env.COVE_SSR_STAGING!=="1"&&
    env.COVE_RIGHTS_OWNER_ENABLED==="0"&&
    env.COVE_RIGHTS_OWNER_PRIMARY_ID===PRODUCTION_PRIMARY&&
    !env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT&&
    hashConfigured(env.COVE_RIGHTS_OWNER_SECRET)&&
    hashConfigured(env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256)&&
    env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256!==env.COVE_RIGHTS_OWNER_SECRET&&
    native(env.PRIMARY_DB)&&typeof env.PRIMARY_DB?.batch==="function"&&
    native(env.LITERARY_CONTENT_DB)&&env.PRIMARY_DB!==env.LITERARY_CONTENT_DB&&
    !!env.BUCKET?.get&&typeof env.LEGAL_AUTHORITY?.getByName==="function"&&
    Object.entries(env).every(([key,value])=>
      (!native(value)||["PRIMARY_DB","LITERARY_CONTENT_DB"].includes(key))&&
      (!key.startsWith("COVE_QA_")||value===undefined||value==="0"))&&
    [undefined,"0"].includes(env.COVE_PUBLICATION_COMMANDS_ENABLED)&&
    [undefined,"0"].includes(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED);
}

/** Preserve the existing named ingress during the consolidated transition.
 * Bridge and consolidated enrollment must remain mutually exclusive. */
export function productionNamedBiosyncEnrolled(env:ProductionPersistenceEnv){
  return productionBiosyncBridgeEnrolled(env)||productionBiosyncEnrolled(env);
}

/** Budget rollover is independent of consolidated BioSync client enrollment. */
export function productionLiteraryBudgetEnrolled(env:ProductionPersistenceEnv){
  return productionBiosyncBridgeEnrolled(env)||
    (productionPersistenceEnrolled(env)&&
      [undefined,"0"].includes(env.COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED));
}
