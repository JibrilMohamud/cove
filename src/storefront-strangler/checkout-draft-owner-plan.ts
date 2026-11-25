/* eslint-disable prettier/prettier -- Exact owner checkout draft normalization; no caller-supplied SQL or prices. */
import {z} from "zod/v3";

const buyer=z.string().regex(/^[A-Za-z0-9_-]{8,160}$/);
const quoteId=z.string().regex(/^[A-Za-z0-9_-]{8,160}$/);
const money=z.number().int().min(0).max(1_000_000_000_000);
export const checkoutDraftCommand=z.object({
  userId:buyer,quoteId,
  idempotencyKey:z.string().min(16).max(200),
  // A trusted caller must independently reprice the current cart. The owner
  // checks equality with the canonical quote; it cannot compute cartPricing.
  cartFingerprint:z.string().min(16).max(1024),
  captureMethod:z.enum(["manual","automatic","automatic_async"]),
  soundsStation:z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  soundsRecording:z.string().regex(/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/).optional()
}).strict();

const storedQuote=z.object({
  id:quoteId,user_id:buyer,cart_fingerprint:z.string().min(16),
  currency:z.string().regex(/^[A-Z]{3}$/),
  territory_code:z.string().regex(/^[A-Z]{2}$/),
  expires_at:z.string(),consumed_at:z.string().nullable().optional(),
  items_json:z.string().min(3),
  subtotal_minor:money,promo_discount_minor:money,
  tax_minor:money,tax_inclusive_minor:money,
  gift_card_minor:money,store_credit_minor:money,
  total_minor:money,stripe_due_minor:money,
  billing_address_json:z.string().min(2),
  stripe_tax_calculation_id:z.string().nullable().optional(),
  promo_code_hash:z.string().nullable().optional(),
  gift_card_hash:z.string().nullable().optional()
}).passthrough();

const line=z.object({
  productId:z.string().regex(/^prd_[A-Za-z0-9_-]{3,120}$/),
  offerId:z.string().min(1).max(160),
  title:z.string().min(1).max(500),
  sku:z.string().max(180).optional(),
  amountMinor:money,discountMinor:money.default(0),taxMinor:money.default(0),
  taxBehavior:z.enum(["exclusive","inclusive"]).default("exclusive"),
  salesChannel:z.enum(["retail"]).optional(),
  rightsGrantId:z.string().max(180).nullable().optional(),
  rightsDecisionId:z.string().max(180).nullable().optional(),
  rightsSnapshot:z.record(z.string(),z.unknown()),
  sourceSurface:z.string().max(100).optional(),
  sourceRequestId:z.string().max(180).nullable().optional(),
  pricingDecisionId:z.string().max(180).nullable().optional(),
  checkoutPromotionCampaignId:z.string().max(180).nullable().optional(),
  promotionCampaignId:z.string().max(180).nullable().optional(),
  publisherDiscountFundingMinor:money.default(0),
  foreDiscountFundingMinor:money.default(0)
}).passthrough();
export type CheckoutDraftCommand=z.infer<typeof checkoutDraftCommand>;
export type OwnerCheckoutDraftLine={
  id:string;productId:string;offerId:string;title:string;sku:string;
  amountMinor:number;discountMinor:number;taxMinor:number;totalMinor:number;
  sourceSurface:string;sourceRequestId:string|null;
  pricingDecisionId:string|null;rightsDecisionId:string|null;
  rightsGrantId:string|null;rightsSnapshotJson:string;
  salesChannel:"retail";promotionCampaignId:string|null;
  publisherFunding:number;foreFunding:number;
};

export function planOwnerCheckoutDraft(raw:unknown,stored:unknown,at:string,makeId:()=>string){
  const command=checkoutDraftCommand.parse(raw),quote=storedQuote.parse(stored);
  if(quote.id!==command.quoteId||quote.user_id!==command.userId||
     quote.cart_fingerprint!==command.cartFingerprint||
     quote.consumed_at||!Number.isFinite(Date.parse(quote.expires_at))||
     quote.expires_at<=at)throw Error("owner_checkout_quote_stale");
  let json:unknown;
  try{json=JSON.parse(quote.items_json);}catch{throw Error("owner_checkout_lines_invalid");}
  const items=z.array(line).min(1).max(25).parse(json);
  const seen=new Set<string>();
  const rows:OwnerCheckoutDraftLine[]=items.map(x=>{
    if(seen.has(x.productId))throw Error("owner_checkout_duplicate_product");
    seen.add(x.productId);
    if(x.discountMinor>x.amountMinor||x.publisherDiscountFundingMinor+
        x.foreDiscountFundingMinor!==x.discountMinor)
      throw Error("owner_checkout_invalid_discount_allocation");
    if(x.rightsSnapshot.salesChannel!==undefined&&
       x.rightsSnapshot.salesChannel!=="retail")
      throw Error("owner_checkout_nonretail_scope");
    const total=x.amountMinor-x.discountMinor+(x.taxBehavior==="exclusive"?x.taxMinor:0);
    if(!money.safeParse(total).success)throw Error("owner_checkout_line_total_invalid");
    return {id:"oi_"+makeId(),productId:x.productId,offerId:x.offerId,
      title:x.title,sku:x.sku||x.productId,amountMinor:x.amountMinor,
      discountMinor:x.discountMinor,taxMinor:x.taxMinor,totalMinor:total,
      sourceSurface:x.sourceSurface||"cart",sourceRequestId:x.sourceRequestId||null,
      pricingDecisionId:x.pricingDecisionId||null,
      rightsDecisionId:x.rightsDecisionId||null,
      rightsGrantId:x.rightsGrantId||null,
      rightsSnapshotJson:JSON.stringify(x.rightsSnapshot),
      salesChannel:"retail" as const,
      promotionCampaignId:x.checkoutPromotionCampaignId||x.promotionCampaignId||null,
      publisherFunding:x.publisherDiscountFundingMinor,
      foreFunding:x.foreDiscountFundingMinor};
  });
  const sum=(fn:(i:typeof items[number])=>number)=>items.reduce((n,i)=>n+fn(i),0);
  if(sum(i=>i.amountMinor)!==quote.subtotal_minor||
     sum(i=>i.discountMinor)!==quote.promo_discount_minor||
     sum(i=>i.taxBehavior==="exclusive"?i.taxMinor:0)!==quote.tax_minor||
     sum(i=>i.taxBehavior==="inclusive"?i.taxMinor:0)!==quote.tax_inclusive_minor||
     rows.reduce((n,r)=>n+r.totalMinor,0)!==quote.total_minor||
     quote.subtotal_minor-quote.promo_discount_minor+quote.tax_minor!==quote.total_minor||
     quote.gift_card_minor+quote.store_credit_minor+quote.stripe_due_minor!==quote.total_minor||
     (quote.gift_card_minor>0&&!quote.gift_card_hash)||
     (quote.promo_discount_minor>0&&!quote.promo_code_hash))
    throw Error("owner_checkout_money_mismatch");
  const orderId="ord_"+makeId();
  const d=new Date(at),invoice="FORE-"+d.getUTCFullYear()+
    String(d.getUTCMonth()+1).padStart(2,"0")+"-"+makeId().replaceAll("-","").slice(0,10).toUpperCase();
  return {command,quote,lines:rows,orderId,invoice,at};
}

/**
 * The private owner must compare the transaction-current quote with the
 * already materialized order BEFORE reserving any tender or contacting Stripe.
 * A quote changed between atomic draft creation and preparation must not
 * silently change who pays, the market, or the payment allocation.
 *
 * This is deliberately independent of caller-provided prices/fingerprints.
 * It does not replace the upstream live-cart reprice or later rights checks.
 */
export function ownerCheckoutPreparationMatchesQuote(
  order:Record<string,unknown>,quote:Record<string,unknown>
){
  if(order.user_id!==quote.user_id||order.quote_id!==quote.id||
     order.currency!==quote.currency||order.territory_code!==quote.territory_code)
    return false;
  const moneyColumns=[
    "subtotal_minor","promo_discount_minor","tax_minor","tax_inclusive_minor",
    "gift_card_minor","store_credit_minor","total_minor","stripe_due_minor"
  ] as const;
  return moneyColumns.every(column=>{
    const a=order[column],b=quote[column];
    return typeof a==="number"&&typeof b==="number"&&
      Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>=0&&a===b;
  });
}
