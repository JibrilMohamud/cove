/* eslint-disable prettier/prettier -- Private deny-first canonical writer trust boundary. */
import {denyWithOwnedSourceEpoch} from "./legal-authority-coordinator";

type WriteDB={
  prepare(query:string):{bind(...args:unknown[]):{
    run():Promise<unknown>;first<T=Record<string,unknown>>():Promise<T|null>;
    all<T=Record<string,unknown>>():Promise<{results:T[]}>
  }};
  batch(statements:unknown[]):Promise<unknown>;
};
type QaWriterEnv={
  PRIMARY_DB:WriteDB;
  LEGAL_PRIVATE:{fetch(request:Request):Promise<Response>};
  COVE_LEGAL_WRITER_ENABLED?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_LEGAL_WRITER_EXPIRES_AT?:string;
  COVE_LEGAL_WRITER_SECRET?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
};
// Exact private QA databases only; never customer primary or load-test fixture.
const QA_PRIMARIES=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
]);
const sourceIdRegex=/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
const opIdRegex=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function qaWriterConfigured(env:QaWriterEnv){
  const exp=Number(env.COVE_LEGAL_WRITER_EXPIRES_AT),at=Date.now();
  return env.COVE_LEGAL_WRITER_ENABLED==="1" &&
    QA_PRIMARIES.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"") &&
    Number.isSafeInteger(exp)&&exp>at&&exp<=at+15*60*1000 &&
    !!env.COVE_LEGAL_WRITER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_LEGAL_WRITER_SECRET) &&
    !!env.COVE_RIGHTS_OWNER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET) &&
    typeof env.LEGAL_PRIVATE?.fetch==="function" &&
    typeof env.PRIMARY_DB?.prepare==="function";
}

export default {
  async fetch(request:Request,env:QaWriterEnv):Promise<Response>{
    const headers={"cache-control":"no-store"};
    if(!qaWriterConfigured(env))return new Response(null,{status:503,headers});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_LEGAL_WRITER_SECRET)
      return new Response(null,{status:401,headers});
    const pathname=new URL(request.url).pathname;
    const isEvidence=pathname==="/evidence/revoke";
    const isMarketWithdrawal=pathname==="/market/withdraw";
    const isRetractionBatch=pathname==="/source/retract-batch";
    const isCommercial=pathname==="/commercial/suspend-grant" ||
      pathname==="/commercial/suspend-contract";
    const isEntitlement=pathname==="/commercial/entitlement/revoke";
    const isRefundBatch=pathname==="/commercial/entitlement/revoke-order";
    const isRetailPublication=pathname==="/commercial/retail/publish-verified";
    const isRetailWithdrawal=pathname==="/commercial/retail/withdraw";
    if(request.method!=="POST" ||
       (pathname!=="/quarantine" && !isEvidence && !isRetractionBatch && !isCommercial && !isEntitlement && !isRefundBatch && !isRetailPublication && !isRetailWithdrawal && !isMarketWithdrawal) ||
       request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json" ||
       request.headers.has("cookie"))
      return new Response(null,{status:405,headers});
    let cmd:{sourceId?:unknown;operationId?:unknown;message?:unknown;
      evidenceId?:unknown;territory?:unknown;operations?:unknown;
      targetId?:unknown;entitlementId?:unknown;orderId?:unknown;
      productId?:unknown;currency?:unknown};
    try{
      const text=await request.text();
      if(text.length>(isRetractionBatch?5000:900))
        return new Response(null,{status:413,headers});
      cmd=JSON.parse(text);
    }catch{return new Response(null,{status:400,headers});}
    if(!cmd || isMarketWithdrawal && (
      typeof cmd.territory!=="string" || !/^[A-Z]{2}$/.test(cmd.territory) ||
      typeof cmd.operationId!=="string" || !opIdRegex.test(cmd.operationId)
    ) || isRefundBatch && (
      typeof cmd.orderId!=="string" ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(cmd.orderId) ||
      typeof cmd.operationId!=="string" ||
      !opIdRegex.test(cmd.operationId)
    ) || isRetailWithdrawal && (
      typeof cmd.productId!=="string" ||
      !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(cmd.productId) ||
      cmd.productId.startsWith("prd_gutenberg_") ||
      typeof cmd.operationId!=="string" || !opIdRegex.test(cmd.operationId)
    ) || isRetailPublication && (
      typeof cmd.productId!=="string" ||
      !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(cmd.productId) ||
      cmd.productId.startsWith("prd_gutenberg_") ||
      typeof cmd.territory!=="string" || !/^[A-Z]{2}$/.test(cmd.territory) ||
      typeof cmd.currency!=="string" || !/^[A-Z]{3}$/.test(cmd.currency) ||
      typeof cmd.operationId!=="string" || !opIdRegex.test(cmd.operationId)
    ) || isEntitlement && (
      typeof cmd.entitlementId!=="string" ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(cmd.entitlementId) ||
      typeof cmd.operationId!=="string" ||
      !opIdRegex.test(cmd.operationId)
    ) || isCommercial && (
      typeof cmd.targetId!=="string" ||
      !/^[a-zA-Z0-9_-]{3,160}$/.test(cmd.targetId) ||
      typeof cmd.operationId!=="string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,80}$/.test(cmd.operationId)
    ) || !isRetractionBatch && !isCommercial && !isEntitlement && !isRefundBatch && !isRetailPublication && !isRetailWithdrawal && !isMarketWithdrawal && (
       !sourceIdRegex.test(String(cmd.sourceId||"")) ||
       !opIdRegex.test(String(cmd.operationId||"")) ||
       (isEvidence
         ? typeof cmd.evidenceId!=="string" ||
           !/^gre_[a-z0-9_:-]{1,120}$/.test(cmd.evidenceId) ||
           typeof cmd.territory!=="string" ||
           !/^[A-Z]{2}$/.test(cmd.territory)
         : typeof cmd.message!=="string"||cmd.message.length>500)))
      return new Response(null,{status:400,headers});
    try{
      if(isMarketWithdrawal){
        const territory=cmd.territory as string;
        // A global market pause cannot be made safe by paging all grants.
        // Durable single-owner territory tombstone comes FIRST. If D1
        // deactivation fails, every owner-backed storefront/paid read still
        // rejects this territory. Replay reconciles the canonical row.
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/market/deny-next",{
            method:"POST",headers:{
              "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"
            },
            body:JSON.stringify({territory,operationId:"market:"+cmd.operationId})
          }
        ));
        if(owner.status!==200)throw Error("market_owner_denial_unavailable");
        const receipt=await owner.json() as {
          applied?:boolean;territory?:string;withdrawn?:boolean
        };
        if(receipt.applied!==true||receipt.territory!==territory||
           receipt.withdrawn!==true)
          throw Error("market_owner_denial_receipt_invalid");
        await env.PRIMARY_DB.prepare(
          "UPDATE storefront_markets SET market_status='paused',checkout_enabled=0,updated_at=datetime('now') WHERE country_code=? AND market_status='active'"
        ).bind(territory).run();
        return Response.json({marketWithdrawn:true,territory},
          {status:200,headers});
      }
      if(isRetailWithdrawal){
        const productId=cmd.productId as string;
        // Withdraw ALL territorial/currency variants first, not only the
        // offer the user edited. This is deliberately conservative: no active
        // buyer presentation can use an old commercial product epoch.
        // The D1 write is a reconciliation sink, NEVER the source of veto.
        const response=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/deny-next",{
            method:"POST",headers:{
              "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"
            },body:JSON.stringify({
              productId,operationId:"retail:"+cmd.operationId
            })
          }
        ));
        if(response.status!==200)throw Error("retail_owner_denial_unavailable");
        const receipt=await response.json() as {applied?:boolean;epoch?:number};
        if(receipt.applied!==true||
           !Number.isSafeInteger(receipt.epoch)||receipt.epoch!<=0)
          throw Error("retail_owner_denial_receipt_invalid");
        // A replay after a fresh positive publication returns applied=false.
        // It must NOT deactivate a newer offer or overwrite its newer epoch.
        const now=new Date().toISOString();
        await env.PRIMARY_DB.prepare(
          "UPDATE offers SET active=0,updated_at=? WHERE product_id=? AND active=1"
        ).bind(now,productId).run();
        return Response.json({withdrawn:true,ownerEpoch:receipt.epoch},
          {status:200,headers});
      }
      if(isRetailPublication){
        // Owner verifies current canonical contract and retail offer itself,
        // then transactionally binds both to the exact paid legal epoch.
        // An interruption after rights publication leaves price unpublished
        // until the same request can be safely retried.
        // The paid legal owner requires a channel; never ask it to infer
        // retail from a caller-controlled currency or a default scope.
        const publication={productId:cmd.productId as string,
          territory:cmd.territory as string,currency:cmd.currency as string,
          channel:"retail" as const};
        const verify=async(route:string)=>{
          const reply=await env.LEGAL_PRIVATE.fetch(new Request(
            "https://legal-authority.internal"+route,{
              method:"POST",headers:{
                "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
                "content-type":"application/json"
              },body:JSON.stringify(publication)
            }
          ));
          if(reply.status!==200)throw Error("positive_owner_publication_unavailable");
          const result=await reply.json() as {applied?:boolean;epoch?:number};
          if(result.applied!==true||!Number.isSafeInteger(result.epoch)||
             result.epoch!<=0)
            throw Error("positive_owner_publication_receipt_invalid");
          return result.epoch!;
        };
        const rightsEpoch=await verify("/commercial/publish-verified");
        const offerEpoch=await verify("/storefront/publish-commercial");
        if(rightsEpoch!==offerEpoch)throw Error("commercial_storefront_epoch_changed");
        return Response.json({published:true,ownerEpoch:offerEpoch},{status:200,headers});
      }
      if(isRefundBatch){
        const orderId=cmd.orderId as string;
        // The writer, not Stripe nor a caller-supplied product list, derives
        // the exact buyer and entitlements of the settled order.
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id FROM commerce_orders WHERE id=?"
        ).bind(orderId).first<{id:string;user_id:string}>();
        if(!order)throw Error("refund_order_not_found");
        // ONE durable owner denial immediately fences ALL purchases under
        // the order, including an order too large for the bounded per-item
        // reconciliation batch. Nothing on a hot storefront path changes.
        const orderOwner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/order/deny-next",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify({
              orderId,operationId:"order-refund:"+cmd.operationId
            })
          }
        ));
        if(orderOwner.status!==200)throw Error("refund_order_owner_unavailable");
        const orderReceipt=await orderOwner.json() as {applied?:boolean;orderId?:string};
        if(!orderReceipt.applied || orderReceipt.orderId!==orderId)
          throw Error("refund_order_owner_receipt_invalid");
        // Once the whole paid order has a durable negative fence, one
        // atomic, indexed canonical UPDATE reconciles all of its entitlements.
        // There is no 25-item RPC fanout and no unrevoked tail in a large
        // order. This also handles mixed commercial/public-domain carts,
        // without ever granting either type of access.
        await env.PRIMARY_DB.prepare(
          "UPDATE entitlements SET status='revoked' WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase' AND status='active'"
        ).bind(order.user_id,orderId).run();
        return Response.json({orderDenied:true},{status:200,headers});
      }
      if(isEntitlement){
        const entitlementId=cmd.entitlementId as string;
        // Only canonical D1 may determine the beneficiary, product and
        // current grant state. No caller-supplied user or product identity.
        const row=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,product_id,status FROM entitlements WHERE id=?"
        ).bind(entitlementId).first<{
          id:string;user_id:string;product_id:string;status:string
        }>();
        if(!row||!["active","revoked"].includes(row.status)||
           !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(row.product_id)||
           row.product_id.startsWith("prd_gutenberg_"))
          throw Error("invalid_entitlement_scope");
        const operation={
          entitlementId:row.id,userId:row.user_id,productId:row.product_id,
          operationId:cmd.operationId as string
        };
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/entitlement/deny-next",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify(operation)
          }
        ));
        if(owner.status!==200)throw Error("entitlement_owner_unavailable");
        const receipt=await owner.json() as {applied?:boolean;epoch?:number};
        if(!receipt.applied||!Number.isSafeInteger(receipt.epoch)||
           Number(receipt.epoch)<=0)
          throw Error("entitlement_owner_receipt_invalid");
        await env.PRIMARY_DB.prepare(
          "UPDATE entitlements SET status='revoked' WHERE id=? AND user_id=? AND product_id=? AND status='active'"
        ).bind(row.id,row.user_id,row.product_id).run();
        return Response.json({revoked:true,epoch:receipt.epoch},
          {status:200,headers});
      }
      if(isCommercial){
        const subjectKind=pathname.endsWith("suspend-grant")?"grant":"contract";
        const subjectId=cmd.targetId as string;
        // A single license contract can cover >25 books. Never truncate a
        // withdrawal by paging product IDs; owner atomically denies the
        // immutable subject ID and reads join it before any canonical write.
        // Negative legal authority MUST be writable when primary D1 is
        // unavailable. This private authenticated writer records the exact
        // subject denial first; canonical D1 is only an after-the-fact
        // reconciliation sink, never a prerequisite for withdrawal.
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/subject/deny-next",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify({
              subjectKind,subjectId,operationId:"commercial:"+cmd.operationId
            })
          }
        ));
        if(owner.status!==200)throw Error("commercial_owner_unavailable");
        const receipt=await owner.json() as {
          applied?:boolean;subjectKind?:string;subjectId?:string
        };
        if(receipt.applied!==true||receipt.subjectKind!==subjectKind||
           receipt.subjectId!==subjectId)
          throw Error("commercial_subject_owner_receipt_invalid");
        const statements=subjectKind==="grant"?[
          env.PRIMARY_DB.prepare(
            "UPDATE rights_grants SET status='suspended' WHERE id=? AND status='active'"
          ).bind(subjectId)
        ]:[
          env.PRIMARY_DB.prepare(
            "UPDATE rights_contracts SET status='suspended' WHERE id=? AND status='active'"
          ).bind(subjectId),
          env.PRIMARY_DB.prepare(
            "UPDATE rights_grants SET status='suspended' WHERE contract_id=? AND status='active'"
          ).bind(subjectId)
        ];
        await env.PRIMARY_DB.batch(statements);
        return Response.json({suspended:true,subject:subjectKind,
          subjectId,ownerDenied:true},{status:200,headers});
      }
      if(isRetractionBatch){
        // A bounded source retraction has ONE strongly consistent owner
        // transaction and ONE atomic primary-D1 batch, never O(N) network
        // calls to both databases. A missing receipt means no canonical
        // mutation. No public caller can exercise this QA-only endpoint.
        if(!Array.isArray(cmd.operations) || cmd.operations.length<1 ||
           cmd.operations.length>25)
          return new Response(null,{status:400,headers});
        const seen=new Set<string>();
        const operations=cmd.operations.map((raw:unknown)=>{
          if(!raw||typeof raw!=="object")throw Error("invalid_retraction");
          const item=raw as Record<string,unknown>;
          if(typeof item.sourceId!=="string"||
             !sourceIdRegex.test(item.sourceId) ||
             typeof item.operationId!=="string" ||
             !opIdRegex.test(item.operationId) ||
             seen.has(item.sourceId))
            throw Error("invalid_retraction");
          seen.add(item.sourceId);
          return {sourceId:item.sourceId,territory:"*",operationId:item.operationId};
        });
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/deny-next-batch",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify({operations})
          }
        ));
        if(owner.status!==200)throw Error("owner_batch_denied");
        const receipt=await owner.json() as {
          applied?:boolean;
          receipts?:Array<{sourceId?:string;operationId?:string;applied?:boolean;revision?:number}>;
        };
        if(receipt.applied!==true || !Array.isArray(receipt.receipts) ||
           receipt.receipts.length!==operations.length ||
           receipt.receipts.some((r,i)=>!r.applied ||
             !Number.isSafeInteger(r.revision) || Number(r.revision)<=0 ||
             r.sourceId!==operations[i].sourceId ||
             r.operationId!==operations[i].operationId))
          throw Error("owner_batch_receipt_unconfirmed");
        const statements=operations.map(op=>env.PRIMARY_DB.prepare(
          "UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='stale' WHERE id=?"
        ).bind(op.sourceId));
        await env.PRIMARY_DB.batch(statements);
        return Response.json({retracted:operations.length,sourceIds:operations.map(op=>op.sourceId)},
          {status:200,headers});
      }
      if(isEvidence) {
        // An evidence withdrawal applies to one exact jurisdiction. It
        // MUST NOT revoke another rights holder's grant or a different
        // country. The DB batch is atomic and begins only after owner ACK.
        await denyWithOwnedSourceEpoch(
          env.LEGAL_PRIVATE,env.COVE_RIGHTS_OWNER_SECRET!,{
            sourceId:cmd.sourceId as string,territory:cmd.territory as string,
            operationId:cmd.operationId as string
          },async()=>{
            // The owner is already denied. Now verify evidence really belongs
            // to this source and market, rather than accepting a guessed ID.
            // A nonexistent source MUST NOT yield a successful legal mutation.
            const existing=await env.PRIMARY_DB.prepare(
              "SELECT status FROM gutenberg_rights_evidence WHERE id=? AND cache_id=? AND territory_code=? AND source_id='pg_us'"
            ).bind(cmd.evidenceId,cmd.sourceId,cmd.territory)
              .first<{status:string}>();
            if(!existing || !["approved","revoked"].includes(existing.status))
              throw Error("legal_evidence_scope_not_found");
            const evidence=env.PRIMARY_DB.prepare(
              "UPDATE gutenberg_rights_evidence SET status='revoked' WHERE id=? AND cache_id=? AND territory_code=? AND status='approved'"
            ).bind(cmd.evidenceId,cmd.sourceId,cmd.territory);
            const grant=env.PRIMARY_DB.prepare(
              "UPDATE rights_grants SET status='suspended' WHERE edition_id=? AND territory_code=? AND source='gutenberg-pg_us-public-domain' AND decision='allow' AND status='active'"
            ).bind("ed_gutenberg_"+cmd.sourceId,cmd.territory);
            return env.PRIMARY_DB.batch([evidence,grant]);
          }
        );
        return Response.json({evidenceRevoked:true,sourceId:cmd.sourceId,evidenceId:cmd.evidenceId,territory:cmd.territory},
          {status:200,headers});
      }
      // The only legal mutation allowed by this service. The DO commits the
      // revocation before ANY SQL may execute. No generic SQL or delegated
      // batch endpoint exists; the legacy caller has no raw QA writer binding.
      await denyWithOwnedSourceEpoch(
        env.LEGAL_PRIVATE,env.COVE_RIGHTS_OWNER_SECRET!,{
          sourceId:cmd.sourceId as string,territory:"*",
          operationId:cmd.operationId as string
        },async()=>
          env.PRIMARY_DB.prepare(
            "UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='quarantined' WHERE id=?"
          ).bind(cmd.sourceId).run()
      );
      return Response.json({quarantined:true,sourceId:cmd.sourceId},{status:200,headers});
    }catch{
      // Unknown owner / unavailable D1 / stale denied op always fail closed.
      return new Response(null,{status:503,headers});
    }
  }
};
