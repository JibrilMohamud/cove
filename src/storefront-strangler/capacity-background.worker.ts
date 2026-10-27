/* eslint-disable prettier/prettier -- Synthetic capacity-only background lane with exact private routes. */
/**
 * Measure actual Cloudflare data-plane D1 background writes/reads. This is
 * deliberately NOT the Cloudflare management API: the release campaign must
 * measure customer serving under genuine concurrent background D1 service
 * work, not GitHub runner connectivity to the control plane.
 */
type D1Statement = {
  bind(...params:(string|number)[]):D1Statement;
  run():Promise<{success?:boolean;meta?:unknown}>;
  all<T=unknown>():Promise<{success?:boolean;results:T[];meta?:unknown}>;
  first<T=unknown>():Promise<T|null>;
};
type D1Binding = {prepare(sql:string):D1Statement};
type Env={
  CONTENT_DB:D1Binding;
  DISCOVERY_DB:D1Binding;
  COVE_BG_KEY?:string;
  COVE_BG_RUN_ID?:string;
  COVE_BG_ENABLED?:string;
  COVE_BG_EXPIRES_AT?:string;
};
const catalogRead="SELECT product_id FROM catalog_search_documents INDEXED BY idx_search_popular_stable WHERE currency='USD' AND availability='available' AND suppressed=0 ORDER BY fore_bestseller_score DESC,external_book_id ASC,product_id ASC LIMIT 128";
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const headers={"cache-control":"no-store","content-type":"application/json"};
    const expiry=Number(env.COVE_BG_EXPIRES_AT),now=Date.now();
    if(env.COVE_BG_ENABLED!=="1"||!Number.isSafeInteger(expiry)||
      expiry<=now||expiry>now+35*60_000 ||
      !/^\d{8,15}$/.test(env.COVE_BG_RUN_ID||"")||
      !/^[a-f0-9]{64}$/.test(env.COVE_BG_KEY||""))
      return new Response(null,{status:503,headers});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_BG_KEY)
      return new Response(null,{status:401,headers});
    const url=new URL(request.url);
    if(request.method!=="POST"||url.search||request.headers.has("cookie")||
       request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")
      return new Response(null,{status:405,headers});
    if(url.pathname!=="/health"&&url.pathname!=="/tick")
      return new Response(null,{status:404,headers});
    try{
      if(url.pathname==="/health"){
        // No state change, only both exact physical bindings' readiness.
        const [a,b]=await Promise.all([
          env.CONTENT_DB.prepare("SELECT 1 ok").first<{ok:number}>(),
          env.DISCOVERY_DB.prepare("SELECT 1 ok").first<{ok:number}>()
        ]);
        if(a?.ok!==1||b?.ok!==1)throw Error("background_bindings_unready");
        return Response.json({ok:true},{headers});
      }
      const raw=await request.text();
      if(raw.length>120)return new Response(null,{status:413,headers});
      const body:unknown=JSON.parse(raw);
      if(!body||typeof body!=="object"||Array.isArray(body)||
        !Number.isSafeInteger((body as {sequence?:unknown}).sequence)||
        Number((body as {sequence:number}).sequence)<0||
        Number((body as {sequence:number}).sequence)>100000)
        return new Response(null,{status:400,headers});
      const n=(body as {sequence:number}).sequence;
      const start=performance.now();
      const [written,discovered]=await Promise.all([
        env.CONTENT_DB.prepare(
          "INSERT INTO cove_arch_load(run_id,sequence,payload) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload"
        ).bind(env.COVE_BG_RUN_ID!,String(n),"derived-preparation-"+n).run(),
        env.DISCOVERY_DB.prepare(catalogRead).all<{product_id:string}>()
      ]);
      if(written.success===false||discovered.success===false||
        !Array.isArray(discovered.results))
        throw Error("background_sql_failure");
      return Response.json({ok:true,sequence:n,durationMs:performance.now()-start,
        discoveryRows:discovered.results.length,meta:[written.meta,discovered.meta]},
        {headers});
    }catch(error){
      // Log an enum only, not D1 query text, data, or customer identifiers.
      console.error("capacity_background_lane_failed",
        error instanceof Error?error.name:"unknown");
      return Response.json({ok:false,code:"background_unavailable"},{status:503,headers});
    }
  }
};
