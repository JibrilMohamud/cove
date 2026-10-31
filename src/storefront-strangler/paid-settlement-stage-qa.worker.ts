/* eslint-disable prettier/prettier -- Isolated synthetic paid-settlement QA is a narrow trust boundary. */
import {bindPublicationOwner} from "./publication-owner-routing.server";
import {certifyStagePaidSettlement,assertStagePaidOrderNotWithdrawn} from "./paid-settlement-publication.server";
import type {CoveEnv} from "../features/fore/api.server";
import {requireStagePaidEntitlementAccess} from "./legal-consumer-fence.server";
import {stripeWebhook} from "../features/fore/commerce.server";
import {issueCommercialEpubGrant,serveCommercialEpubGrant} from "../features/fore/delivery.server";
import {issueOfflineEpubLicense} from "../features/fore/offline-epub.server";
import {handleCommercialAudio} from "../features/fore/commercial-audio.server";
import {resolveProductRights} from "../features/fore/rights.server";
import {audioKeyId,base64Url,hashText,publicAudioKey} from "../features/fore/offline-audio-license";
import {OFFLINE_EPUB_CONTEXT,OFFLINE_EPUB_MAX_MS} from "../features/fore/offline-epub-crypto";

type D1={prepare:(sql:string)=>unknown};
type Env={
  PRIMARY_DB?:D1;
  QA_MEDIA?:{get(key:string):Promise<{body:ReadableStream|null;arrayBuffer():Promise<ArrayBuffer>}|null>};
  FORE_OFFLINE_AUDIO_SIGNING_JWK?:string;
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
// Match isolated GitHub run AND attempt; never borrow another run's buyer.
// Production customer order IDs cannot satisfy these QA-only prefixes.
const isInitial=(env:Env,orderId:unknown,userId:unknown)=>
  typeof env.COVE_PAID_INITIAL_ORDER==="string" &&
  /^order_initial_qa_\d{8,15}-\d{1,5}$/.test(env.COVE_PAID_INITIAL_ORDER) &&
  typeof env.COVE_PAID_INITIAL_BUYER==="string" &&
  /^user_initial_qa_\d{8,15}-\d{1,5}$/.test(env.COVE_PAID_INITIAL_BUYER) &&
  (orderId===env.COVE_PAID_INITIAL_ORDER ||
   orderId==="order_audio_qa_"+env.COVE_PAID_INITIAL_ORDER.slice("order_initial_qa_".length)) &&
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
      "/certify-initial","/authorize-initial",
      "/qa/epub-bytes","/qa/audio-bytes","/qa/offline-epub-license",
      "/original/epub-grant","/original/epub-use",
      "/original/offline-epub-license","/original/audio-track",
      "/original/audio-offline","/original/audio-verify",
      "/original/audio-preflight"].includes(url.pathname) && !signedStripe)
      return new Response(null,{status:404,headers});
    const interruptOwnerAfterPaid=signedStripe &&
      request.headers.get("x-cove-qa-interrupt-postpaid")==="1";
    const simulateOwnerOutage=!signedStripe &&
      request.headers.get("x-cove-qa-simulate-owner-outage")==="1";
    let ownerFailure:string|null=null;
    const facade={...env,DB:env.PRIMARY_DB,BUCKET:env.QA_MEDIA,
      FORE_DEFAULT_TERRITORY:"US",
      STRIPE_TAX_ENABLED:"false",
      LEGAL_AUTHORITY:{
        getByName(name:string){
          if(name!=="cove-staged-legal-global-v1")throw Error("invalid_owner_namespace");
          return {
            async fetch(ownerRequest:Request){
              if((interruptOwnerAfterPaid &&
                new URL(ownerRequest.url).pathname==="/commercial/entitlement/publish-verified") ||
                (simulateOwnerOutage &&
                 new URL(ownerRequest.url).pathname==="/commercial/entitlement/authorize"))
                return Promise.resolve(new Response(null,{status:503}));
              const response=await env.LEGAL_PRIVATE!.fetch(ownerRequest);
              const diagnostic=response.headers.get("x-cove-owner-settlement-failure");
              if(new URL(ownerRequest.url).pathname==="/commercial/order/settle"&&
                 diagnostic&&/^[a-z_]+(?::[a-z_][a-z0-9_.]{0,99})?$/.test(diagnostic))ownerFailure=diagnostic;
              return response;
            }
          };
        }
      }
    } as unknown as CoveEnv;
    // The original handlers now dispatch ownership, device and bearer writes
    // through the exact same independently checking private owner as settlement.
    facade.DB=bindPublicationOwner(facade.DB,{
      owner:facade.LEGAL_AUTHORITY!.getByName("cove-staged-legal-global-v1"),
      secret:env.COVE_RIGHTS_OWNER_SECRET!,territory:"US",currency:"USD"
    });
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
           intent?.metadata?.fore_order_id===env.COVE_PAID_INITIAL_ORDER ||
           intent?.metadata?.fore_order_id==="order_audio_qa_"+env.COVE_PAID_INITIAL_ORDER!.slice("order_initial_qa_".length)) ||
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
        return Response.json({ok:false,...(ownerFailure?{ownerFailure}:{})},{status:[400,409,451,503].includes(status)?status:503,headers});
      }
    }
    // Invoke the ORIGINAL Cove customer commercial media functions on an
    // isolated D1, private R2 and synthetic registered-device fixture.
    // All user identity/scope is fixed by an expiring, private bearer QA gate.
    if(url.pathname.startsWith("/original/")){
      let raw:{orderId?:unknown;userId?:unknown;token?:unknown;licenseId?:unknown};
      try{
        const text=await request.text();
        if(text.length>500)return new Response(null,{status:413,headers});
        raw=JSON.parse(text);
      }catch{return new Response(null,{status:400,headers});}
      if(!raw||!isInitial(env,raw.orderId,raw.userId)||
         Object.keys(raw).some(k=>!["orderId","userId","token","licenseId"].includes(k)))
        return new Response(null,{status:400,headers});
      const run=env.COVE_PAID_INITIAL_ORDER!.slice("order_initial_qa_".length),
        deviceId="device_paid_qa_"+run,
        deviceKey="device-qa-"+run+"-registered";
      const audioRoute=url.pathname.startsWith("/original/audio-");
      const audioOrder="order_audio_qa_"+run, audioProduct="prd_audio_qa_"+run;
      if(raw.orderId!==(audioRoute?audioOrder:env.COVE_PAID_INITIAL_ORDER))
        return new Response(null,{status:400,headers});
      const realRequest=new Request("https://qa.cove.invalid/api/fore/delivery/epub",{
        method:"GET",headers:{"x-fore-device-id":deviceId}
      });
      try{
        if(url.pathname==="/original/epub-grant"){
          if(raw.token!==undefined)return new Response(null,{status:400,headers});
          const grant=await issueCommercialEpubGrant(facade,
            env.COVE_PAID_INITIAL_BUYER!,{
              productId:PRODUCT,purpose:"download",deviceId
            },realRequest);
          return Response.json(grant,{headers});
        }
        if(url.pathname==="/original/epub-use"){
          if(typeof raw.token!=="string"||
             !/^[A-Za-z0-9_-]{32,200}$/.test(raw.token))
            return new Response(null,{status:400,headers});
          const response=await serveCommercialEpubGrant(
            facade,raw.token,realRequest
          );
          return new Response(response.body,{status:response.status,
            headers:{...Object.fromEntries(response.headers),...headers}});
        }
        if(url.pathname==="/original/offline-epub-license"){
          if(raw.token!==undefined)return new Response(null,{status:400,headers});
          const license=await issueOfflineEpubLicense(
            facade,env.COVE_PAID_INITIAL_BUYER!,{
              productId:PRODUCT,deviceKey
            },realRequest
          );
          return Response.json(license,{headers});
        }
        if(url.pathname==="/original/audio-preflight"){
          const legal=await resolveProductRights(facade.DB,audioProduct,"US",{
            salesChannel:"retail"
          });
          const source=await facade.DB.prepare(
            `SELECT pv.manifest_json FROM publishing_publications pp
             JOIN publishing_release_lifecycles l
               ON l.publishing_edition_id=(SELECT edition_id FROM publishing_submission_snapshots WHERE id=pp.submission_id)
             JOIN publishing_publication_versions pv
               ON pv.id=l.current_publication_version_id
             WHERE pp.product_id=? ORDER BY pv.version_number DESC LIMIT 1`
          ).bind(audioProduct).first<{manifest_json:string}>();
          let frozen:Record<string,unknown>|null=null;
          try{frozen=JSON.parse(source?.manifest_json||"{}")?.sourceSnapshot?.commercialAudio||null;}
          catch{frozen=null;}
          return Response.json({
            allowed:legal.allowed,reason:legal.reasonCode,
            hasManifest:!!frozen,
            narrators:Array.isArray(frozen?.narrators)?frozen.narrators.length:0,
            agreements:Array.isArray(frozen?.agreements)?frozen.agreements.length:0,
            chapters:Array.isArray(frozen?.chapters)?frozen.chapters.length:0
          },{headers});
        }
        if(["/original/audio-track","/original/audio-offline",
            "/original/audio-verify"].includes(url.pathname)){
          const audioEdition="qa_audio_draft_"+run,
            trackId="qa_audio_chapter_"+run,
            path="/audio/ca_"+audioEdition;
          const isStream=url.pathname==="/original/audio-track";
          const isIssue=url.pathname==="/original/audio-offline";
          if((isStream||isIssue)&&
             (raw.token!==undefined||raw.licenseId!==undefined))
            return new Response(null,{status:400,headers});
          if(!isStream&&!isIssue&&
             (typeof raw.token!=="string"||typeof raw.licenseId!=="string"))
            return new Response(null,{status:400,headers});
          const audioRequest=new Request("https://qa.cove.invalid"+path,{
            method:isStream?"GET":"POST",
            headers:{"content-type":"application/json",
              ...(isStream?{"range":"bytes=0-127"}:{})},
            ...(!isStream?{body:JSON.stringify(isIssue?
              {deviceId,protocolVersion:1}:
              {licenseId:raw.licenseId,token:raw.token})}:{})
          });
          const segment=isStream?"/tracks/"+trackId:
            "/offline-license"+(isIssue?"":"/verify");
          const response=await handleCommercialAudio(
            audioRequest,facade,path+segment,env.COVE_PAID_INITIAL_BUYER!,"US"
          );
          if(!response)return new Response(null,{status:404,headers});
          return new Response(response.body,{status:response.status,
            headers:{...Object.fromEntries(response.headers),...headers}});
        }
        return new Response(null,{status:404,headers});
      }catch(e){
        const status=typeof e==="object"&&e!==null&&"status" in e?
          Number((e as {status:unknown}).status):503;
        // Never leak customer-specific media or SQL diagnostics.
        const labels:Record<string,string>={
          "Commercial audiobook not found.":"audio_catalog_absent",
          "This audiobook is not available in your storefront.":"audio_rights_or_manifest_unavailable",
          "Audio chapter not found.":"audio_chapter_absent",
          "Audio object is unavailable.":"audio_r2_object_absent"
        };
        const category=e instanceof Error?
          (/no such table: ([a-z_]+)/i.exec(e.message)?.[0] ||
           /no such column: ([a-z_]+)/i.exec(e.message)?.[0] ||
           labels[e.message] ||
           (/constraint failed/i.test(e.message)?"constraint_failed":"other_error")):
          "non_error";
        return Response.json({ok:false,qaErrorCategory:category},
          {status:[400,401,403,404,409,410,428,451,503].includes(status)?
            status:503,headers});
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
      const scopedOrder=(body as {orderId:string}).orderId;
      const scopedProduct=scopedOrder.startsWith("order_audio_qa_")?
        "prd_audio_qa_"+scopedOrder.slice("order_audio_qa_".length):PRODUCT;
      if(url.pathname==="/certify-initial" ||
         (url.pathname==="/certify-paid"&&first))
        await certifyStagePaidSettlement(facade,
          scopedOrder,env.COVE_PAID_INITIAL_BUYER!);
      else if(url.pathname==="/certify-paid")
        await certifyStagePaidSettlement(facade,ORDER,BUYER);
      else if(url.pathname==="/preflight-paid")
        await assertStagePaidOrderNotWithdrawn(facade,
          first?scopedOrder:ORDER);
      else if(url.pathname==="/authorize-initial" ||
        url.pathname==="/qa/epub-bytes" ||
        url.pathname==="/qa/audio-bytes" ||
        url.pathname==="/qa/offline-epub-license"){
        if(!first)return new Response(null,{status:400,headers});
        const entitlement=await (env.PRIMARY_DB! as unknown as {
          prepare(sql:string):{bind(...a:string[]):{
            all<T>():Promise<{results:T[]}>}}
        }).prepare(
          `SELECT e.id FROM entitlements e JOIN commerce_order_items oi
              ON oi.id=e.order_item_id WHERE oi.order_id=?
              AND e.user_id=? AND e.product_id=? AND e.status='active'
              AND e.entitlement_type='purchase' AND e.source='commerce' LIMIT 2`
        ).bind(scopedOrder,env.COVE_PAID_INITIAL_BUYER!,scopedProduct)
          .all<{id:string}>();
        if(entitlement.results.length!==1)return new Response(null,{status:451,headers});
        await requireStagePaidEntitlementAccess(facade,{
          entitlementId:entitlement.results[0]!.id,
          userId:env.COVE_PAID_INITIAL_BUYER!,productId:scopedProduct,
          territory:"US",channel:"retail"
        });
        // The next three paths are gated, expiring, bearer-authenticated
        // ISOLATED-QA media fixtures. None is a customer media endpoint.
        // No bytes or receipt are returned before the private owner allows.
        if(url.pathname==="/qa/epub-bytes" || url.pathname==="/qa/audio-bytes"){
          const epub=url.pathname==="/qa/epub-bytes";
          if(!env.QA_MEDIA?.get)return new Response(null,{status:503,headers});
          const object=await env.QA_MEDIA.get(epub?"qa/book.epub":"qa/chapter.wav");
          if(!object)return new Response(null,{status:503,headers});
          const bytes=await object.arrayBuffer();
          return new Response(bytes,{headers:{
            ...headers,"content-type":epub?"application/epub+zip":"audio/wav",
            "x-content-type-options":"nosniff"
          }});
        }
        if(url.pathname==="/qa/offline-epub-license"){
          if(!/^[0-9]{8,15}-[0-9]{1,5}$/.test(env.COVE_PAID_INITIAL_ORDER!.slice(17)) ||
             !env.FORE_OFFLINE_AUDIO_SIGNING_JWK)
            return new Response(null,{status:503,headers});
          const key=JSON.parse(env.FORE_OFFLINE_AUDIO_SIGNING_JWK) as JsonWebKey;
          const publicKey=publicAudioKey(key);
          const keyId=await audioKeyId(publicKey);
          const deviceKey="qa-device-"+env.COVE_PAID_INITIAL_ORDER!.slice(17);
          const at=Date.now();
          const claims={
            version:1,audience:"cove-offline-epub",userId:env.COVE_PAID_INITIAL_BUYER!,
            productId:PRODUCT,deviceKeyHash:await hashText(deviceKey),
            assetVersionId:"qa_epub_asset_"+env.COVE_PAID_INITIAL_ORDER!.slice(17),
            licenseId:"qa_epub_license_"+env.COVE_PAID_INITIAL_ORDER!.slice(17),
            issuedAt:new Date(at).toISOString(),
            expiresAt:new Date(at+OFFLINE_EPUB_MAX_MS).toISOString(),keyId
          };
          const payload=base64Url(new TextEncoder().encode(JSON.stringify(claims)));
          const privateKey=await crypto.subtle.importKey("jwk",key,
            {name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
          const signature=base64Url(new Uint8Array(await crypto.subtle.sign(
            {name:"ECDSA",hash:"SHA-256"},privateKey,
            new TextEncoder().encode(OFFLINE_EPUB_CONTEXT+payload))));
          return Response.json({
            receipt:{payload,signature,keyId},verificationKey:publicKey,
            deviceKey,assetVersionId:claims.assetVersionId,
            expiresAt:claims.expiresAt
          },{headers});
        }
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
