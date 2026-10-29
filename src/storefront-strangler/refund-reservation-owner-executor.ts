/* eslint-disable prettier/prettier -- Private owner-executed refund reservation, not a callable legacy D1 writer. */
import type {CatalogDB} from "../features/fore/catalog-model.server";

type RefundRow={
  id:string;order_id:string;idempotency_key:string;reason:string;status:string;
  amount_minor:number;stripe_amount_minor:number;gift_card_amount_minor:number;
  store_credit_amount_minor:number;succeeded_at:string|null;
};
type OrderRow={
  id:string;status:string;currency:string;total_minor:number;stripe_due_minor:number;
  store_credit_minor:number;gift_card_minor:number;stripe_payment_intent_id:string|null;
};
type ReserveInput={orderId:string;idempotencyKey:string;amountMinor?:number;reason:string};
const validId=/^[a-zA-Z0-9_-]{8,160}$/;
const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=1_000_000_000_000;
function validate(raw:unknown):ReserveInput {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("invalid_owner_refund_reservation_command");
  const x=raw as Record<string,unknown>;
  const keys=Object.keys(x).sort().join(",");
  if(keys!=="idempotencyKey,orderId,reason"&&keys!=="amountMinor,idempotencyKey,orderId,reason")
    throw Error("invalid_owner_refund_reservation_command");
  if(typeof x.orderId!=="string"||!validId.test(x.orderId)||
     typeof x.idempotencyKey!=="string"||x.idempotencyKey.length<16||x.idempotencyKey.length>200||
     typeof x.reason!=="string"||x.reason.length>500||
     (x.amountMinor!==undefined&&(!integer(x.amountMinor)||Number(x.amountMinor)===0)))
    throw Error("invalid_owner_refund_reservation_command");
  return x as ReserveInput;
}
function receipt(input:ReserveInput,record:RefundRow,created:boolean) {
  if(record.order_id!==input.orderId||record.idempotency_key!==input.idempotencyKey||
     record.reason!==input.reason||
     input.amountMinor!==undefined&&Number(record.amount_minor)!==input.amountMinor)
    throw Error("owner_refund_idempotency_collision");
  if(!validId.test(record.id)||![record.amount_minor,record.stripe_amount_minor,
      record.gift_card_amount_minor,record.store_credit_amount_minor].every(integer)||
     Number(record.amount_minor)<=0||
     Number(record.stripe_amount_minor)+Number(record.gift_card_amount_minor)+
       Number(record.store_credit_amount_minor)!==Number(record.amount_minor))
    throw Error("owner_refund_invalid_canonical_receipt");
  return {schema:"cove.owner-refund-reservation.v1",
    orderId:input.orderId,refundId:record.id,amountMinor:Number(record.amount_minor),
    stripeAmountMinor:Number(record.stripe_amount_minor),
    giftCardAmountMinor:Number(record.gift_card_amount_minor),
    storeCreditAmountMinor:Number(record.store_credit_amount_minor),created};
}
/** The owner alone derives amounts from the canonical order and reserves the
 * complete refund under a transaction-current SQL balance predicate.
 * It never trusts caller-supplied tender splits or a stale checkout read.
 * A lost ACK is safe to replay with the same idempotency key; a new key
 * cannot spend funds held by a pending request. */
export async function executeOwnerRefundReservation(db:CatalogDB,raw:unknown) {
  const input=validate(raw);
  const existing=await db.prepare("SELECT * FROM commerce_refunds WHERE idempotency_key=?")
    .bind(input.idempotencyKey).first<RefundRow>();
  if(existing)return receipt(input,existing,false);
  const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(input.orderId).first<OrderRow>();
  if(!order||!["paid","partially_refunded","disputed"].includes(order.status))
    throw Error("owner_refund_order_not_refundable");
  if(![order.total_minor,order.stripe_due_minor,order.store_credit_minor,
       order.gift_card_minor].every(integer)||Number(order.total_minor)<=0)
    throw Error("owner_refund_tender_invalid");
  const reserved=await db.prepare(
    "SELECT COALESCE(SUM(amount_minor),0) amount,COALESCE(SUM(stripe_amount_minor),0) stripe,COALESCE(SUM(gift_card_amount_minor),0) gift,COALESCE(SUM(store_credit_amount_minor),0) store FROM commerce_refunds WHERE order_id=? AND status IN ('pending','succeeded')"
  ).bind(order.id).first<{amount:number;stripe:number;gift:number;store:number}>();
  const prior=[reserved?.amount||0,reserved?.stripe||0,reserved?.gift||0,reserved?.store||0].map(Number);
  if(!prior.every(integer))throw Error("owner_refund_reservations_invalid");
  const remaining=Number(order.total_minor)-prior[0];
  if(remaining<=0)throw Error("owner_refund_balance_exhausted");
  const amount=input.amountMinor??remaining;
  // This QA owner uses a whole-order deny. Partial refunds must wait for
  // item-scoped owner withdrawal; do not acknowledge an ambiguous denial.
  if(amount!==remaining)throw Error("owner_refund_partial_scope_unsupported");
  if(amount>remaining||!integer(amount)||amount<=0)
    throw Error("owner_refund_amount_invalid");
  let rest=amount;
  const stripe=Math.min(rest,Math.max(0,Number(order.stripe_due_minor)-prior[1]));
  rest-=stripe;
  const store=Math.min(rest,Math.max(0,Number(order.store_credit_minor)-prior[3]));
  rest-=store;
  const gift=Math.min(rest,Math.max(0,Number(order.gift_card_minor)-prior[2]));
  rest-=gift;
  if(rest!==0||(stripe>0&&!order.stripe_payment_intent_id))
    throw Error("owner_refund_tender_unavailable");
  const refundId="ref_"+crypto.randomUUID(),at=new Date().toISOString();
  try{
    const result=await db.prepare(
      "INSERT INTO commerce_refunds(id,order_id,amount_minor,stripe_amount_minor,gift_card_amount_minor,store_credit_amount_minor,currency,reason,status,idempotency_key,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'pending',?,?,? FROM commerce_orders o WHERE o.id=? AND o.status IN ('paid','partially_refunded','disputed') AND ?<=o.total_minor-COALESCE((SELECT SUM(amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.stripe_due_minor-COALESCE((SELECT SUM(stripe_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.gift_card_minor-COALESCE((SELECT SUM(gift_card_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.store_credit_minor-COALESCE((SELECT SUM(store_credit_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0)"
    ).bind(refundId,order.id,amount,stripe,gift,store,order.currency,input.reason,
      input.idempotencyKey,at,at,order.id,amount,stripe,gift,store).run() as {meta?:{changes?:number}};
    if(result.meta?.changes!==1)throw Error("owner_refund_concurrent_reservation_conflict");
  }catch(error){
    // A losing concurrent request can succeed only when the immutable key
    // already has the exact same scope. Otherwise propagate the conflict.
    const winner=await db.prepare("SELECT * FROM commerce_refunds WHERE idempotency_key=?")
      .bind(input.idempotencyKey).first<RefundRow>();
    if(winner)return receipt(input,winner,false);
    throw error;
  }
  return receipt(input,{id:refundId,order_id:order.id,idempotency_key:input.idempotencyKey,
    reason:input.reason,status:"pending",amount_minor:amount,stripe_amount_minor:stripe,
    gift_card_amount_minor:gift,store_credit_amount_minor:store,succeeded_at:null},true);
}
