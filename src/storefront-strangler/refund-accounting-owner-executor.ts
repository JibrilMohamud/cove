/* eslint-disable prettier/prettier -- Private owner-first accounting command; never accepts caller SQL. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
import {postRefundAccounting} from "../features/fore/refund-accounting.server";
import {readPaidOrderPermission} from "./commercial-entitlement-core";
import type {AuthoritySql} from "./legal-authority-core";

const id=/^[a-zA-Z0-9_-]{8,160}$/;
type RefundState={id:string;order_id:string;status:string;succeeded_at:string|null;
  provider_refund_id:string|null;stripe_amount_minor:number};
type CompletedRefund={id:string;order_id:string;succeeded_at:string|null};

/** Called ONLY by the independently leased private legal owner. No positive
 * access can be created: the durable whole-order veto must already exist.
 * The primary D1 batch includes the financial ledger and completion marker.
 * A crash after veto but before the batch stays denied and retries by refundId.
 * The owner verifies persisted provider state, not a caller's 'success' flag.
 */
export async function executeOwnerRefundAccounting(
  db:CatalogDB,ownerSql:AuthoritySql,raw:unknown,at=new Date().toISOString()
) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_owner_refund_command");
  const x=raw as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="orderId,refundId"||
    typeof x.orderId!=="string"||!id.test(x.orderId)||
    typeof x.refundId!=="string"||!id.test(x.refundId)||
    !Number.isFinite(Date.parse(at)))
    throw Error("invalid_owner_refund_command");
  const refund=await db.prepare(
    "SELECT id,order_id,status,succeeded_at,provider_refund_id,stripe_amount_minor FROM commerce_refunds WHERE id=?"
  ).bind(x.refundId).first<RefundState>();
  if(!refund||refund.id!==x.refundId||refund.order_id!==x.orderId||
    !Number.isSafeInteger(Number(refund.stripe_amount_minor))||
    Number(refund.stripe_amount_minor)<0)
    throw Error("owner_refund_scope_mismatch");
  // Stripe must have acknowledged success in canonical persisted evidence.
  // Internal zero-Stripe tender reversal has no provider refund object.
  if(Number(refund.stripe_amount_minor)>0&&
    (refund.status!=="succeeded"||
     !refund.provider_refund_id||!/^re_[a-zA-Z0-9_-]{4,200}$/.test(refund.provider_refund_id)))
    throw Error("owner_refund_provider_not_confirmed");
  if(readPaidOrderPermission(ownerSql,{orderId:x.orderId}).allowed!==false)
    throw Error("owner_refund_denial_required");
  const result=await postRefundAccounting(db,x.refundId,at,true);
  const confirmed=await db.prepare(
    "SELECT id,order_id,succeeded_at FROM commerce_refunds WHERE id=?"
  ).bind(x.refundId).first<CompletedRefund>();
  if(!confirmed||confirmed.id!==x.refundId||confirmed.order_id!==x.orderId||
    !confirmed.succeeded_at)
    throw Error("owner_refund_canonical_posting_unverified");
  return {schema:"cove.owner-refund-accounting.v1",ownerDenied:true,posted:true,
    refundId:x.refundId,orderId:x.orderId,applied:result.applied};
}
