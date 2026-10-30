/* eslint-disable prettier/prettier -- One D1 transaction owns the refund's financial and fulfillment effects. */
import {ApiError} from "./service";
import type {CatalogDB} from "./catalog-model.server";

/** Every posting is conditional on the SAME unsucceeded refund marker.
 * D1 batch is atomic: a crash cannot expose restored tender or a completion
 * marker without its balanced ledger and exact order totals. Marker LAST;
 * replay after an unknown commit outcome is a no-op, including concurrent
 * requests whose preflight reads observed the old pending row. */
type RefundRecord={id:string;order_id:string;amount_minor:number;gift_card_amount_minor:number;
  store_credit_amount_minor:number;stripe_amount_minor:number;currency:string;succeeded_at:string|null};
type OrderRecord={id:string;user_id:string;currency:string;total_minor:number;refunded_minor:number;
  tax_minor:number;tax_inclusive_minor:number;status:string};
export async function postRefundAccounting(
  db:CatalogDB,refundId:string,at:string,ownerEnrolled:boolean
) {
  const refund=await db.prepare("SELECT * FROM commerce_refunds WHERE id=?")
    .bind(refundId).first<RefundRecord>();
  if(!refund)throw new ApiError(404,"Refund intent not found.");
  const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(refund.order_id).first<OrderRecord>();
  if(!order)throw new ApiError(404,"Refund order not found.");
  if(refund.succeeded_at)return {refund,order,applied:false};
  const amount=Number(refund.amount_minor),gift=Number(refund.gift_card_amount_minor||0),
    store=Number(refund.store_credit_amount_minor||0),stripe=Number(refund.stripe_amount_minor||0);
  const total=Number(order.total_minor),previous=Number(order.refunded_minor||0),
    totalTax=Number(order.tax_minor||0)+Number(order.tax_inclusive_minor||0);
  if(!Number.isSafeInteger(total)||total<=0||!Number.isSafeInteger(previous)||previous<0||
     previous+amount>total||!Number.isSafeInteger(totalTax)||totalTax<0||totalTax>total||
     !Number.isSafeInteger(amount)||amount<=0||
     [gift,store,stripe].some(n=>!Number.isSafeInteger(n)||n<0)||
     gift+store+stripe!==amount||refund.currency!==order.currency)
    throw new ApiError(409,"Refund tender accounting is invalid.");
  const statements:Parameters<CatalogDB["batch"]>[0]=[];
  const pending="EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.id=? AND r.succeeded_at IS NULL)";
  const full="EXISTS(SELECT 1 FROM commerce_orders o WHERE o.id=? AND o.refunded_minor>=o.total_minor)";
  if(gift){
    const reservation=await db.prepare("SELECT source_key FROM commerce_balance_reservations WHERE order_id=? AND source_type='gift_card' AND status='consumed' LIMIT 1")
      .bind(order.id).first<{source_key:string}>();
    if(!reservation?.source_key||!await db.prepare("SELECT 1 ok FROM commerce_gift_cards WHERE code_hash=?")
      .bind(reservation.source_key).first())
      throw new ApiError(500,"The original gift-card tender could not be restored.");
    statements.push(db.prepare("UPDATE commerce_gift_cards SET balance_minor=balance_minor+?,status=CASE WHEN status='exhausted' AND (expires_at IS NULL OR expires_at>?) THEN 'active' ELSE status END,updated_at=? WHERE code_hash=? AND "+pending)
      .bind(gift,at,at,reservation.source_key,refundId));
    statements.push(db.prepare("INSERT INTO commerce_gift_card_ledger(id,code_hash,order_id,entry_type,amount_minor,balance_after_minor,created_at) SELECT ?,code_hash,?,'refund',?,balance_minor,? FROM commerce_gift_cards WHERE code_hash=? AND "+pending)
      .bind("gift_refund:"+refundId,order.id,gift,at,reservation.source_key,refundId));
  }
  if(store)statements.push(db.prepare("INSERT INTO commerce_store_credit_ledger(id,user_id,order_id,entry_type,amount_minor,currency,reference,created_at) SELECT ?,?,?,'refund',?,?,?,? WHERE "+pending)
    .bind("credit_refund:"+refundId,order.user_id,order.id,store,order.currency,"refund:"+refundId,at,refundId));
  // Derive tax allocation from transaction-current order totals, rather than
  // two callers' stale preflight reads. Successive partial refunds sum to
  // the same final rounded tax as one full refund.
  const tax="MAX(0,ROUND((COALESCE(o.tax_minor,0)+COALESCE(o.tax_inclusive_minor,0))*MIN(o.total_minor,o.refunded_minor+r.amount_minor)*1.0/MAX(1,o.total_minor))-ROUND((COALESCE(o.tax_minor,0)+COALESCE(o.tax_inclusive_minor,0))*o.refunded_minor*1.0/MAX(1,o.total_minor)))";
  for(const [type,account,expression] of [
    ["refund","sales_returns","r.amount_minor-("+tax+")"],
    ["tax_refund","tax_payable",tax],
    ["refund_tender","stripe_receivable","-r.stripe_amount_minor"],
    ["refund_tender","gift_card_liability","-r.gift_card_amount_minor"],
    ["refund_tender","store_credit_liability","-r.store_credit_amount_minor"],
  ])statements.push(db.prepare("INSERT INTO commerce_ledger_entries(id,order_id,refund_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) SELECT ?,o.id,r.id,o.user_id,?,?,"+expression+",o.currency,r.id,?,? FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE r.id=? AND r.succeeded_at IS NULL AND ("+expression+")<>0")
    .bind("led_refund:"+refundId+":"+account,type,account,JSON.stringify({refundId}),at,refundId));
  statements.push(db.prepare("UPDATE commerce_orders SET refunded_minor=refunded_minor+?,status=CASE WHEN status='chargeback_lost' THEN status WHEN refunded_minor+?>=total_minor THEN 'refunded' ELSE 'partially_refunded' END,updated_at=? WHERE id=? AND "+pending)
    .bind(amount,amount,at,order.id,refundId));
  if(!ownerEnrolled)statements.push(db.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase' AND "+pending+" AND "+full)
    .bind(at,order.user_id,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_order_items SET entitlement_status='revoked' WHERE order_id=? AND "+pending+" AND "+full)
    .bind(order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE preorders SET status='refunded',updated_at=? WHERE order_id=? AND status NOT IN ('released','refunded') AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_promo_codes SET redemptions=MAX(0,redemptions-1),updated_at=? WHERE code_hash IN (SELECT code_hash FROM commerce_promo_redemptions WHERE order_id=? AND status='applied') AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_promo_redemptions SET status='refunded',updated_at=? WHERE order_id=? AND status='applied' AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_refunds SET status='succeeded',succeeded_at=?,updated_at=? WHERE id=? AND succeeded_at IS NULL")
    .bind(at,at,refundId));
  const results=await db.batch(statements) as Array<{meta?:{changes?:number}}>;
  const updated=await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(order.id)
    .first<OrderRecord>();
  return {refund,order:updated||order,applied:Number(results.at(-1)?.meta?.changes||0)>0};
}
