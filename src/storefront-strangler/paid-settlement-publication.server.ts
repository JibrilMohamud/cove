/* eslint-disable prettier/prettier -- Private payment-to-owner handoff is a security-sensitive boundary. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

// These exact synthetic QA databases are segregated from both production and
// the 100-RPS capacity fixture. The second has canonical paid-order schema.
// No production D1 identifier can enable the staging customer authorization.
const QA_PRIMARY_IDS=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
const identity=/^[a-zA-Z0-9_-]{8,160}$/;
type PaidLine={
  id:string;product_id:string;sales_channel:string;entitlement_status:string;
  preorder_id:string|null;entitlement_id:string|null;
};
type PaidOrder={id:string;user_id:string;territory_code:string;status:string};

/**
 * Reconcile a Stripe-verified, CANONICALLY PAID order to the independent
 * buyer/rights owner. Positives are unavailable until the private owner
 * verifies the exact paid entitlement, immutable order acquisition scope,
 * current legal grant/contract, and absence of a buyer risk hold in D1.
 *
 * The owner is authoritative for protected access. Returning a paid order
 * from D1 alone never constitutes permission to distribute its bytes.
 *
 * Staging ONLY: no customer-routing enablement, no public owner endpoint,
 * and no fallback to a previously minted entitlement when owner is down.
 * Reprocessing an already-paid signed webhook is an intentional recovery
 * mechanism for failures after the canonical order becomes paid.
 */
/**
 * Before a signed payment's canonical settlement side effects, consult the
 * durable refunded-order tombstone. This is not a positive rights grant:
 * publication still requires all canonical and owner checks AFTER payment.
 * An owner outage fails closed before tender or financial mutations.
 */
export async function assertStagePaidOrderNotWithdrawn(env:CoveEnv,orderId:string):Promise<void>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName||!identity.test(orderId))
    throw new ApiError(503,"Paid settlement owner is not certified.");
  let payload:unknown;
  try{
    const reply=await env.LEGAL_AUTHORITY
      .getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/commercial/order/verify",{
        method:"POST",
        headers:{"content-type":"application/json",
          "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
        body:JSON.stringify({orderId})
      }));
    if(reply.status!==200)throw Error("owner_unavailable");
    payload=await reply.json();
  }catch{
    throw new ApiError(503,"Paid-order owner unavailable before settlement.");
  }
  const result=payload as {schema?:unknown;orderId?:unknown;allowed?:unknown}|null;
  if(!result||result.schema!=="cove.paid-order-permission.v1"||result.orderId!==orderId||
     typeof result.allowed!=="boolean")
    throw new ApiError(503,"Paid-order owner receipt malformed.");
  if(!result.allowed)
    throw new ApiError(409,"This order has already been revoked.");

  // No tender may be consumed against a stale cart-rights decision. Query
  // only the immutable purchase scope recorded on the actual order and join
  // it to the current strongly consistent legal owner. R2/KV presentation
  // is never a substitute for this verification.
  const order=await env.DB.prepare(
    "SELECT id,user_id,territory_code,status FROM commerce_orders WHERE id=?"
  ).bind(orderId).first<PaidOrder>();
  if(!order||!identity.test(order.user_id)||
     !/^[A-Z]{2}$/.test(order.territory_code)||
     !["pending_payment","processing","authorized","payment_failed"].includes(order.status))
    throw new ApiError(409,"Canonical paid-order settlement scope invalid.");
  const lines=(await env.DB.prepare(
    "SELECT product_id,rights_grant_id,rights_snapshot_json,sales_channel,preorder_id FROM commerce_order_items WHERE order_id=? ORDER BY id LIMIT 26"
  ).bind(orderId).all<{
    product_id:string;rights_grant_id:string|null;
    rights_snapshot_json:string|null;sales_channel:string;preorder_id:string|null
  }>()).results;
  if(!lines.length||lines.length>25||
     new Set(lines.map(x=>x.product_id)).size!==lines.length)
    throw new ApiError(409,"Unbounded or duplicate paid-order lines.");
  const liveLines=lines.filter(x=>!x.preorder_id);
  if(!liveLines.length)return;
  if(liveLines.some(x=>!identity.test(x.product_id)||
      x.product_id.startsWith("prd_gutenberg_")||x.sales_channel!=="retail"))
    throw new ApiError(409,"Paid-order sales channel or product invalid.");
  let rights:unknown;
  try{
    const reply=await env.LEGAL_AUTHORITY!.getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/commercial/authorize-batch",{
        method:"POST",
        headers:{"content-type":"application/json",
          "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
        body:JSON.stringify({ids:liveLines.map(x=>x.product_id),
          territory:order.territory_code,channel:"retail"})
      }));
    if(reply.status!==200)throw Error("owner_unavailable");
    rights=await reply.json();
  }catch{
    throw new ApiError(503,"Commercial grant owner unavailable before settlement.");
  }
  const proof=rights as {schema?:unknown;rows?:unknown}|null;
  if(!proof||proof.schema!=="cove.commercial-legal.v1"||
     !Array.isArray(proof.rows)||proof.rows.length!==liveLines.length)
    throw new ApiError(451,"Paid-order rights are no longer fully authorized.");
  for(let i=0;i<liveLines.length;i++){
    const line=liveLines[i];
    const row=proof.rows[i] as Record<string,unknown>|null;
    let acquired:Record<string,unknown>|null=null;
    try{
      const snapshot=JSON.parse(line.rights_snapshot_json||"null");
      if(snapshot&&typeof snapshot==="object"&&!Array.isArray(snapshot))
        acquired=snapshot;
    }catch{acquired=null;}
    if(!row||!acquired||row.product_id!==line.product_id||
       row.grant_id!==line.rights_grant_id||
       acquired.grantId!==row.grant_id||
       acquired.editionId!==row.edition_id||
       acquired.contractId!==row.contract_id||
       acquired.contractVersionId!==row.contract_version_id||
       acquired.territory!==order.territory_code||
       acquired.salesChannel!=="retail"||
       typeof row.contract_id!=="string"||
       typeof row.contract_version_id!=="string"||
       !Number.isSafeInteger(row.epoch)||Number(row.epoch)<=0||
       typeof row.valid_until!=="string"||
       !Number.isFinite(Date.parse(row.valid_until))||
       Date.parse(row.valid_until)<=Date.now())
      throw new ApiError(451,"Purchase contract or grant has changed since checkout.");
  }
}

export async function certifyStagePaidSettlement(
  env:CoveEnv,orderId:string,userId:string
):Promise<void>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName||
     !identity.test(orderId)||!identity.test(userId))
    throw new ApiError(503,"Paid settlement owner is not certified.");
  const order=await env.DB.prepare(
    "SELECT id,user_id,territory_code,status FROM commerce_orders WHERE id=? AND user_id=?"
  ).bind(orderId,userId).first<PaidOrder>();
  if(!order||order.status!=="paid"||order.user_id!==userId||
     !/^[A-Z]{2}$/.test(order.territory_code))
    throw new ApiError(409,"Paid settlement evidence is not valid.");

  const lines=(await env.DB.prepare(
    `SELECT oi.id,oi.product_id,oi.sales_channel,oi.entitlement_status,oi.preorder_id,
            e.id entitlement_id
       FROM commerce_order_items oi
       LEFT JOIN entitlements e ON e.order_item_id=oi.id
         AND e.user_id=? AND e.product_id=oi.product_id
         AND e.entitlement_type='purchase' AND e.source='commerce'
         AND e.status='active'
       WHERE oi.order_id=? ORDER BY oi.id LIMIT 26`
  ).bind(userId,orderId).all<PaidLine>()).results;
  if(!lines.length||lines.length>25||
     new Set(lines.map(line=>line.id)).size!==lines.length)
    throw new ApiError(503,"Paid settlement line inventory is not certifiable.");
  const owner=env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
  const delivered=lines.filter(line=>!line.preorder_id);
  // Multiple line grants must become readable as ONE strongly consistent
  // owner state transition. A per-item loop can expose a partly fulfilled
  // paid cart if the owner fails or a contract is withdrawn between items.
  // A single-line order keeps the existing verified handler for compatibility.
  if(delivered.length>1){
    if(delivered.some(line=>line.entitlement_status!=="granted"||
       line.sales_channel!=="retail"||
       !identity.test(line.product_id)||
       !identity.test(line.entitlement_id||"")))
      throw new ApiError(409,"Paid entitlement inventory is incomplete.");
    let result:unknown;
    try {
      result=await dispatchCanonicalOwnerCommand(owner,env.COVE_RIGHTS_OWNER_SECRET!,
        "commerce.publish-order",{orderId,userId,territory:order.territory_code,channel:"retail"});
    }catch{
      throw new ApiError(503,"Atomic paid owner settlement unavailable.");
    }
    const receipt=result as {
      applied?:unknown;orderId?:unknown;
      receipts?:Array<{entitlementId?:unknown;epoch?:unknown}>
    }|null;
    if(!receipt||receipt.applied!==true||receipt.orderId!==orderId||
       !Array.isArray(receipt.receipts)||
       receipt.receipts.length!==delivered.length||
       new Set(receipt.receipts.map(x=>x.entitlementId)).size!==delivered.length||
       receipt.receipts.some(x=>
         !delivered.some(y=>y.entitlement_id===x.entitlementId)||
         !Number.isSafeInteger(x.epoch)||Number(x.epoch)<=0))
      throw new ApiError(503,"Atomic paid settlement proof is invalid.");
    return;
  }
  for(const line of lines){
    // Preorders are only a financial reservation; there is no downloadable
    // purchase until the separate delivery/rights conversion is certified.
    if(line.preorder_id)continue;
    if(line.entitlement_status!=="granted"||
       line.sales_channel!=="retail"||
       !identity.test(line.product_id)||!identity.test(line.entitlement_id||""))
      throw new ApiError(409,"Paid entitlement is not ready for authorization.");
    let receipt:unknown;
    try{
      receipt=await dispatchCanonicalOwnerCommand(owner,env.COVE_RIGHTS_OWNER_SECRET!,
        "commerce.publish-entitlement",{
          entitlementId:line.entitlement_id!,userId,productId:line.product_id,
          territory:order.territory_code,channel:"retail"
        });
    }catch{
      throw new ApiError(503,"Paid owner settlement receipt unavailable.");
    }
    const confirmed=receipt as {applied?:unknown;epoch?:unknown}|null;
    if(!confirmed||confirmed.applied!==true||
       !Number.isSafeInteger(confirmed.epoch)||Number(confirmed.epoch)<=0)
      throw new ApiError(503,"Paid owner settlement receipt unverified.");
  }
}
