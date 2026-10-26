/* eslint-disable prettier/prettier -- Private payment-to-owner handoff is a security-sensitive boundary. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";

const STAGE_PRIMARY="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
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
export async function certifyStagePaidSettlement(
  env:CoveEnv,orderId:string,userId:string
):Promise<void>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     env.COVE_LEGAL_WRITER_PRIMARY_ID!==STAGE_PRIMARY||
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
      const response=await owner.fetch(new Request(
        "https://legal-authority.internal/commercial/entitlement/publish-verified",{
          method:"POST",
          headers:{"content-type":"application/json",
            "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
          body:JSON.stringify({
            entitlementId:line.entitlement_id,
            userId,productId:line.product_id,
            territory:order.territory_code,channel:"retail"
          })
        }
      ));
      if(response.status!==200)throw Error("owner_refused_entitlement");
      receipt=await response.json();
    }catch{
      throw new ApiError(503,"Paid owner settlement receipt unavailable.");
    }
    const confirmed=receipt as {applied?:unknown;epoch?:unknown}|null;
    if(!confirmed||confirmed.applied!==true||
       !Number.isSafeInteger(confirmed.epoch)||Number(confirmed.epoch)<=0)
      throw new ApiError(503,"Paid owner settlement receipt unverified.");
  }
}
