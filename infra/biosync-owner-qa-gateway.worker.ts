/* eslint-disable prettier/prettier -- Synthetic QA-only ingress, no primary D1 or customer route. */
import {dispatchCanonicalOwnerCommand} from "../src/storefront-strangler/canonical-owner-command-gateway";

type LegalPort={fetch(request:Request):Promise<Response>};
type Env={
  LEGAL_AUTHORITY?:LegalPort;
  COVE_BIOSYNC_QA_GATEWAY_ENABLED?:string;
  COVE_BIOSYNC_QA_PRIMARY_ID?:string;
  COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT?:string;
  COVE_BIOSYNC_QA_CLIENT_SECRET?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
};
const ALLOWED_BINDINGS=new Set([
  "LEGAL_AUTHORITY",
  "COVE_BIOSYNC_QA_GATEWAY_ENABLED",
  "COVE_BIOSYNC_QA_PRIMARY_ID",
  "COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT",
  "COVE_BIOSYNC_QA_CLIENT_SECRET",
  "COVE_RIGHTS_OWNER_SECRET",
]);
// Unlike the legal owner's other synthetic fixtures, BioSync can only
// reach its own dedicated D1 and no other QA or production principal.
const QA_PRIMARIES=new Set(["4e17ba6f-444f-4245-801a-a7d4969045b0"]);
const deny={"cache-control":"no-store","x-content-type-options":"nosniff"};
// Never allow an accidental production zone route or arbitrary preview/custom
// domain to become a public ingress for this temporary authenticated QA owner.
const QA_WORKERS_DEV_HOST=/^cove-biosync-gateway-qa-\d{8,15}-\d{1,5}\.cove-qa-reads\.workers\.dev$/;
function canCallOwner(env:Env){
  const now=Date.now(),expires=Number(env.COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT);
  return env.COVE_BIOSYNC_QA_GATEWAY_ENABLED==="1" &&
    QA_PRIMARIES.has(env.COVE_BIOSYNC_QA_PRIMARY_ID||"") &&
    Number.isSafeInteger(expires)&&expires>now&&expires<=now+15*60*1000 &&
    /^[0-9a-f]{64}$/.test(env.COVE_BIOSYNC_QA_CLIENT_SECRET||"") &&
    /^[0-9a-f]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"") &&
    typeof env.LEGAL_AUTHORITY?.fetch==="function" &&
    // NO direct D1 binding of ANY name, nor a third-party service or admin
    // secret. Adding a new binding requires a new independently reviewed QA.
    Object.keys(env).every(name=>ALLOWED_BINDINGS.has(name));
}
/** 
 * This Worker is never mounted into the production backend. A separate,
 * short-leased, least-privilege QA principal can submit exactly ONE typed
 * nonauthorizing metadata command via owner service binding. No SQL, public
 * accounts, entitlements, direct D1 binding or production database allowed.
 */
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    const readOnlyOwnerProbe=url.pathname==="/qa/owner-bound-ready";
    if(url.protocol!=="https:"||url.port||!QA_WORKERS_DEV_HOST.test(url.hostname)||
       (!readOnlyOwnerProbe&&url.pathname!=="/biosync/publish-checked")||url.search)
      return new Response(null,{status:404,headers:deny});
    if(!canCallOwner(env))return new Response(null,{status:503,headers:deny});
    if(request.method!=="POST")return new Response(null,{status:405,headers:deny});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_BIOSYNC_QA_CLIENT_SECRET)
      return new Response(null,{status:401,headers:deny});
    if(request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:415,headers:deny});
    if(Number(request.headers.get("content-length")||0)>1024)
      return new Response(null,{status:413,headers:deny});
    try{
      const encoded=await request.text();
      if(encoded.length>1024)return new Response(null,{status:413,headers:deny});
      // The only readiness probe follows the SAME private owner service
      // binding and independently authenticated owner/DO as the write.
      // GET is rejected by that owner with 405 BEFORE body parsing, D1, R2,
      // any publication command or durable receipt. It cannot acknowledge
      // or replay an uncertain positive commit.
      if(readOnlyOwnerProbe){
        if(encoded!=="{}")return new Response(null,{status:400,headers:deny});
        const owner=await env.LEGAL_AUTHORITY!.fetch(new Request(
          "https://legal-authority.internal/biosync/publish-checked",{
            method:"GET",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET}
          }
        ));
        if(owner.status!==405||owner.headers.get("cache-control")!=="no-store")
          return new Response(null,{status:503,headers:deny});
        return Response.json({schema:"cove.qa.biosync-owner-binding-readiness.v1"},
          {status:200,headers:deny});
      }
      const raw=JSON.parse(encoded);
      const receipt=await dispatchCanonicalOwnerCommand(
        env.LEGAL_AUTHORITY!,env.COVE_RIGHTS_OWNER_SECRET!,
        "biosync.publish-checked",raw
      );
      return Response.json(receipt,{status:200,headers:deny});
    }catch{
      return new Response(null,{status:503,headers:deny});
    }
  }
};
