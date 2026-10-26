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
const QA_PRIMARY="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
const sourceIdRegex=/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
const opIdRegex=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function qaWriterConfigured(env:QaWriterEnv){
  const exp=Number(env.COVE_LEGAL_WRITER_EXPIRES_AT),at=Date.now();
  return env.COVE_LEGAL_WRITER_ENABLED==="1" &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID===QA_PRIMARY &&
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
    const isRetractionBatch=pathname==="/source/retract-batch";
    const isCommercial=pathname==="/commercial/suspend-grant" ||
      pathname==="/commercial/suspend-contract";
    const isEntitlement=pathname==="/commercial/entitlement/revoke";
    const isRefundBatch=pathname==="/commercial/entitlement/revoke-order";
    if(request.method!=="POST" ||
       (pathname!=="/quarantine" && !isEvidence && !isRetractionBatch && !isCommercial && !isEntitlement && !isRefundBatch) ||
       request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json" ||
       request.headers.has("cookie"))
      return new Response(null,{status:405,headers});
    let cmd:{sourceId?:unknown;operationId?:unknown;message?:unknown;
      evidenceId?:unknown;territory?:unknown;operations?:unknown;
      targetId?:unknown;entitlementId?:unknown;orderId?:unknown};
    try{
      const text=await request.text();
      if(text.length>(isRetractionBatch?5000:900))
        return new Response(null,{status:413,headers});
      cmd=JSON.parse(text);
    }catch{return new Response(null,{status:400,headers});}
    if(!cmd || isRefundBatch && (
      typeof cmd.orderId!=="string" ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(cmd.orderId) ||
      typeof cmd.operationId!=="string" ||
      !opIdRegex.test(cmd.operationId)
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
    ) || !isRetractionBatch && !isCommercial && !isEntitlement && !isRefundBatch && (
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
      if(isRefundBatch){
        const orderId=cmd.orderId as string;
        // The writer, not Stripe nor a caller-supplied product list, derives
        // the exact buyer and entitlements of the settled order.
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id FROM commerce_orders WHERE id=?"
        ).bind(orderId).first<{id:string;user_id:string}>();
        if(!order)throw Error("refund_order_not_found");
        const matching=await env.PRIMARY_DB.prepare(
          "SELECT e.id,e.user_id,e.product_id,e.status FROM entitlements e WHERE e.user_id=? AND e.order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND e.entitlement_type='purchase' ORDER BY e.id LIMIT 26"
        ).bind(order.user_id,orderId).all<{
          id:string;user_id:string;product_id:string;status:string
        }>();
        if(matching.results.length>25 ||
           matching.results.some(e=>!["active","revoked"].includes(e.status)||
             !/^[a-zA-Z0-9_-]{8,160}$/.test(e.id)||
             !/^[a-zA-Z0-9_-]{8,160}$/.test(e.user_id)||
             !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(e.product_id)||
             e.product_id.startsWith("prd_gutenberg_")))
          throw Error("refund_unsupported_entitlements");
        if(!matching.results.length)
          return Response.json({revoked:0},{status:200,headers});
        const ops=matching.results.map((e,i)=>({
          entitlementId:e.id,userId:e.user_id,productId:e.product_id,
          operationId:"refund:"+cmd.operationId+":"+i
        }));
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/entitlement/deny-batch",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify({operations:ops})
          }
        ));
        if(owner.status!==200)throw Error("refund_owner_unavailable");
        const proof=await owner.json() as {
          applied?:boolean;receipts?:Array<{
            entitlementId?:string;applied?:boolean;epoch?:number
          }>
        };
        if(proof.applied!==true||!Array.isArray(proof.receipts)||
           proof.receipts.length!==ops.length||
           proof.receipts.some((r,i)=>r.entitlementId!==ops[i].entitlementId||
             !r.applied||!Number.isSafeInteger(r.epoch)||Number(r.epoch)<=0))
          throw Error("refund_owner_receipt_invalid");
        await env.PRIMARY_DB.batch(matching.results.map(e=>env.PRIMARY_DB.prepare(
          "UPDATE entitlements SET status='revoked' WHERE id=? AND user_id=? AND product_id=? AND status='active'"
        ).bind(e.id,e.user_id,e.product_id)));
        return Response.json({revoked:matching.results.length},
          {status:200,headers});
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
        // The operator requests a narrow suspension. Discover ALL products
        // impacted by the grant/contract, not a caller-supplied subset.
        // A 26th product makes the operation fail closed; no partial fencing.
        const subject=isCommercial && pathname.endsWith("suspend-grant")
          ?"grant":"contract";
        const target=cmd.targetId as string;
        const query=subject==="grant"
          ?"SELECT DISTINCT p.id FROM rights_grants rg JOIN products p ON p.edition_id=rg.edition_id WHERE rg.id=? ORDER BY p.id LIMIT 26"
          :"SELECT DISTINCT p.id FROM rights_grants rg JOIN products p ON p.edition_id=rg.edition_id WHERE rg.contract_id=? ORDER BY p.id LIMIT 26";
        const matching=await env.PRIMARY_DB.prepare(query).bind(target)
          .all<{id:string}>();
        if(!matching.results.length||matching.results.length>25 ||
           matching.results.some(r=>!/^prd_[a-zA-Z0-9_-]{3,120}$/.test(r.id)||
              r.id.startsWith("prd_gutenberg_")))
          throw Error("unsupported_commercial_scope");
        const operations=matching.results.map((r,i)=>({
          productId:r.id,operationId:"commercial:"+cmd.operationId+":"+i
        }));
        const owner=await env.LEGAL_PRIVATE.fetch(new Request(
          "https://legal-authority.internal/commercial/deny-batch",{
            method:"POST",
            headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},
            body:JSON.stringify({operations})
          }
        ));
        if(owner.status!==200)throw Error("commercial_owner_unavailable");
        const receipt=await owner.json() as {
          applied?:boolean;
          receipts?:Array<{productId?:string;operationId?:string;applied?:boolean;epoch?:number}>;
        };
        if(receipt.applied!==true || !Array.isArray(receipt.receipts) ||
           receipt.receipts.length!==operations.length ||
           receipt.receipts.some((r,i)=>!r.applied||
             !Number.isSafeInteger(r.epoch)||Number(r.epoch)<=0||
             r.productId!==operations[i].productId||
             r.operationId!==operations[i].operationId))
          throw Error("commercial_owner_receipt_unconfirmed");
        const statements=subject==="grant"?[
          env.PRIMARY_DB.prepare(
            "UPDATE rights_grants SET status='suspended' WHERE id=? AND status='active'"
          ).bind(target)
        ]:[
          env.PRIMARY_DB.prepare(
            "UPDATE rights_contracts SET status='suspended' WHERE id=? AND status='active'"
          ).bind(target),
          env.PRIMARY_DB.prepare(
            "UPDATE rights_grants SET status='suspended' WHERE contract_id=? AND status='active'"
          ).bind(target)
        ];
        await env.PRIMARY_DB.batch(statements);
        return Response.json({suspended:true,subject,products:operations.length},
          {status:200,headers});
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
        return Response.json({retracted:operations.length},
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
        return Response.json({evidenceRevoked:true,territory:cmd.territory},
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
      return Response.json({quarantined:true},{status:200,headers});
    }catch{
      // Unknown owner / unavailable D1 / stale denied op always fail closed.
      return new Response(null,{status:503,headers});
    }
  }
};
