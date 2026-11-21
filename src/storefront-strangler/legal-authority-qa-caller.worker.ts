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
    const callerUnavailable={"cache-control":"no-store","x-cove-qa-unavailable-layer":"caller"};
    const expires=Number(env.COVE_LEGAL_QA_EXPIRES_AT);
    if(env.COVE_LEGAL_QA_CALLER_ENABLED!=="1" ||
       !Number.isSafeInteger(expires)||expires<=Date.now()||
       !env.COVE_LEGAL_QA_GATE||!/^[a-f0-9]{64}$/.test(env.COVE_LEGAL_QA_GATE)||
       !env.COVE_RIGHTS_OWNER_SECRET||!/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET)||
       typeof env.LEGAL_PRIVATE?.fetch!=="function")
      return new Response(null,{status:503,headers:callerUnavailable});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_LEGAL_QA_GATE)
      return new Response(null,{status:401,headers:noStore});
    if(request.method!=="POST"||request.headers.has("cookie")||
       request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:405,headers:noStore});
    const uri=new URL(request.url);
    // Distinguish caller HTTP ingress from service-binding/owner and D1
    // latency. This is only available inside the expiring, bearer-gated
    // synthetic QA caller, never on a customer Worker.
    if(!uri.search&&uri.pathname==="/qa/transport-caller-ping"){
      const raw=await request.text();
      if(raw!=="{}")return new Response(null,{status:400,headers:noStore});
      const headers=new Headers(noStore);
      const ingress=(request as Request&{cf?:{colo?:string}}).cf?.colo;
      if(typeof ingress==="string"&&/^[A-Z]{3}$/.test(ingress))
        headers.set("x-cove-qa-ingress-colo",ingress);
      return Response.json({schema:"cove.qa.transport-caller-ping.v1"},{headers});
    }
    if(uri.search || !["/deny-next","/deny-next-batch","/verify","/authorize-batch","/market/deny-next","/market/withdraw","/quarantine","/evidence/revoke","/source/retract-batch",
        "/commercial/deny-next","/commercial/deny-batch","/commercial/subject/deny-next",
        "/commercial/authorize-batch","/commercial/publish-verified",
        "/commercial/suspend-grant","/commercial/suspend-contract",
        "/commercial/retail/publish-verified","/commercial/retail/withdraw",
        "/commercial/entitlement/deny-next","/commercial/entitlement/publish-verified",
        "/commercial/entitlement/authorize","/commercial/entitlement/revoke",
        "/commercial/entitlement/deny-batch","/commercial/entitlement/revoke-order",
        "/commercial/order/deny-next","/commercial/order/verify",
        "/storefront/authorize-batch","/storefront/publish-commercial",
        "/qa/native-first-paint","/qa/transport-owner-ping","/qa/current-mutation-fence"].includes(uri.pathname))
      return new Response(null,{status:404,headers:noStore});
    const isWriter=uri.pathname==="/market/withdraw" ||
      uri.pathname==="/quarantine" || uri.pathname==="/evidence/revoke" ||
      uri.pathname==="/source/retract-batch" ||
      uri.pathname==="/commercial/suspend-grant" ||
      uri.pathname==="/commercial/suspend-contract" ||
      uri.pathname==="/commercial/retail/publish-verified" ||
      uri.pathname==="/commercial/retail/withdraw" ||
      uri.pathname==="/commercial/entitlement/revoke" ||
      uri.pathname==="/commercial/entitlement/revoke-order";
    if(isWriter && (!env.LEGAL_WRITER?.fetch ||
       !/^[a-f0-9]{64}$/.test(env.COVE_LEGAL_WRITER_SECRET||"")))
      return new Response(null,{status:503,headers:callerUnavailable});
    const raw=await request.text();
    if(raw.length>24000)return new Response(null,{status:413,headers:noStore});
    // No browser identity, cookie, query string, or untrusted headers cross
    // this service boundary; the backing DO independently verifies the key.
    const destination=isWriter?env.LEGAL_WRITER!:env.LEGAL_PRIVATE;
    const target=isWriter?"https://legal-quarantine.internal":"https://legal-authority.internal";
    const key=isWriter?env.COVE_LEGAL_WRITER_SECRET:env.COVE_RIGHTS_OWNER_SECRET;
    // Measure the interval in THIS isolated QA caller from service binding
    // invocation until the owner DO returns its RESPONSE HEADERS. This includes
    // placement/dispatch/queue effects, but not caller ingress or body transfer.
    const bindingStarted=performance.now();
    const response=await destination.fetch(new Request(target+uri.pathname,{
      method:"POST",
      headers:{"content-type":"application/json",
        "authorization":"Bearer "+key},
      body:raw
    }));
    if(uri.pathname==="/qa/transport-owner-ping" ||
       uri.pathname==="/qa/native-first-paint"){
      const bindingMs=performance.now()-bindingStarted;
      const headers=new Headers(response.headers);
      if(Number.isFinite(bindingMs)&&bindingMs>=0&&bindingMs<=12000)
        headers.set("x-cove-qa-binding-header-ms",bindingMs.toFixed(2));
      // Do NOT infer Durable Object locality from this value. The colo here
      // is solely the external HTTP caller's edge ingress.
      const ingress=(request as Request&{cf?:{colo?:string}}).cf?.colo;
      if(typeof ingress==="string"&&/^[A-Z]{3}$/.test(ingress))
        headers.set("x-cove-qa-ingress-colo",ingress);
      if(response.status===503)
        headers.set("x-cove-qa-unavailable-layer","owner");
      return new Response(response.body,{status:response.status,headers});
    }
    // Only report an enum layer on unavailable responses; never leak
    // credentials, request data, owner SQL or internal error messages.
    if(response.status!==503)return response;
    const headers=new Headers(response.headers);
    headers.set("x-cove-qa-unavailable-layer",isWriter?"writer":"owner");
    return new Response(response.body,{status:response.status,headers});
  }
};
