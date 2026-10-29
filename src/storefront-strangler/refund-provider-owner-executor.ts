/* eslint-disable prettier/prettier -- Strict QA-only owner refund provider command; source is an authenticated Stripe response, never SQL. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
import type {AuthoritySql} from "./commercial-entitlement-core";
import {readPaidOrderPermission} from "./commercial-entitlement-core";

const ownerId=/^[a-zA-Z0-9_-]{8,160}$/;
const providerId=/^re_[a-zA-Z0-9_]{5,140}$/;
const statuses=new Set(["pending","requires_action","succeeded","failed","canceled"]);
type RefundRow={id:string;order_id:string;provider_refund_id:string|null;status:string;succeeded_at:string|null};
type ProviderCommand={orderId:string;refundId:string;providerRefundId:string;status:string};
function validate(raw:unknown):ProviderCommand{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_owner_refund_provider_command");
  const x=raw as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="orderId,providerRefundId,refundId,status"||
     typeof x.orderId!=="string"||!ownerId.test(x.orderId)||
     typeof x.refundId!=="string"||!ownerId.test(x.refundId)||
     typeof x.providerRefundId!=="string"||!providerId.test(x.providerRefundId)||
     typeof x.status!=="string"||!statuses.has(x.status))
    throw Error("invalid_owner_refund_provider_command");
  return x as ProviderCommand;
}
/**
 * Persist an already-verified Stripe refund observation only through the
 * protected legal owner. The owner cannot accept an attacker-selected SQL
 * statement, refund/order mismatch, changed Stripe refund ID or a missing
 * durable whole-order veto. A succeeded canonical posting never regresses.
 *
 * The authenticated Stripe API/webhook caller supplies the status; this
 * command does not independently contact Stripe, and is not an autonomous
 * production settlement certificate. QA lease + service secret apply above.
 */
export async function executeOwnerRefundProvider(
  db:CatalogDB,sql:AuthoritySql,raw:unknown,at=new Date().toISOString()
){
  const x=validate(raw);
  const permission=readPaidOrderPermission(sql,{orderId:x.orderId});
  if(permission.allowed!==false)
    throw Error("owner_refund_denial_required");
  const initial=await db.prepare(
    "SELECT id,order_id,provider_refund_id,status,succeeded_at FROM commerce_refunds WHERE id=?"
  ).bind(x.refundId).first<RefundRow>();
  if(!initial||initial.id!==x.refundId||initial.order_id!==x.orderId)
    throw Error("owner_refund_provider_scope_mismatch");
  if(initial.provider_refund_id&&initial.provider_refund_id!==x.providerRefundId)
    throw Error("owner_refund_provider_collision");
  if(!initial.succeeded_at&&initial.status!=="succeeded"){
    const result=await db.prepare(
      "UPDATE commerce_refunds SET provider_refund_id=?,status=?,updated_at=? WHERE id=? AND order_id=? AND succeeded_at IS NULL AND status!='succeeded' AND (provider_refund_id IS NULL OR provider_refund_id=?)"
    ).bind(x.providerRefundId,x.status,at,x.refundId,x.orderId,x.providerRefundId).run();
    // A zero-change result is permitted only if another attempt already
    // committed exactly this provider identity, or completed the refund.
    if(!result?.success)throw Error("owner_refund_provider_write_failed");
  }
  const final=await db.prepare(
    "SELECT id,order_id,provider_refund_id,status,succeeded_at FROM commerce_refunds WHERE id=?"
  ).bind(x.refundId).first<RefundRow>();
  if(!final||final.id!==x.refundId||final.order_id!==x.orderId||
     final.provider_refund_id!==x.providerRefundId||
     (final.succeeded_at&&final.status!=="succeeded")||
     (!final.succeeded_at&&final.status!==x.status&&final.status!=="succeeded"))
    throw Error("owner_refund_provider_receipt_mismatch");
  return {schema:"cove.owner-refund-provider.v1",ownerDenied:true,
    recorded:true,orderId:x.orderId,refundId:x.refundId,
    providerRefundId:x.providerRefundId,status:final.status};
}
