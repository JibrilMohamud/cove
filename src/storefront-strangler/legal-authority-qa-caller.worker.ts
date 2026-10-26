/* eslint-disable prettier/prettier -- Expiring stage-only QA proxy keeps guard conditions explicit. */
/**
 * Protected, short-lived staging proof caller. NOT a customer route.
 * Only forwards a tiny, exact set of test operations to the separately
 * non-routable legal owner service; no account or protected asset data.
 * Runtime expiry ensures an interrupted test never leaves an active gateway.
 */
type QaEnv={
  COVE_LEGAL_QA_CALLER_ENABLED?:string;
  COVE_LEGAL_QA_GATE?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
  COVE_LEGAL_QA_EXPIRES_AT?:string;
  LEGAL_PRIVATE?:{fetch(request:Request):Promise<Response>};
  LEGAL_WRITER?:{fetch(request:Request):Promise<Response>};
  COVE_LEGAL_WRITER_SECRET?:string;
};
export default {
  async fetch(request:Request,env:QaEnv):Promise<Response>{
    const noStore={"cache-control":"no-store"};
    const expires=Number(env.COVE_LEGAL_QA_EXPIRES_AT);
    if(env.COVE_LEGAL_QA_CALLER_ENABLED!=="1" ||
       !Number.isSafeInteger(expires)||expires<=Date.now()||
       !env.COVE_LEGAL_QA_GATE||!/^[a-f0-9]{64}$/.test(env.COVE_LEGAL_QA_GATE)||
       !env.COVE_RIGHTS_OWNER_SECRET||!/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET)||
       typeof env.LEGAL_PRIVATE?.fetch!=="function")
      return new Response(null,{status:503,headers:noStore});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_LEGAL_QA_GATE)
      return new Response(null,{status:401,headers:noStore});
    if(request.method!=="POST"||request.headers.has("cookie")||
       request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:405,headers:noStore});
    const uri=new URL(request.url);
    if(uri.search || !["/deny-next","/deny-next-batch","/verify","/authorize-batch","/quarantine","/evidence/revoke","/source/retract-batch",
        "/commercial/deny-next","/commercial/deny-batch",
        "/commercial/authorize-batch","/commercial/publish-verified",
        "/commercial/suspend-grant","/commercial/suspend-contract",
        "/commercial/entitlement/deny-next","/commercial/entitlement/publish-verified",
        "/commercial/entitlement/authorize","/commercial/entitlement/revoke",
        "/commercial/entitlement/deny-batch","/commercial/entitlement/revoke-order",
        "/commercial/order/deny-next"].includes(uri.pathname))
      return new Response(null,{status:404,headers:noStore});
    const isWriter=uri.pathname==="/quarantine" || uri.pathname==="/evidence/revoke" ||
      uri.pathname==="/source/retract-batch" ||
      uri.pathname==="/commercial/suspend-grant" ||
      uri.pathname==="/commercial/suspend-contract" ||
      uri.pathname==="/commercial/entitlement/revoke" ||
      uri.pathname==="/commercial/entitlement/revoke-order";
    if(isWriter && (!env.LEGAL_WRITER?.fetch ||
       !/^[a-f0-9]{64}$/.test(env.COVE_LEGAL_WRITER_SECRET||"")))
      return new Response(null,{status:503,headers:noStore});
    const raw=await request.text();
    if(raw.length>24000)return new Response(null,{status:413,headers:noStore});
    // No browser identity, cookie, query string, or untrusted headers cross
    // this service boundary; the backing DO independently verifies the key.
    const destination=isWriter?env.LEGAL_WRITER!:env.LEGAL_PRIVATE;
    const target=isWriter?"https://legal-quarantine.internal":"https://legal-authority.internal";
    const key=isWriter?env.COVE_LEGAL_WRITER_SECRET:env.COVE_RIGHTS_OWNER_SECRET;
    return destination.fetch(new Request(target+uri.pathname,{
      method:"POST",
      headers:{"content-type":"application/json",
        "authorization":"Bearer "+key},
      body:raw
    }));
  }
};
