/* eslint-disable prettier/prettier -- Private legal-authority boundary is security-sensitive. */
import { DurableObject } from "cloudflare:workers";
import {publishVerifiedPaidOrderAtomic,type VerifiedPaidOrderLine} from "./paid-order-atomic-publication";
import {createMarketAuthoritySchema,denyMarket,marketIsWithdrawn} from "./market-authority-core";
import { authorizeStorefrontPresentationIds, type CatalogDB } from "../features/fore/catalog-model.server";
import { resolveProductRights } from "../features/fore/rights.server";
import {
  captureEntitlementEpoch,createPaidEntitlementSchema,
  denyPaidOrder,denyPaidEntitlement,denyPaidEntitlementsBatch,
  publishFreshEntitlement,readPaidAccess,readPaidOrderPermission,
  validatePaidEntitlementScope,
} from "./commercial-entitlement-core";
import {
  captureCommercialEpoch, createCommercialAuthoritySchema,
  denyCommercialProduct, denyCommercialProductsBatch, denyCommercialSubject,
  publishFreshCommercialProof, readCommercialProofs,
  commercialProductId, type CommercialChannel,
} from "./commercial-legal-core";
import {
  createCommercialStorefrontSchema,publishCommercialStorefront,readCommercialStorefront,
} from "./commercial-storefront-authority";
import {
  applyAuthorityCommand, capturePositiveVerificationFence, commitFreshPositiveVerification,
  createAuthoritySchema, createAuthorityProofSchema,
  readAuthority, readAuthorizedPresentations,
  persistSourceWithdrawal, persistSourceWithdrawalsBatch,
  validateAuthorityCommand, type AuthoritySql,
} from "./legal-authority-core";

type LegalAuthorityEnv = {
  PRIMARY_DB: CatalogDB;
  COVE_RIGHTS_OWNER_SECRET?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  LEGAL_AUTHORITY?: {getByName(name:string):{fetch(request:Request):Promise<Response>}};
};
// Never accept an unspecified primary binding. This is a newly provisioned,
// completely separate canonical QA D1. Real production is NOT enrolled.
// Only these two physically separate, synthetic QA databases can issue a
// short-lived owner lease. The second has canonical paid-commerce schema;
// neither is the capacity fixture or a customer production database.
const QA_PRIMARIES = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
function qaOwnerLeaseLive(env:LegalAuthorityEnv) {
  const expires=Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  const now=Date.now();
  // An interrupted GitHub job cannot accidentally leave the QA legal owner
  // operable. A fresh, strictly bounded lease is required by BOTH the Worker
  // entrypoint and its Durable Object; no stale toggle can bypass this fence.
  return env.COVE_RIGHTS_OWNER_ENABLED==="1" &&
    QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID||"") &&
    Number.isSafeInteger(expires) && expires>now &&
    expires<=now+15*60*1000 &&
    !!env.COVE_RIGHTS_OWNER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET);
}

export class CoveLegalAuthority extends DurableObject<LegalAuthorityEnv> {
  constructor(ctx: { storage: { sql: unknown } }, env: LegalAuthorityEnv) {
    super(ctx, env);
    createAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createAuthorityProofSchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialStorefrontSchema(ctx.storage.sql as unknown as AuthoritySql);
    createPaidEntitlementSchema(ctx.storage.sql as unknown as AuthoritySql);
    createMarketAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
  }

  async fetch(request: Request): Promise<Response> {
    const noStore={ "cache-control": "no-store" };
    const env=this.env;
    if (!qaOwnerLeaseLive(env))
      return new Response(null,{status:503,headers:noStore});
    // All calls must arrive by private service binding with an independent
    // operator secret. Nothing on this Worker should be publicly routed.
    if (request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:noStore});
    if(request.method!=="POST") return new Response(null,{status:405,headers:noStore});
    const route=new URL(request.url).pathname;
    if(!["/deny","/deny-next","/deny-next-batch","/verify","/publish-allow","/authorize-batch",
      "/commercial/deny-next","/commercial/deny-batch","/commercial/subject/deny-next","/commercial/publish-verified",
      "/commercial/authorize-batch",
      "/storefront/authorize-batch","/storefront/publish-commercial",
      "/market/deny-next",
      "/commercial/order/deny-next","/commercial/order/verify",
      "/commercial/entitlement/deny-next","/commercial/entitlement/deny-batch",
      "/commercial/entitlement/publish-verified",
      "/commercial/entitlement/publish-order-verified",
      "/commercial/entitlement/authorize"].includes(route))
      return new Response(null,{status:404,headers:noStore});
    if (request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:415,headers:noStore});
    let raw:unknown;
    try {
      const bytes=await request.text();
      if(bytes.length>(["/authorize-batch","/deny-next-batch","/commercial/authorize-batch","/commercial/deny-batch","/commercial/entitlement/deny-batch","/storefront/authorize-batch"].includes(route)?24000:1024)) return new Response(null,{status:413,headers:noStore});
      raw=JSON.parse(bytes);
    }catch {return new Response(null,{status:400,headers:noStore});}
    const sql=this.ctx.storage.sql as unknown as AuthoritySql;
    try {
      if(route==="/market/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyMarket(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      // All territory-sensitive owner decisions, including historical paid
      // entitlements, are blocked by one durable market tombstone. This is
      // deliberately NOT an asynchronous fanout across product grants.
      const marketScopedRoutes=new Set([
        "/verify","/authorize-batch","/publish-allow",
        "/commercial/authorize-batch","/commercial/publish-verified",
        "/storefront/authorize-batch","/storefront/publish-commercial",
        "/commercial/entitlement/authorize",
        "/commercial/entitlement/publish-verified"
      ]);
      if(marketScopedRoutes.has(route) &&
         marketIsWithdrawn(sql,(raw as {territory?:unknown})?.territory))
        return new Response(null,{status:409,headers:noStore});
      if(route==="/commercial/order/verify"){
        return Response.json(readPaidOrderPermission(sql,raw),{headers:noStore});
      }
      if(route==="/commercial/order/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyPaidOrder(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyPaidEntitlementsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>denyPaidEntitlement(sql,raw));
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/entitlement/authorize"){
        const row=readPaidAccess(sql,raw);
        return Response.json({schema:"cove.paid-access.v1",allowed:!!row,proof:row},
          {headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-order-verified"){
        // No caller-supplied entitlement list is trusted. The strong owner
        // discovers ALL canonical lines for this exact paid order and
        // verifies their immutable purchase scopes against its own legal
        // grants. One DO transaction then publishes the entire cart or none.
        const q=raw as {orderId?:unknown;userId?:unknown;
          territory?:unknown;channel?:unknown}|null;
        if(!q||typeof q.orderId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.orderId)||
           typeof q.userId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.userId)||
           typeof q.territory!=="string"||!/^[A-Z]{2}$/.test(q.territory)||
           q.channel!=="retail")
          return new Response(null,{status:400,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,territory_code,status FROM commerce_orders WHERE id=? AND user_id=?"
        ).bind(q.orderId,q.userId).first<{
          id:string;user_id:string;territory_code:string;status:string
        }>();
        if(!order||order.status!=="paid"||order.territory_code!==q.territory)
          return new Response(null,{status:409,headers:noStore});
        const items=(await env.PRIMARY_DB.prepare(
          `SELECT oi.id,oi.product_id,oi.sales_channel,oi.preorder_id,
                  oi.entitlement_status,oi.rights_grant_id,oi.rights_snapshot_json,
                  e.id entitlement_id,e.status entitlement_state,e.source entitlement_source,
                  e.starts_at entitlement_starts_at,e.ends_at entitlement_ends_at
             FROM commerce_order_items oi LEFT JOIN entitlements e
               ON e.order_item_id=oi.id AND e.user_id=? AND
                  e.product_id=oi.product_id AND e.entitlement_type='purchase'
            WHERE oi.order_id=? ORDER BY oi.id LIMIT 26`
        ).bind(q.userId,q.orderId).all<{
          id:string;product_id:string;sales_channel:string;
          preorder_id:string|null;entitlement_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null;
          entitlement_id:string|null;entitlement_state:string|null;
          entitlement_source:string|null;entitlement_starts_at:string|null;
          entitlement_ends_at:string|null;
        }>()).results;
        if(!items.length||items.length>25||
           new Set(items.map(x=>x.product_id)).size!==items.length)
          return new Response(null,{status:409,headers:noStore});
        // Preorders never mint a downloadable entitlement in this path.
        const delivered=items.filter(x=>!x.preorder_id);
        if(!delivered.length)
          return new Response(null,{status:409,headers:noStore});
        if(delivered.some(x=>x.entitlement_status!=="granted"||
           x.entitlement_state!=="active"||x.entitlement_source!=="commerce"||
           x.sales_channel!=="retail"||!x.entitlement_id))
          return new Response(null,{status:409,headers:noStore});
        // Read-only canonical buyer risk gate. Each denied/held line
        // invalidates the full cart, not just an individual ebook.
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds WHERE domain='buyer' AND subject_type='order' AND subject_id=? AND status='active' AND hold_scope IN ('checkout','entitlement') LIMIT 1"
        ).bind(q.orderId).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const lines:VerifiedPaidOrderLine[]=[];
        const now=Date.now();
        for(const item of delivered){
          // A multi-book cart obeys the same time window as a single
          // purchase. Invalid canonical timestamps fail closed rather than
          // issuing a fresh five-minute owner lease for an expired line.
          const starts=item.entitlement_starts_at===null?null:
            Date.parse(item.entitlement_starts_at);
          const ends=item.entitlement_ends_at===null?null:
            Date.parse(item.entitlement_ends_at);
          if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
             (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
            return new Response(null,{status:409,headers:noStore});
          const rows=readCommercialProofs(sql,[item.product_id],
            q.territory,"retail");
          if(rows.length!==1)return new Response(null,{status:409,headers:noStore});
          const rights=rows[0]!;
          let purchased:unknown;
          try{purchased=JSON.parse(item.rights_snapshot_json||"null");}
          catch{return new Response(null,{status:409,headers:noStore});}
          const acquired=purchased as {
            grantId?:unknown;editionId?:unknown;territory?:unknown;
            salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
          }|null;
          if(!acquired||acquired.grantId!==item.rights_grant_id||
             acquired.grantId!==rights.grant_id||
             acquired.editionId!==rights.edition_id||
             acquired.contractId!==rights.contract_id||
             acquired.contractVersionId!==rights.contract_version_id||
             acquired.territory!==q.territory||acquired.salesChannel!=="retail")
            return new Response(null,{status:409,headers:noStore});
          const expiry=Math.min(now+5*60_000,Date.parse(rights.valid_until),
            ends??Number.POSITIVE_INFINITY);
          if(!Number.isFinite(expiry)||expiry<=now)
            return new Response(null,{status:409,headers:noStore});
          const scope={
            entitlementId:item.entitlement_id!,userId:q.userId,
            productId:item.product_id
          };
          lines.push({...scope,territory:q.territory,channel:"retail",
            orderId:q.orderId,productEpoch:rights.epoch,
            validUntil:new Date(expiry).toISOString(),
            expectedEpoch:captureEntitlementEpoch(sql,scope)});
        }
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          publishVerifiedPaidOrderAtomic(sql,lines,Date.now())
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-verified"){
        const scope=validatePaidEntitlementScope(raw);
        const input=raw as {territory?:unknown;channel?:unknown};
        if(typeof input.territory!=="string" ||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        // Product permission must already be published. Entitlement alone
        // NEVER overrides a global paid-contract withdrawal.
        const rights=readCommercialProofs(sql,[scope.productId],
          input.territory,input.channel as CommercialChannel);
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const expected=captureEntitlementEpoch(sql,scope);
        const ent=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,product_id,status,entitlement_type,source,starts_at,ends_at,order_item_id FROM entitlements WHERE id=? AND user_id=? AND product_id=?"
        ).bind(scope.entitlementId,scope.userId,scope.productId)
          .first<{id:string;user_id:string;product_id:string;status:string;
            entitlement_type:string;source:string;starts_at:string|null;
            ends_at:string|null;order_item_id:string|null}>();
        if(!ent||ent.status!=="active"||ent.entitlement_type!=="purchase"||
           ent.source!=="commerce"||!ent.order_item_id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const starts=ent.starts_at===null?null:Date.parse(ent.starts_at);
        const ends=ent.ends_at===null?null:Date.parse(ent.ends_at);
        if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
           (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
          return new Response(null,{status:409,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT co.id order_id,co.territory_code,coi.sales_channel,coi.preorder_id,coi.entitlement_status,co.status order_status,coi.rights_grant_id,coi.rights_snapshot_json FROM commerce_order_items coi JOIN commerce_orders co ON co.id=coi.order_id WHERE coi.id=? AND coi.product_id=? AND co.user_id=?"
        ).bind(ent.order_item_id,scope.productId,scope.userId)
          .first<{order_id:string;territory_code:string;sales_channel:string;preorder_id:string|null;
          entitlement_status:string;order_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null}>();
        if(!order||order.entitlement_status!=="granted"||
           order.order_status!=="paid" ||order.preorder_id!==null||
           order.territory_code!==input.territory||
           order.sales_channel!==input.channel||
           order.rights_grant_id!==rights[0].grant_id)
          return new Response(null,{status:409,headers:noStore});
        // This compatibility endpoint may only publish a genuinely
        // single-delivery order. Otherwise a caller could expose the first
        // valid line of a cart whose second line fails atomic certification.
        // Preorders are financial reservations and do not deliver here.
        const inventory=await env.PRIMARY_DB.prepare(
          "SELECT COUNT(*) delivery_count FROM commerce_order_items WHERE order_id=? AND preorder_id IS NULL"
        ).bind(order.order_id).first<{delivery_count:number}>();
        if(!inventory||inventory.delivery_count!==1)
          return new Response(null,{status:409,headers:noStore});
        let purchased:unknown=null;
        try{purchased=JSON.parse(order.rights_snapshot_json||"");}
        catch{return new Response(null,{status:409,headers:noStore});}
        // The paid order's original acquisition identity must match ALL
        // dimensions of the fresh legal proof, not only a contract version.
        // An unrelated grant, edition, contract or market cannot launder
        // a settled buyer entitlement into a new legal scope.
        const acquired=purchased as {
          grantId?:unknown;editionId?:unknown;territory?:unknown;
          salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
        }|null;
        if(!acquired ||
           acquired.grantId!==rights[0].grant_id ||
           acquired.editionId!==rights[0].edition_id ||
           acquired.territory!==input.territory ||
           acquired.salesChannel!==input.channel ||
           acquired.contractId!==rights[0].contract_id ||
           acquired.contractVersionId!==rights[0].contract_version_id)
          return new Response(null,{status:409,headers:noStore});
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds rh JOIN commerce_order_items oi ON oi.order_id=rh.subject_id WHERE rh.domain='buyer' AND rh.subject_type='order' AND rh.status='active' AND rh.hold_scope IN ('checkout','entitlement') AND oi.id=? LIMIT 1"
        ).bind(ent.order_item_id).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const expiry=Math.min(Date.now()+5*60000,
          ends??Number.POSITIVE_INFINITY,
          Date.parse(rights[0].valid_until));
        if(!Number.isFinite(expiry)||expiry<=Date.now())
          return new Response(null,{status:409,headers:noStore});
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_paid_entitlement_verification");
          return publishFreshEntitlement(sql,{...scope,
            // The owner core must receive the exact acquisition market.
            // Omitting either field rejects all positive buyer publication.
            territory:input.territory,channel:input.channel as CommercialChannel,
            orderId:order.order_id,productEpoch:rights[0].epoch,
            validUntil:new Date(expiry).toISOString()
          },expected);
        });
        return Response.json(receipt,{status:receipt.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/subject/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyCommercialSubject(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyCommercialProductsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          denyCommercialProduct(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      // Mixed free and contract-backed paid shelf. The entire authorization
      // happens under one strongly consistent SQLite owner, never primary D1.
      // Missing/unpublished rows are absent, not inferred from KV/R2.
      if(route==="/storefront/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||input.ids.length>128||
           new Set(input.ids).size!==input.ids.length||
           input.ids.some(id=>typeof id!=="string"||
             !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(id))||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const free=input.ids.filter((id):id is string=>
          typeof id==="string"&&id.startsWith("prd_gutenberg_"));
        const paid=input.ids.filter((id):id is string=>
          typeof id==="string"&&!id.startsWith("prd_gutenberg_"));
        const rows=[
          ...readAuthorizedPresentations(sql,free,input.territory,input.currency),
          ...readCommercialStorefront(sql,paid,input.territory,input.currency)
        ];
        const position=new Map(input.ids.map((id,i)=>[id,i]));
        rows.sort((a,b)=>(position.get(a.product_id)??129)-(position.get(b.product_id)??129));
        return Response.json({schema:"cove.storefront-owner.v1",rows:rows.slice(0,25)},
          {headers:noStore});
      }
      if(route==="/storefront/publish-commercial"){
        const input=raw as {productId?:unknown;territory?:unknown;currency?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId)||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const rights=readCommercialProofs(sql,[input.productId],
          input.territory,"retail");
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const row=(await authorizeStorefrontPresentationIds(
          env.PRIMARY_DB,[input.productId],input.territory,input.currency
        ))[0];
        if(!row||row.product_id!==input.productId||
           row.edition_id!==rights[0].edition_id||
           !row.offer_json)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const expires=Math.min(now+5*60_000,Date.parse(rights[0].valid_until));
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_offer_verification");
          return publishCommercialStorefront(sql,{
            product_id:row.product_id,edition_id:row.edition_id,
            product_public_id:row.product_public_id,
            edition_public_id:row.edition_public_id,
            territory:input.territory as string,currency:input.currency as string,
            rights_epoch:rights[0].epoch,
            grant_id:rights[0].grant_id,contract_id:rights[0].contract_id!,
            contract_version_id:rights[0].contract_version_id!,
            offer_json:row.offer_json!,
            valid_until:new Date(expires).toISOString()
          });
        });
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/commercial/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;channel?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.channel!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readCommercialProofs(
          sql,input.ids,input.territory,input.channel as CommercialChannel
        );
        return Response.json({schema:"cove.commercial-legal.v1",rows},
          {headers:noStore});
      }
      if(route==="/commercial/publish-verified"){
        const input=raw as {productId?:unknown;territory?:unknown;channel?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId) ||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        const startEpoch=captureCommercialEpoch(sql,input);
        const product=await env.PRIMARY_DB.prepare(
          "SELECT id,source_name,edition_id FROM products WHERE id=?"
        ).bind(input.productId).first<{
          id:string;source_name:string;edition_id:string
        }>();
        if(!product || ["gutenberg","upload"].includes(product.source_name))
          return new Response(null,{status:409,headers:noStore});
        // The canonical evaluator checks territorial grant priority, contract
        // version scope, license language, DRM, channel and current status.
        // Persist=false: owner publication does NOT add primary D1 writes.
        const decision=await resolveProductRights(
          env.PRIMARY_DB,input.productId,input.territory,{
            salesChannel:input.channel as CommercialChannel,persist:false
          }
        );
        if(!decision.allowed || !decision.grantId ||
           decision.editionId!==product.edition_id ||
           decision.productId!==product.id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const upperBound=now+30*60*1000;
        const ends=[decision.endsAt,
          (decision.contractPolicy as {effectiveTo?:unknown}|null)?.effectiveTo]
          .filter((v):v is string=>typeof v==="string"&&v.length>0)
          .map(v=>Date.parse(v));
        if(ends.some(t=>!Number.isFinite(t) || t<=now))
          return new Response(null,{status:409,headers:noStore});
        const expiresAt=Math.min(upperBound,...ends);
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_commercial_verification");
          return publishFreshCommercialProof(sql,{
            productId:product.id,editionId:product.edition_id,
            territory:input.territory as string,channel:input.channel as CommercialChannel,
            grantId:decision.grantId!,contractId:decision.contractId,
            contractVersionId:decision.contractVersionId,
            validUntil:new Date(expiresAt).toISOString(),
          },startEpoch);
        });
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/verify") {
        const input=raw as {sourceId?:unknown;territory?:unknown};
        if(!input||typeof input.sourceId!=="string"||typeof input.territory!=="string")
          return new Response(null,{status:400,headers:noStore});
        return Response.json(readAuthority(sql,input.sourceId,input.territory),
          {headers:noStore});
      }
      if(route==="/authorize-batch") {
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.currency!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readAuthorizedPresentations(sql,input.ids,input.territory,input.currency);
        return Response.json({schema:"cove.legal-authorized.v1",rows},
          {headers:noStore});
      }
      if(route==="/deny-next-batch") {
        // Transaction boundary is mandatory even when an unexpected receipt
        // throws mid-batch: all owner fences persist or none persist.
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          persistSourceWithdrawalsBatch(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/deny-next") {
        const verdict=persistSourceWithdrawal(sql,raw);
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      const command=validateAuthorityCommand(raw);
      if(route==="/deny") {
        if(command.action!=="deny") return new Response(null,{status:400,headers:noStore});
        const verdict=applyAuthorityCommand(sql,command);
        // A stale/failed deny is NOT acknowledged as successful.
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(command.action!=="allow"||command.territory==="*")
        return new Response(null,{status:400,headers:noStore});
      const input=raw as {currency?:unknown};
      if(typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
        return new Response(null,{status:400,headers:noStore});
      // Positive transitions alone contact canonical primary D1. This
      // verifies a current retail grant, exact source/evidence/territory and
      // active market offer; the hot /verify path never consults D1.
      // It is NOT sufficient to enable production until ALL canonical legal
      // mutation writers have been enclosed in deny-first owner fencing.
      const proofStartRevision=capturePositiveVerificationFence(sql,command);
      const authorized=await authorizeStorefrontPresentationIds(
        env.PRIMARY_DB,["prd_gutenberg_"+command.sourceId],
        command.territory,input.currency
      );
      if(authorized.length!==1 ||
          authorized[0].product_id!=="prd_gutenberg_"+command.sourceId ||
          !authorized[0].offer_json)
        return new Response(null,{status:409,headers:noStore});
      const storage=this.ctx.storage as typeof this.ctx.storage&{
        transactionSync<T>(fn:()=>T):T;
      };
      const verdict=storage.transactionSync(()=>{
        if(marketIsWithdrawn(sql,command.territory))
          throw Error("market_withdrawn_during_source_verification");
        return commitFreshPositiveVerification(
        sql,command,proofStartRevision,input.currency as string,{
          productId:authorized[0].product_id,
          editionId:authorized[0].edition_id,
          productPublicId:authorized[0].product_public_id || null,
          editionPublicId:authorized[0].edition_public_id || null,
          offerJson:authorized[0].offer_json!,
        });
      });
      if(!verdict.applied)
        return Response.json(verdict,{status:409,headers:noStore});
      return Response.json(verdict,{status:200,headers:noStore});
    } catch(error) {
      console.error("cove_legal_authority_closed",error instanceof Error?error.name:"unknown");
      return new Response(null,{status:503,headers:noStore});
    }
  }
}
// Service-binding-only entrypoint for the separately authenticated QA caller.
// workers_dev=false, routes=[], no preview URLs; even this private entrypoint
// is disabled unless the dedicated QA primary ID and secret match exactly.
// The Durable Object remains the single legal serialization point.
export default {
  async fetch(request:Request,env:LegalAuthorityEnv):Promise<Response> {
    if(!qaOwnerLeaseLive(env) || !env.LEGAL_AUTHORITY?.getByName)
      return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:{"cache-control":"no-store"}});
    return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1").fetch(request);
  }
};
