/* eslint-disable prettier/prettier -- Isolated synthetic paid-settlement QA is a narrow trust boundary. */
import {certifyStagePaidSettlement,assertStagePaidOrderNotWithdrawn} from "./paid-settlement-publication.server";
import type {CoveEnv} from "../features/fore/api.server";
import {requireStagePaidEntitlementAccess} from "./legal-consumer-fence.server";
import {stripeWebhook} from "../features/fore/commerce.server";

type D1={prepare:(sql:string)=>unknown};
type Env={
  PRIMARY_DB?:D1;
  LEGAL_PRIVATE?:{fetch:(request:Request)=>Promise<Response>};
  COVE_PAID_STAGE_QA_ENABLED?:string;
  COVE_PAID_STAGE_QA_EXPIRES_AT?:string;
  COVE_PAID_STAGE_QA_GATE?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
  STRIPE_WEBHOOK_SECRET?:string;
  STRIPE_LIVEMODE?:string;
  COVE_PAID_INITIAL_ORDER?:string;
  COVE_PAID_INITIAL_BUYER?:string;
  COVE_SSR_STAGING?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  COVE_LEGAL_CONSUMER_STAGE_ENABLED?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
};
const FULL_SCHEMA_QA="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const ORDER="order_paid_qa_20261027";
const BUYER="user_paid_qa_20261027";
const ENTITLEMENT="ent_paid_qa_20261027";
const PRODUCT="prd_paid_qa_20261027";
const isInitial=(env:Env,orderId:unknown,userId:unknown)=>
  typeof env.COVE_PAID_INITIAL_ORDER==="string" &&
  /^order_initial_qa_\d{8,15}$/.test(env.COVE_PAID_INITIAL_ORDER) &&
  typeof env.COVE_PAID_INITIAL_BUYER==="string" &&
  /^user_initial_qa_\d{8,15}$/.test(env.COVE_PAID_INITIAL_BUYER) &&
  orderId===env.COVE_PAID_INITIAL_ORDER &&
  userId===env.COVE_PAID_INITIAL_BUYER;
function available(env:Env):boolean{
  const exp=Number(env.COVE_PAID_STAGE_QA_EXPIRES_AT);
  return env.COVE_PAID_STAGE_QA_ENABLED==="1" &&
    env.COVE_SSR_STAGING==="1" &&
    env.COVE_CANONICAL_LEGAL_WRITE_LOCK==="1" &&
    env.COVE_LEGAL_CONSUMER_STAGE_ENABLED==="1" &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID===FULL_SCHEMA_QA &&
    /^[a-f0-9]{64}$/.test(env.COVE_PAID_STAGE_QA_GATE||"") &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"") &&
    Number.isSafeInteger(exp)&&exp>Date.now()&&exp<=Date.now()+20*60_000 &&
    typeof env.LEGAL_PRIVATE?.fetch==="function" &&
    typeof env.PRIMARY_DB?.prepare==="function";
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const headers={"cache-control":"no-store"};
    if(!available(env))return new Response(null,{status:503,headers});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_PAID_STAGE_QA_GATE)
      return new Response(null,{status:401,headers});
    const url=new URL(request.url);
    if(request.method!=="POST"||url.search||
      request.headers.get("content-type")?.split(";")[0].trim()!=="application/json" ||
      request.headers.has("cookie"))
      return new Response(null,{status:405,headers});
    const signedStripe=url.pathname==="/signed-stripe-settlement";
    if(!["/certify-paid","/preflight-paid","/authorize-delivery",
      "/certify-initial","/authorize-initial"].includes(url.pathname) && !signedStripe)
      return new Response(null,{status:404,headers});
    const interruptOwnerAfterPaid=signedStripe &&
      request.headers.get("x-cove-qa-interrupt-postpaid")==="1";
    const facade={...env,DB:env.PRIMARY_DB,
      STRIPE_TAX_ENABLED:"false",
      LEGAL_AUTHORITY:{
        getByName(name:string){
          if(name!=="cove-staged-legal-global-v1")throw Error("invalid_owner_namespace");
          return {
            fetch(ownerRequest:Request){
              if(interruptOwnerAfterPaid &&
                new URL(ownerRequest.url).pathname==="/commercial/entitlement/publish-verified")
                return Promise.resolve(new Response(null,{status:503}));
              return env.LEGAL_PRIVATE!.fetch(ownerRequest);
            }
          };
        }
      }
    } as unknown as CoveEnv;
    if(signedStripe){
      // Exercise the ACTUAL signed Cove webhook handler, not a fabricated
      // "Stripe succeeded" owner call. Only the one synthetic paid-order
      // fixture and a real Stripe test-mode event are accepted. No publicly
      // routed payment endpoint or production Stripe secrets.
      if(!/^whsec_[a-zA-Z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET||"") ||
         env.STRIPE_LIVEMODE!=="false")
        return new Response(null,{status:503,headers});
      const raw=await request.text();
      if(raw.length>16384||!request.headers.get("stripe-signature"))
        return new Response(null,{status:400,headers});
      let evt:{type?:string;livemode?:boolean;data?:{object?:{
        id?:string;status?:string;amount_received?:number;currency?:string;
        metadata?:{fore_order_id?:string};
      }}};
      try{evt=JSON.parse(raw);}catch{return new Response(null,{status:400,headers});}
      const intent=evt?.data?.object;
      if(evt?.type!=="payment_intent.succeeded" || evt?.livemode!==false ||
         intent?.status!=="succeeded" || intent?.amount_received!==399 ||
         String(intent.currency).toLowerCase()!=="usd" ||
         !(intent?.metadata?.fore_order_id===ORDER ||
           intent?.metadata?.fore_order_id===env.COVE_PAID_INITIAL_ORDER) ||
         typeof intent?.id!=="string" || !/^pi_[a-zA-Z0-9]{8,100}$/.test(intent.id))
        return new Response(null,{status:400,headers});
      try{
        const outcome=await stripeWebhook(facade,new Request(request.url,{
          method:"POST",headers:{"stripe-signature":request.headers.get("stripe-signature")!,
            "content-type":"application/json"},body:raw
        }));
        return Response.json({ok:true,duplicate:outcome.duplicate===true},{headers});
      }catch(e){
        const status=typeof e==="object"&&e!==null&&"status" in e?
          Number((e as {status:unknown}).status):503;
        return Response.json({ok:false},{status:[400,409,451,503].includes(status)?status:503,headers});
      }
    }
    let body:unknown;
    try{
      const raw=await request.text();
      if(raw.length>200)return new Response(null,{status:413,headers});
      body=JSON.parse(raw);
    }catch{return new Response(null,{status:400,headers});}
    if(!body||typeof body!=="object"||Array.isArray(body)||
      Object.keys(body).length!==2||
      !((body as Record<string,unknown>).orderId===ORDER &&
        (body as Record<string,unknown>).userId===BUYER) &&
      !isInitial(env,(body as Record<string,unknown>).orderId,
        (body as Record<string,unknown>).userId))
      return new Response(null,{status:400,headers});
    try{
      const first=isInitial(env,(body as Record<string,unknown>).orderId,
        (body as Record<string,unknown>).userId);
      if(url.pathname==="/certify-initial" ||
         (url.pathname==="/certify-paid"&&first))
        await certifyStagePaidSettlement(facade,
          env.COVE_PAID_INITIAL_ORDER!,env.COVE_PAID_INITIAL_BUYER!);
      else if(url.pathname==="/certify-paid")
        await certifyStagePaidSettlement(facade,ORDER,BUYER);
      else if(url.pathname==="/preflight-paid")
        await assertStagePaidOrderNotWithdrawn(facade,
          first?env.COVE_PAID_INITIAL_ORDER!:ORDER);
      else if(url.pathname==="/authorize-initial"){
        if(!first)return new Response(null,{status:400,headers});
        const entitlement=await (env.PRIMARY_DB! as unknown as {
          prepare(sql:string):{bind(...a:string[]):{
            all<T>():Promise<{results:T[]}>}}
        }).prepare(
          `SELECT e.id FROM entitlements e JOIN commerce_order_items oi
              ON oi.id=e.order_item_id WHERE oi.order_id=?
              AND e.user_id=? AND e.product_id=? AND e.status='active'
              AND e.entitlement_type='purchase' AND e.source='commerce' LIMIT 2`
        ).bind(env.COVE_PAID_INITIAL_ORDER!,env.COVE_PAID_INITIAL_BUYER!,PRODUCT)
          .all<{id:string}>();
        if(entitlement.results.length!==1)return new Response(null,{status:451,headers});
        await requireStagePaidEntitlementAccess(facade,{
          entitlementId:entitlement.results[0]!.id,
          userId:env.COVE_PAID_INITIAL_BUYER!,productId:PRODUCT,
          territory:"US",channel:"retail"
        });
      }
      else if(url.pathname==="/authorize-delivery"){
        if(first)return new Response(null,{status:400,headers});
        await requireStagePaidEntitlementAccess(facade,{
          entitlementId:ENTITLEMENT,userId:BUYER,productId:PRODUCT,
          territory:"US",channel:"retail"
        });
      } else return new Response(null,{status:404,headers});
      return Response.json({ok:true},{headers});
    }catch(e){
      // Status-only contract. Never expose paid buyer identity or canonical
      // order, Stripe metadata, secrets, or the owner error body.
      const code=typeof e==="object"&&e!==null&&"status" in e?
        Number((e as {status:unknown}).status):503;
      return Response.json({ok:false},
        {status:[409,451,503].includes(code)?code:503,headers});
    }
  }
};
