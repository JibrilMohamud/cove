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
    if(uri.search || !["/deny-next","/verify","/authorize-batch","/quarantine"].includes(uri.pathname))
      return new Response(null,{status:404,headers:noStore});
    const isWriter=uri.pathname==="/quarantine";
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
