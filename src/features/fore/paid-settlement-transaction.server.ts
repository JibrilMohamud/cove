/* eslint-disable prettier/prettier -- Every monetary and fulfillment mutation below commits in one D1 transaction. */
import type {CatalogDB} from "./catalog-model.server";
import {ApiError} from "./service";
import {accrueSaleRoyaltiesForOrder} from "./royalty-engine.server";

export type SettlementPayment={
  provider:string;paymentIntentId:string|null;chargeId:string|null;receiptUrl:string|null;
  paymentMethod?:string;
  processorFee?:{amountMinor:number;currency:string;reference:string;netMinor:number};
};
type AmountField="subtotal_minor"|"promo_discount_minor"|"tax_minor"|"tax_inclusive_minor"|"gift_card_minor"|"store_credit_minor"|"total_minor"|"stripe_due_minor"|"refunded_minor";
export type SettlementOrder=Record<string,unknown>&Record<AmountField,number>&{
  id:string;user_id:string;status:string;currency:string;territory_code:string;invoice_number:string;
  stripe_payment_intent_id:string|null;stripe_customer_id:string|null;
};
export type SettlementAcquiredLine={product_id:string;rights_grant_id:string|null;rights_snapshot_json:string|null;sales_channel:string};
type Line=Record<string,unknown>&SettlementAcquiredLine&{id:string;total_minor:number;entitlement_status:string;preorder_id:string|null};
type Reservation={id:string;user_id:string;currency:string;status:string;amount_minor:number;source_key:string;source_type:string};
type Product={id:string;edition_id:string;work_id:string;release_status:string;release_date:string|null;source_external_id:string|null};
type Lifecycle={id:string;current_publication_version_id:string;owner_update_policy:string};
type PreorderPlan={id:string;status:string;opens_at:string;release_at:string;payment_timing:string};
type Receipt={payment_reference:string;payment_json:string};
const id=/^[a-zA-Z0-9_-]{8,160}$/;
const mutable=["pending_payment","processing","authorized","payment_failed"];
const money=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0&&Number(x)<=1_000_000_000_000;

/** No SQL, prices, buyer identity, entitlements or tender allocation is taken
 * from a browser/command. The caller supplies provider evidence only, after
 * validating its provenance. The owner also performs its legal epoch checks.
 *
 * All reads plan a single batch. Transaction-current assertions make stale
 * preflight reads abort that ENTIRE batch. Receipt insertion has no IGNORE:
 * competing/unknown-outcome executions can never consume tender twice.
 */
export async function postPaidSettlementTransaction(
  db:CatalogDB,orderId:string,payment:SettlementPayment,at=new Date().toISOString()
):Promise<{order:SettlementOrder;applied:boolean;payment:SettlementPayment}> {
  if(!id.test(orderId)||!Number.isFinite(Date.parse(at)))throw new ApiError(400,"Invalid settlement identity.");
  const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<SettlementOrder>();
  if(!order)throw new ApiError(404,"Order not found.");
  const reference=Number(order.stripe_due_minor)>0?payment.paymentIntentId:`internal:${orderId}`;
  if(!reference||
     (Number(order.stripe_due_minor)>0&&(payment.provider!=="stripe"||
       !/^pi_[a-zA-Z0-9_-]{4,200}$/.test(reference)||reference!==order.stripe_payment_intent_id))||
     (Number(order.stripe_due_minor)===0&&(payment.provider!=="internal"||payment.paymentIntentId!==null)))
    throw new ApiError(409,"Settlement provider does not match canonical tender.");
  const old=await db.prepare("SELECT * FROM commerce_settlement_receipts WHERE order_id=?")
    .bind(orderId).first<Receipt>();
  if(old){
    if(old.payment_reference!==reference||order.status!=="paid")
      throw new ApiError(409,"Settlement receipt has been superseded.");
    return {order,applied:false,payment:JSON.parse(old.payment_json)};
  }
  if(!mutable.includes(order.status))throw new ApiError(409,"Terminal or invalid order cannot be settled.");
  const fields=["subtotal_minor","promo_discount_minor","tax_minor","tax_inclusive_minor",
    "gift_card_minor","store_credit_minor","total_minor","stripe_due_minor","refunded_minor"] as const;
  if(!id.test(order.user_id)||!/^[A-Z]{3}$/.test(order.currency)||!/^[A-Z]{2}$/.test(order.territory_code)||
     fields.some(k=>!money(Number(order[k]||0)))||Number(order.refunded_minor)!==0||
     Number(order.promo_discount_minor)>Number(order.subtotal_minor)||
     Number(order.tax_inclusive_minor)>Number(order.subtotal_minor)-Number(order.promo_discount_minor)||
     Number(order.subtotal_minor)-Number(order.promo_discount_minor)+Number(order.tax_minor)!==Number(order.total_minor)||
     Number(order.gift_card_minor)+Number(order.store_credit_minor)+Number(order.stripe_due_minor)!==Number(order.total_minor))
    throw new ApiError(409,"Settlement amounts do not balance.");
  const items=(await db.prepare("SELECT * FROM commerce_order_items WHERE order_id=? ORDER BY id LIMIT 26")
    .bind(orderId).all<Line>()).results;
  if(!items.length||items.length>25||new Set(items.map(i=>i.product_id)).size!==items.length||
     items.some(i=>!id.test(i.id)||!id.test(i.product_id)||!money(Number(i.total_minor))||
       i.entitlement_status!=="pending"||i.preorder_id)||
     items.reduce((n,i)=>n+Number(i.total_minor),0)!==Number(order.total_minor))
    throw new ApiError(409,"Settlement line inventory is invalid or already partially written.");
  const reservations=(await db.prepare("SELECT * FROM commerce_balance_reservations WHERE order_id=? ORDER BY id LIMIT 26")
    .bind(orderId).all<Reservation>()).results;
  if(reservations.length>25||reservations.some(r=>r.user_id!==order.user_id||r.currency!==order.currency||
       r.status!=="reserved"||!money(Number(r.amount_minor))||Number(r.amount_minor)<=0||
       !["gift_card","store_credit"].includes(r.source_type)||
       r.source_type==="store_credit"&&r.source_key!==order.user_id)||
     reservations.filter(r=>r.source_type==="gift_card").reduce((n,r)=>n+Number(r.amount_minor),0)!==Number(order.gift_card_minor)||
     reservations.filter(r=>r.source_type==="store_credit").reduce((n,r)=>n+Number(r.amount_minor),0)!==Number(order.store_credit_minor))
    throw new ApiError(409,"Settlement reservations do not cover canonical tender.");
  const statements:Parameters<CatalogDB["batch"]>[0]=[];
  const preorderReleaseDates=new Map<string,string>();
  // Each assertion writes verified=0 on a mismatch: CHECK aborts the entire
  // D1 batch. Rechecking only the last UPDATE's changes is too late.
  const checks:string[]=[],args:unknown[]=[];
  const assert=(condition:string,...values:unknown[])=>{checks.push("("+condition+")");args.push(...values);};
  assert("EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND status=? AND user_id=? AND currency=? AND territory_code=? AND stripe_payment_intent_id IS ? AND "+fields.map(k=>k+"=?").join(" AND ")+")",
    orderId,order.status,order.user_id,order.currency,order.territory_code,order.stripe_payment_intent_id,...fields.map(k=>Number(order[k]||0)));
  assert("NOT EXISTS(SELECT 1 FROM commerce_refunds WHERE order_id=?)",orderId);
  assert("NOT EXISTS(SELECT 1 FROM risk_holds WHERE domain='buyer' AND subject_type='order' AND subject_id=? AND status='active' AND hold_scope IN ('checkout','entitlement'))",orderId);
  assert("(SELECT COUNT(*) FROM commerce_order_items WHERE order_id=?)=?",orderId,items.length);
  assert("(SELECT COUNT(*) FROM commerce_balance_reservations WHERE order_id=?)=?",orderId,reservations.length);
  for(const r of reservations){
    assert("EXISTS(SELECT 1 FROM commerce_balance_reservations WHERE id=? AND order_id=? AND user_id=? AND currency=? AND source_type=? AND source_key=? AND amount_minor=? AND status='reserved')",
      r.id,orderId,order.user_id,order.currency,r.source_type,r.source_key,r.amount_minor);
  }
  const sources=new Map<string,number>();
  for(const r of reservations)if(r.source_type==="gift_card")sources.set(r.source_key,(sources.get(r.source_key)||0)+Number(r.amount_minor));
  for(const [key,amount] of sources){
    assert("EXISTS(SELECT 1 FROM commerce_gift_cards g WHERE g.code_hash=? AND g.currency=? AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?) AND g.balance_minor>=?+COALESCE((SELECT SUM(amount_minor) FROM commerce_balance_reservations WHERE source_type='gift_card' AND source_key=g.code_hash AND order_id<>? AND status='reserved' AND expires_at>?),0))",
      key,order.currency,at,amount,orderId,at);
    statements.push(db.prepare("UPDATE commerce_gift_cards SET balance_minor=balance_minor-?,status=CASE WHEN balance_minor-?=0 THEN 'exhausted' ELSE status END,updated_at=? WHERE code_hash=?")
      .bind(amount,amount,at,key));
    statements.push(db.prepare("INSERT INTO commerce_gift_card_ledger(id,code_hash,order_id,entry_type,amount_minor,balance_after_minor,created_at) SELECT ?,code_hash,?,'purchase',?,balance_minor,? FROM commerce_gift_cards WHERE code_hash=?")
      .bind("settle_gift:"+orderId+":"+key,orderId,-amount,at,key));
  }
  if(Number(order.store_credit_minor)>0){
    assert("COALESCE((SELECT SUM(amount_minor) FROM commerce_store_credit_ledger WHERE user_id=? AND currency=?),0)>=?+COALESCE((SELECT SUM(amount_minor) FROM commerce_balance_reservations WHERE source_type='store_credit' AND source_key=? AND currency=? AND order_id<>? AND status='reserved' AND expires_at>?),0)",
      order.user_id,order.currency,order.store_credit_minor,order.user_id,order.currency,orderId,at);
    statements.push(db.prepare("INSERT INTO commerce_store_credit_ledger(id,user_id,order_id,entry_type,amount_minor,currency,reference,created_at) VALUES(?,?,?,'purchase',?,?,?,?)")
      .bind("settle_credit:"+orderId,order.user_id,orderId,-Number(order.store_credit_minor),order.currency,order.invoice_number,at));
  }
  statements.push(db.prepare("UPDATE commerce_balance_reservations SET status='consumed',updated_at=? WHERE order_id=? AND status='reserved'").bind(at,orderId));
  // Promotion counter and redemption state change together, once only.
  statements.push(db.prepare("UPDATE commerce_promo_codes SET redemptions=redemptions+1,updated_at=? WHERE code_hash IN (SELECT code_hash FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved')").bind(at,orderId));
  statements.push(db.prepare("UPDATE commerce_promo_redemptions SET status='applied',updated_at=? WHERE order_id=? AND status='reserved'").bind(at,orderId));
  for(const item of items){
    const frozenLineFields=["unit_amount_minor","discount_minor","tax_minor","pricing_decision_id","promotion_campaign_id","publisher_discount_funding_minor","fore_discount_funding_minor","distributor_fee_minor","fulfillment_type"];
    assert("EXISTS(SELECT 1 FROM commerce_order_items WHERE id=? AND order_id=? AND product_id=? AND total_minor=? AND entitlement_status='pending' AND preorder_id IS NULL AND rights_grant_id IS ? AND rights_snapshot_json IS ? AND sales_channel=? AND "+frozenLineFields.map(k=>k+" IS ?").join(" AND ")+")",
      item.id,orderId,item.product_id,item.total_minor,item.rights_grant_id,item.rights_snapshot_json,item.sales_channel,...frozenLineFields.map(k=>item[k]??null));
    assert("NOT EXISTS(SELECT 1 FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase' AND status='active')",order.user_id,item.product_id);
    const product=await db.prepare("SELECT p.*,e.work_id,e.release_status,e.release_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(item.product_id).first<Product>();
    if(!product)throw new ApiError(409,"Settlement product is unavailable.");
    const future=!!product.release_date&&Date.parse(product.release_date)>Date.parse(at);
    const preorder=product.release_status==="preorder"||future;
    assert("EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=? AND p.edition_id=? AND e.work_id=? AND p.source_external_id IS ? AND e.release_status=? AND e.release_date IS ?)",item.product_id,product.edition_id,product.work_id,product.source_external_id,product.release_status,product.release_date);
    if(preorder){
      const plan=await db.prepare("SELECT * FROM preorder_release_plans WHERE product_id=? ORDER BY updated_at DESC LIMIT 1").bind(item.product_id).first<PreorderPlan>();
      if(!plan||!["open","scheduled","locked"].includes(plan.status)||
         !Number.isFinite(Date.parse(plan.opens_at))||Date.parse(plan.opens_at)>Date.parse(at)||
         plan.payment_timing!=="charge_now")throw new ApiError(409,"Preorder plan cannot accept this settlement.");
      assert("EXISTS(SELECT 1 FROM preorder_release_plans WHERE id=? AND product_id=? AND status=? AND payment_timing='charge_now' AND opens_at=? AND release_at=?)",plan.id,item.product_id,plan.status,plan.opens_at,plan.release_at);
      assert("NOT EXISTS(SELECT 1 FROM preorders WHERE user_id=? AND product_id=? AND status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested'))",order.user_id,item.product_id);
      preorderReleaseDates.set(item.id,plan.release_at);
      const preorderId="preorder_"+item.id;
      statements.push(db.prepare("INSERT INTO preorders(id,release_plan_id,order_item_id,order_id,user_id,product_id,currency,original_price_minor,guaranteed_price_minor,charged_minor,payment_timing,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'charge_now','paid_pending_release',?,?)")
        .bind(preorderId,plan.id,item.id,orderId,order.user_id,item.product_id,order.currency,item.total_minor,item.total_minor,item.total_minor,at,at));
      statements.push(db.prepare("UPDATE commerce_order_items SET fulfillment_type='preorder',fulfillment_status='pending_release',preorder_id=?,entitlement_status='pending' WHERE id=?").bind(preorderId,item.id));
      statements.push(db.prepare("INSERT INTO preorder_events(id,preorder_id,event_type,actor_type,actor_id,event_json,created_at) VALUES(?,?,'paid_and_reserved','customer',?,?,?)")
        .bind("settle_event:"+item.id,preorderId,order.user_id,JSON.stringify({releaseAt:plan.release_at,chargedMinor:item.total_minor,currency:order.currency}),at));
      statements.push(db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?,'preorder.confirmed','preorder',?,?,'pending',0,?,?)")
        .bind("settle_preorder:"+item.id,preorderId,JSON.stringify({preorderId,orderId,productId:item.product_id,userId:order.user_id,releaseAt:plan.release_at}),at,at));
    }else{
      const entitlementId="ent_"+item.id;
      statements.push(db.prepare("INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at) VALUES(?,?,?,'purchase','active','commerce',?,?,?)")
        .bind(entitlementId,order.user_id,item.product_id,item.id,at,at));
      statements.push(db.prepare("UPDATE commerce_order_items SET entitlement_status='granted',fulfillment_status='fulfilled' WHERE id=?").bind(item.id));
      const lifecycle=await db.prepare("SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=? LIMIT 1")
        .bind(item.product_id).first<Lifecycle>();
      if(!lifecycle)assert("NOT EXISTS(SELECT 1 FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=?)",item.product_id);
      if(lifecycle){
        assert("EXISTS(SELECT 1 FROM publishing_release_lifecycles WHERE id=? AND current_publication_version_id=? AND owner_update_policy=?)",lifecycle.id,lifecycle.current_publication_version_id,lifecycle.owner_update_policy);
        if(lifecycle.owner_update_policy!=="auto_update"){
          statements.push(db.prepare("INSERT INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?)")
            .bind(entitlementId,lifecycle.id,lifecycle.current_publication_version_id,lifecycle.owner_update_policy,at,at));
          statements.push(db.prepare("INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,NULL,?,'grant_pin',?,?)")
            .bind("settle_pin:"+item.id,entitlementId,lifecycle.id,lifecycle.current_publication_version_id,order.user_id,at));
        }
      }
      statements.push(db.prepare("INSERT INTO entitlement_ownership_records(entitlement_id,user_id,product_id,work_id,edition_id,ownership_scope,publication_version_id,owner_update_policy,redownload_policy,rights_expiry_policy,removal_policy,annotations_policy,biosync_policy,acquired_at,created_at,updated_at) VALUES(?,?,?,?,?,'exact_edition',?,?,'preserve_for_owner','preserve_for_owner','preserve_for_owner','migrate_or_preserve','version_bound',?,?,?)")
        .bind(entitlementId,order.user_id,item.product_id,product.work_id,product.edition_id,lifecycle?.current_publication_version_id||null,lifecycle?.owner_update_policy||"auto_update",at,at,at));
      statements.push(db.prepare("INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,updated_at) VALUES(?,?,?,1,'want-to-read',0,COALESCE((SELECT cfi FROM preview_states WHERE user_id=? AND product_id=?),''),?) ON CONFLICT(user_id,product_id) DO UPDATE SET in_library=1,cfi=CASE WHEN reading_states.cfi='' THEN excluded.cfi ELSE reading_states.cfi END,updated_at=excluded.updated_at")
        .bind(order.user_id,item.product_id,product.source_external_id,order.user_id,item.product_id,at));
    }
    statements.push(db.prepare("UPDATE preview_states SET converted_at=? WHERE user_id=? AND product_id=? AND converted_at IS NULL").bind(at,order.user_id,item.product_id));
    statements.push(db.prepare("UPDATE wishlist_items SET converted_at=?,updated_at=? WHERE user_id=? AND product_id=?").bind(at,at,order.user_id,item.product_id));
  }
  const processorFees=new Map<string,number>();
  const fee=payment.processorFee;
  if(payment.provider==="stripe"){
    if(!fee||!money(fee.amountMinor)||fee.currency!==order.currency||
       !/^txn_[a-zA-Z0-9_-]{3,200}$/.test(fee.reference)||!Number.isSafeInteger(fee.netMinor))
      throw new ApiError(503,"Complete Stripe fee evidence is required before settlement.");
    const weights=items.map(i=>Number(i.total_minor)),sum=weights.reduce((a,b)=>a+b,0);
    let remaining=fee.amountMinor;
    for(let i=0;i<items.length;i++){
      const share=i===items.length-1?remaining:Math.floor(fee.amountMinor*weights[i]/Math.max(1,sum));
      remaining-=share;processorFees.set(items[i].id,share);
      statements.push(db.prepare("UPDATE commerce_order_items SET processor_fee_minor=? WHERE id=?").bind(share,items[i].id));
    }
    for(const [account,amount] of [["stripe_fee_expense",fee.amountMinor],["stripe_receivable",-fee.amountMinor]] as Array<[string,number]>)
      if(amount!==0)statements.push(db.prepare("INSERT INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,'processor_fee',?,?,?,?,?,?)")
        .bind("settle_fee:"+orderId+":"+account,orderId,order.user_id,account,amount,order.currency,fee.reference,JSON.stringify({net:fee.netMinor}),at));
  }
  assert("NOT EXISTS(SELECT 1 FROM finance_royalty_calculations WHERE order_id=? AND source_type='sale')",orderId);
  await accrueSaleRoyaltiesForOrder(db,orderId,{statements,at,processorFees,preorderReleaseDates});
  const gross=Number(order.subtotal_minor)-Number(order.promo_discount_minor),
    inclusive=Number(order.tax_inclusive_minor),exclusive=Number(order.tax_minor);
  const entries:Array<[string,string,number]>=[
    ["sale_tender","stripe_receivable",Number(order.stripe_due_minor)],
    ["sale_tender","gift_card_liability",Number(order.gift_card_minor)],
    ["sale_tender","store_credit_liability",Number(order.store_credit_minor)],
    ["sale","ebook_sales",-(gross-inclusive)],
    ["tax","tax_payable",-(inclusive+exclusive)],
  ];
  if(entries.reduce((n,e)=>n+e[2],0)!==0)throw new ApiError(409,"Unbalanced settlement journal.");
  assert("NOT EXISTS(SELECT 1 FROM commerce_ledger_entries WHERE order_id=? AND entry_type IN ('sale','sale_tender','tax'))",orderId);
  for(const [type,account,amount] of entries)if(amount!==0)statements.push(db.prepare("INSERT INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind("settle_ledger:"+orderId+":"+account,orderId,order.user_id,type,account,amount,order.currency,reference,"{}",at));
  statements.push(db.prepare("DELETE FROM shopping_cart_items WHERE cart_id=(SELECT id FROM shopping_carts WHERE user_id=?) AND product_id IN (SELECT product_id FROM commerce_order_items WHERE order_id=?)").bind(order.user_id,orderId));
  statements.push(db.prepare("UPDATE commerce_orders SET status='paid',stripe_charge_id=?,receipt_url=?,payment_method_summary=?,paid_at=?,updated_at=? WHERE id=?")
    .bind(payment.chargeId,payment.receiptUrl,payment.paymentMethod||"",at,at,orderId));
  // First statement verifies the complete read-set INSIDE the transaction.
  // SQL variable limit is bounded by splitting checks into small independent
  // CHECK updates. There is no half-settled order if a later one fails.
  const paymentJson=JSON.stringify(payment);
  const guard=db.prepare("INSERT INTO commerce_settlement_receipts(order_id,payment_reference,payment_json,verified,settled_at) VALUES(?,?,?,1,?)").bind(orderId,reference,paymentJson,at);
  const assertions:Parameters<CatalogDB["batch"]>[0]=[];
  let offset=0;
  for(const check of checks){
    const count=(check.match(/\?/g)||[]).length;
    assertions.push(db.prepare("UPDATE commerce_settlement_receipts SET verified=CASE WHEN "+check+" THEN 1 ELSE 0 END WHERE order_id=?")
      .bind(...args.slice(offset,offset+count),orderId));offset+=count;
  }
  await db.batch([guard,...assertions,...statements]);
  const committed=await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<SettlementOrder>();
  if(!committed||committed.status!=="paid")throw new ApiError(503,"Settlement commit was not acknowledged.");
  return {order:committed,applied:true,payment};
}
