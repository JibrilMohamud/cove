import { z } from "zod";
import { ApiError } from "./service";
import type { CatalogDB } from "./catalog-model.server";
import { promotionPermitted, resolveProductRights, type RightsDecision } from "./rights.server";

const now=()=>new Date().toISOString();
const territorySchema=z.string().regex(/^[A-Z]{2}$/);
const currencySchema=z.string().regex(/^[A-Z]{3}$/);

export type PricingDecision={
  id?:string; offerId:string; productId:string; territory:string; currency:string;
  baseAmountMinor:number; scheduledAmountMinor:number; promotionAmountMinor:number;
  promotion:null|{id:string;campaignId:string|null;name:string;type:string;endsAt:string;fundingSource:string;publisherFundingBps:number};
  amountMinor:number; listAmountMinor:number; floorMinor:number|null; fxRatePpm:number|null; fxSource:string|null;
  preorderGuaranteeApplied:boolean; taxBehavior:string; taxCode:string; validUntil:string|null; ruleTrace:string[]; rights:RightsDecision;
};

function psych(amount:number){if(amount<=0)return 0;if(amount<100)return amount;const dollars=Math.floor(amount/100);return Math.max(99,dollars*100+99);}
function roundPrice(amount:number,rule:string){const n=Math.max(0,Math.round(amount));if(rule==="psychological_99")return psych(n);if(rule==="nearest_5")return Math.round(n/5)*5;if(rule==="nearest_10")return Math.round(n/10)*10;return n;}

async function latestFx(db:CatalogDB,base:string,quote:string,at:string){if(base===quote)return{rate_ppm:1_000_000,source:"identity"};return db.prepare(`SELECT rate_ppm,source FROM fx_rates WHERE base_currency=? AND quote_currency=? AND effective_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY effective_at DESC LIMIT 1`).bind(base,quote,at,at).first<any>();}

export async function resolvePricingDecision(db:CatalogDB,productId:string,territory="US",opts:{userId?:string|null;persist?:boolean;at?:string}={}):Promise<PricingDecision|null>{
  territory=territorySchema.parse(territory.toUpperCase());const at=opts.at||now();
  const product=await db.prepare(`SELECT p.id,p.edition_id,p.format,p.storefront_status,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?`).bind(productId).first<any>();
  if(!product||product.storefront_status!=="active")return null;
  const rights=await resolveProductRights(db,productId,territory,{salesChannel:"retail",at,persist:!!opts.persist,context:{source:"pricing",userId:opts.userId||null}});if(!rights.allowed)return null;
  const offer=await db.prepare(`SELECT * FROM offers WHERE product_id=? AND sales_channel='retail' AND active=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) ORDER BY created_at DESC LIMIT 1`).bind(productId,at,at).first<any>();if(!offer)return null;
  const assignment=await db.prepare(`SELECT a.*,p.base_currency,p.rounding_rule,p.fx_markup_bps FROM product_pricing_assignments a JOIN pricing_policies p ON p.id=a.policy_id AND p.status='active' WHERE a.product_id=?`).bind(productId).first<any>();
  const policy=assignment||{policy_id:"pricing_default",base_currency:String(offer.currency).toUpperCase(),rounding_rule:"none",fx_markup_bps:0,preorder_guarantee:1,publisher_floor_minor:null,minimum_advertised_price_minor:null};
  const region=await db.prepare(`SELECT * FROM pricing_region_rules WHERE policy_id=? AND territory_code=? AND active=1 ORDER BY updated_at DESC LIMIT 1`).bind(policy.policy_id||"pricing_default",territory).first<any>();
  const targetCurrency=currencySchema.parse(String(region?.currency||offer.currency).toUpperCase());
  const trace:string[]=[`offer:${offer.id}`,`territory:${territory}`];
  const schedule=await db.prepare(`SELECT * FROM price_schedules WHERE offer_id=? AND currency=? AND (territory_code IS NULL OR territory_code=?) AND starts_at<=? AND (ends_at IS NULL OR ends_at>?) ORDER BY CASE WHEN territory_code=? THEN 0 ELSE 1 END,starts_at DESC LIMIT 1`).bind(offer.id,targetCurrency,territory,at,at,territory).first<any>();
  let base=Number(offer.amount_minor),fxRatePpm:number|null=null,fxSource:string|null=null;
  if(String(offer.currency).toUpperCase()!==targetCurrency){
    if(schedule){base=Number(schedule.amount_minor);trace.push(`regional-list:${schedule.id}:direct`);}
    else {
      const fx=await latestFx(db,String(offer.currency).toUpperCase(),targetCurrency,at);
      if(fx){fxRatePpm=Number(fx.rate_ppm);fxSource=String(fx.source);const markup=Number(policy.fx_markup_bps||0);base=Math.round(base*fxRatePpm/1_000_000*(10000+markup)/10000);base=roundPrice(base,String(policy.rounding_rule||"none"));trace.push(`fx:${fxSource}:${fxRatePpm}`,`round:${policy.rounding_rule||"none"}`);}
      else throw new ApiError(409,`No active ${targetCurrency} regional price or FX rate is configured for ${offer.currency}/${targetCurrency}.`);
    }
  }
  let scheduled=schedule?Number(schedule.amount_minor):base;if(schedule)trace.push(`schedule:${schedule.id}:${schedule.price_kind}`);
  const floorCandidates=[region?.floor_minor,policy.publisher_floor_minor,policy.minimum_advertised_price_minor].filter(v=>v!=null).map(Number);const floor=floorCandidates.length?Math.max(...floorCandidates):null;const ceiling=region?.ceiling_minor==null?null:Number(region.ceiling_minor);
  if(floor!=null&&scheduled<floor){scheduled=floor;trace.push(`floor:${floor}`);}if(ceiling!=null&&scheduled>ceiling){scheduled=ceiling;trace.push(`ceiling:${ceiling}`);}
  let amount=scheduled,promotion:any=null,promoDiscount=0;
  const promo=await db.prepare(`SELECT pr.*,pc.campaign_type campaign_type FROM promotions pr LEFT JOIN promotion_campaigns pc ON pc.id=pr.campaign_id WHERE pr.offer_id=? AND pr.active=1 AND (pr.territory_code IS NULL OR pr.territory_code=?) AND pr.starts_at<=? AND pr.ends_at>? AND (pc.id IS NULL OR (pc.status IN ('approved','scheduled','live') AND (pc.max_redemptions IS NULL OR (SELECT COUNT(*) FROM promotion_attribution_events pae WHERE pae.campaign_id=pc.id AND pae.event_type='order')<pc.max_redemptions) AND (pc.budget_minor IS NULL OR (SELECT COALESCE(SUM(CASE WHEN pae.event_type='order' THEN pae.funding_minor WHEN pae.event_type='refund' THEN -pae.funding_minor ELSE 0 END),0) FROM promotion_attribution_events pae WHERE pae.campaign_id=pc.id)<pc.budget_minor))) ORDER BY pr.starts_at DESC LIMIT 1`).bind(offer.id,territory,at,at).first<any>();
  if(promo){const type=String(promo.campaign_type||promo.promotion_type||"").toLowerCase(),v=Number(promo.amount_minor||0);let proposed=amount;if(["sale-price","fixed-price","price"].includes(type))proposed=v;else if(["amount-off","discount"].includes(type))proposed=amount-v;if(floor!=null)proposed=Math.max(floor,proposed);proposed=Math.max(0,proposed);const permitted=promotionPermitted(rights.promotionRestrictions,{type,baseAmountMinor:amount,proposedAmountMinor:proposed,rightsholderApproved:String(promo.funding_source||"publisher")==="publisher"});if(permitted.allowed){promoDiscount=Math.max(0,amount-proposed);amount=proposed;promotion={id:String(promo.id),campaignId:promo.campaign_id?String(promo.campaign_id):null,name:String(promo.name||"Sale"),type:String(promo.campaign_type||promo.promotion_type),endsAt:String(promo.ends_at),fundingSource:String(promo.funding_source||"publisher"),publisherFundingBps:Number(promo.publisher_funding_bps??10000)};trace.push(`promo:${promo.id}:${promotion.fundingSource}`);}else trace.push(`promo-blocked-by-rights:${promo.id}:${permitted.reasonCode}`);}
  let guarantee=false;
  const preorder=String(product.release_status)==="preorder"||(product.release_date&&String(product.release_date)>at);
  if(preorder&&opts.userId&&Number(policy.preorder_guarantee??1)){const existing=await db.prepare(`SELECT * FROM preorder_price_guarantees WHERE user_id=? AND product_id=? AND currency=?`).bind(opts.userId,productId,targetCurrency).first<any>();const lowest=Math.min(amount,existing?Number(existing.lowest_price_minor):amount);guarantee=lowest<amount;amount=lowest;await db.prepare(`INSERT INTO preorder_price_guarantees(user_id,product_id,currency,lowest_price_minor,first_seen_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,product_id,currency) DO UPDATE SET lowest_price_minor=MIN(preorder_price_guarantees.lowest_price_minor,excluded.lowest_price_minor),updated_at=excluded.updated_at`).bind(opts.userId,productId,targetCurrency,lowest,at,at).run();trace.push(`preorder-guarantee:${lowest}`);}
  const validUntil=[offer.ends_at,schedule?.ends_at,promo?.ends_at,product.release_date].filter(Boolean).sort()[0]||null;
  const decision:PricingDecision={offerId:String(offer.id),productId,territory,currency:targetCurrency,baseAmountMinor:base,scheduledAmountMinor:scheduled,promotionAmountMinor:promoDiscount,promotion,amountMinor:amount,listAmountMinor:scheduled,floorMinor:floor,fxRatePpm,fxSource,preorderGuaranteeApplied:guarantee,taxBehavior:String(offer.tax_behavior||"exclusive"),taxCode:String(offer.tax_code||"txcd_10302000"),validUntil,ruleTrace:trace,rights};
  if(opts.persist){const id=`price_${crypto.randomUUID()}`;await db.prepare(`INSERT INTO pricing_decisions(id,product_id,offer_id,territory_code,currency,base_amount_minor,scheduled_amount_minor,promotion_amount_minor,promotion_id,effective_amount_minor,floor_minor,fx_rate_ppm,fx_source,preorder_guarantee_applied,rule_trace_json,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,productId,offer.id,territory,targetCurrency,base,scheduled,promoDiscount,promo?.id||null,amount,floor,fxRatePpm,fxSource,guarantee?1:0,JSON.stringify(trace),validUntil,at).run();decision.id=id;}
  return decision;
}

export async function upsertFxRate(db:CatalogDB,raw:unknown){const x=z.object({baseCurrency:currencySchema,quoteCurrency:currencySchema,rate:z.number().positive(),source:z.string().min(1).max(80).default("operator"),effectiveAt:z.string().datetime().optional(),expiresAt:z.string().datetime().nullable().optional()}).parse(raw),at=now(),id=`fx_${crypto.randomUUID()}`;await db.prepare(`INSERT INTO fx_rates(id,base_currency,quote_currency,rate_ppm,source,effective_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)`).bind(id,x.baseCurrency,x.quoteCurrency,Math.round(x.rate*1_000_000),x.source,x.effectiveAt||at,x.expiresAt||null,at).run();return{id,rate:x.rate};}

export async function savePriceSchedule(db:CatalogDB,raw:unknown){const x=z.object({offerId:z.string().min(1),currency:currencySchema,amountMinor:z.number().int().min(0),territory:z.string().regex(/^[A-Z]{2}$/).nullable().optional(),priceKind:z.enum(["list","sale","preorder","introductory"]).default("list"),source:z.string().max(80).default("publisher"),reason:z.string().max(300).default(""),startsAt:z.string().datetime(),endsAt:z.string().datetime().nullable().optional()}).parse(raw);if(x.endsAt&&x.endsAt<=x.startsAt)throw new ApiError(400,"Price schedule end must be after its start.");const id=`ps_${crypto.randomUUID()}`;await db.prepare(`INSERT INTO price_schedules(id,offer_id,currency,amount_minor,starts_at,ends_at,territory_code,price_kind,source,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id,x.offerId,x.currency,x.amountMinor,x.startsAt,x.endsAt||null,x.territory||null,x.priceKind,x.source,x.reason,now()).run();return{id};}

export async function pricingAdminSnapshot(db:CatalogDB){const [policies,rules,fx,schedules,decisions]=await Promise.all([db.prepare("SELECT * FROM pricing_policies ORDER BY updated_at DESC").all<any>(),db.prepare("SELECT * FROM pricing_region_rules ORDER BY policy_id,territory_code").all<any>(),db.prepare("SELECT * FROM fx_rates ORDER BY effective_at DESC LIMIT 100").all<any>(),db.prepare("SELECT * FROM price_schedules ORDER BY starts_at DESC LIMIT 200").all<any>(),db.prepare("SELECT * FROM pricing_decisions ORDER BY created_at DESC LIMIT 100").all<any>()]);return{policies:policies.results,rules:rules.results,fxRates:fx.results,schedules:schedules.results,decisions:decisions.results};}
