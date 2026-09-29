import { z } from "zod";
import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";
import { assessUsageRisk, effectivePublisherWithholding } from "./risk-tax.server";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const clampBps = (value: unknown, fallback = 0) => Math.max(0, Math.min(10000, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
const minor = (value: unknown) => Math.round(Number(value || 0));
function safeJson<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } }
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""); }

export type RoyaltyContext = {
  sourceType: "sale" | "refund" | "chargeback" | "subscription" | "library" | "wholesale" | "agency" | "promotion_adjustment" | "manual_adjustment";
  sourceId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  usageEventId?: string | null;
  productId: string;
  publisherId?: string | null;
  territory: string;
  format: string;
  salesChannel: string;
  currency: string;
  quantity?: number;
  listPriceMinor?: number;
  customerPriceMinor?: number;
  taxMinor?: number;
  processorFeeMinor?: number;
  promotionDiscountMinor?: number;
  foreFundedDiscountMinor?: number;
  publisherFundedDiscountMinor?: number;
  distributorFeeMinor?: number;
  grossValueMinor?: number;
  rightsBasis?: string | null;
  promotionType?: string | null;
  promotionFundingSource?: string | null;
  distributorId?: string | null;
  subscriptionPlanId?: string | null;
  occurredAt: string;
  /** Optional contractual availability anchor (for example, a paid preorder release date). */
  availabilityAnchorAt?: string | null;
  metadata?: Record<string, unknown>;
};

type RoyaltyRuleAction = {
  basis?: "list_price" | "customer_price" | "net_receipts" | "gross_value";
  royaltyRateBps?: number;
  foreCommissionBps?: number;
  flatRoyaltyMinorPerUnit?: number;
  reserveBps?: number;
  paymentTermsDays?: number;
  processorFeeTreatment?: "deduct" | "ignore";
  distributorFeeTreatment?: "deduct" | "ignore";
  taxTreatment?: "deduct" | "ignore";
  foreFundedDiscountTreatment?: "add_back" | "ignore";
  publisherFundedDiscountTreatment?: "deduct" | "ignore";
};

type RoyaltyRuleConditions = {
  territories?: string[];
  excludeTerritories?: string[];
  publisherIds?: string[];
  productIds?: string[];
  formats?: string[];
  salesChannels?: string[];
  rightsBasis?: string[];
  promotionTypes?: string[];
  promotionFundingSources?: string[];
  distributorIds?: string[];
  subscriptionPlanIds?: string[];
  minCustomerPriceMinor?: number;
  maxCustomerPriceMinor?: number;
  minListPriceMinor?: number;
  maxListPriceMinor?: number;
};

function includesOrAny(values: string[] | undefined, actual: string | null | undefined) {
  if (!values?.length) return true;
  return values.map(v => String(v).toUpperCase()).includes(String(actual || "").toUpperCase());
}
function ruleMatches(conditions: RoyaltyRuleConditions, ctx: RoyaltyContext) {
  if (!includesOrAny(conditions.territories, ctx.territory)) return false;
  if (conditions.excludeTerritories?.map(x => x.toUpperCase()).includes(ctx.territory.toUpperCase())) return false;
  if (!includesOrAny(conditions.publisherIds, ctx.publisherId)) return false;
  if (!includesOrAny(conditions.productIds, ctx.productId)) return false;
  if (!includesOrAny(conditions.formats, ctx.format)) return false;
  if (!includesOrAny(conditions.salesChannels, ctx.salesChannel)) return false;
  if (!includesOrAny(conditions.rightsBasis, ctx.rightsBasis)) return false;
  if (!includesOrAny(conditions.promotionTypes, ctx.promotionType)) return false;
  if (!includesOrAny(conditions.promotionFundingSources, ctx.promotionFundingSource)) return false;
  if (!includesOrAny(conditions.distributorIds, ctx.distributorId)) return false;
  if (!includesOrAny(conditions.subscriptionPlanIds, ctx.subscriptionPlanId)) return false;
  const customer = minor(ctx.customerPriceMinor), list = minor(ctx.listPriceMinor);
  if (conditions.minCustomerPriceMinor != null && customer < conditions.minCustomerPriceMinor) return false;
  if (conditions.maxCustomerPriceMinor != null && customer > conditions.maxCustomerPriceMinor) return false;
  if (conditions.minListPriceMinor != null && list < conditions.minListPriceMinor) return false;
  if (conditions.maxListPriceMinor != null && list > conditions.maxListPriceMinor) return false;
  return true;
}

async function contractForContext(db: CatalogDB, ctx: RoyaltyContext) {
  const row = await db.prepare(`SELECT rc.*,rcv.id contract_version_id,rcv.version,rcv.calculation_basis,rcv.fore_commission_bps,rcv.default_royalty_rate_bps,rcv.payment_terms_days,rcv.reserve_bps,rcv.rules_version_hash,rcv.effective_from version_effective_from,rcv.effective_to version_effective_to
    FROM finance_royalty_contracts rc
    JOIN finance_royalty_contract_versions rcv ON rcv.contract_id=rc.id
    JOIN products p ON p.id=?
    JOIN editions e ON e.id=p.edition_id
    WHERE rc.status='active'
      AND (rc.product_id=? OR rc.product_id IS NULL)
      AND (rc.edition_id=e.id OR rc.edition_id IS NULL)
      AND (rc.publisher_id=e.publisher_id OR rc.publisher_id IS NULL)
      AND (rc.territory_code IS NULL OR upper(rc.territory_code)=upper(?))
      AND (rc.format IS NULL OR lower(rc.format)=lower(?))
      AND (rc.sales_channel IS NULL OR lower(rc.sales_channel)=lower(?))
      AND rc.effective_from<=? AND (rc.effective_to IS NULL OR rc.effective_to>?)
      AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?)
    ORDER BY
      CASE WHEN rc.product_id=? THEN 0 WHEN rc.edition_id=e.id THEN 1 WHEN rc.publisher_id=e.publisher_id THEN 2 ELSE 3 END,
      CASE WHEN rc.territory_code IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN rc.format IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN rc.sales_channel IS NOT NULL THEN 0 ELSE 1 END,
      rc.effective_from DESC,rcv.version DESC
    LIMIT 1`).bind(ctx.productId, ctx.productId, ctx.territory, ctx.format, ctx.salesChannel, ctx.occurredAt, ctx.occurredAt, ctx.occurredAt, ctx.occurredAt, ctx.productId).first<any>();
  if (!row) return null;
  const rules = (await db.prepare("SELECT * FROM finance_royalty_rules WHERE contract_version_id=? ORDER BY priority,rule_key").bind(row.contract_version_id).all<any>()).results;
  return { ...row, rules };
}

function defaultAction(contract: any): RoyaltyRuleAction {
  return {
    basis: contract.calculation_basis === "list_price" ? "list_price" : contract.calculation_basis === "customer_price" ? "customer_price" : "net_receipts",
    foreCommissionBps: Number(contract.fore_commission_bps || 0),
    royaltyRateBps: contract.default_royalty_rate_bps == null ? undefined : Number(contract.default_royalty_rate_bps),
    reserveBps: Number(contract.reserve_bps || 0),
    paymentTermsDays: Number(contract.payment_terms_days || 60),
    processorFeeTreatment: "deduct",
    distributorFeeTreatment: "deduct",
    taxTreatment: "deduct",
    foreFundedDiscountTreatment: "add_back",
    publisherFundedDiscountTreatment: "deduct",
  };
}

function calculateEconomics(ctx: RoyaltyContext, action: RoyaltyRuleAction) {
  const list = Math.max(0, minor(ctx.listPriceMinor));
  const customer = Math.max(0, minor(ctx.customerPriceMinor));
  const tax = Math.max(0, minor(ctx.taxMinor));
  const processor = Math.max(0, minor(ctx.processorFeeMinor));
  const distributor = Math.max(0, minor(ctx.distributorFeeMinor));
  const foreFunded = Math.max(0, minor(ctx.foreFundedDiscountMinor));
  const publisherFunded = Math.max(0, minor(ctx.publisherFundedDiscountMinor));
  const grossValue = Math.max(0, minor(ctx.grossValueMinor ?? customer));
  let net = customer;
  if ((action.foreFundedDiscountTreatment || "add_back") === "add_back") net += foreFunded;
  if ((action.publisherFundedDiscountTreatment || "deduct") === "ignore") net += publisherFunded;
  if ((action.taxTreatment || "deduct") === "deduct") net -= tax;
  if ((action.processorFeeTreatment || "deduct") === "deduct") net -= processor;
  if ((action.distributorFeeTreatment || "deduct") === "deduct") net -= distributor;
  net = Math.max(0, net);
  const basisKind = action.basis || "net_receipts";
  const basis = basisKind === "list_price" ? list : basisKind === "customer_price" ? customer : basisKind === "gross_value" ? grossValue : net;
  const qty = Math.max(1, Math.round(Number(ctx.quantity || 1)));
  const flat = Math.max(0, minor(action.flatRoyaltyMinorPerUnit)) * qty;
  let commission = 0, pool = 0;
  if (action.royaltyRateBps != null) {
    pool = Math.max(0, Math.floor(basis * clampBps(action.royaltyRateBps) / 10000) + flat);
    commission = Math.max(0, basis - pool);
  } else {
    commission = Math.floor(basis * clampBps(action.foreCommissionBps, 0) / 10000);
    pool = Math.max(0, basis - commission + flat);
  }
  return { list, customer, tax, processor, distributor, foreFunded, publisherFunded, grossValue, netReceipts: net, basis, commission, pool };
}

async function activeDisputeHold(db: CatalogDB, productId: string) {
  return !!(await db.prepare(`SELECT 1 ok FROM royalty_holds h WHERE h.status='active' AND ((h.scope_type='product' AND h.scope_id=?) OR (h.scope_type='edition' AND h.scope_id=(SELECT edition_id FROM products WHERE id=?)) OR (h.scope_type='publication' AND h.scope_id IN (SELECT id FROM publishing_publications WHERE product_id=?))) LIMIT 1`).bind(productId, productId, productId).first<any>());
}

async function ledger(db: CatalogDB, orderId: string | null, userId: string | null, type: string, account: string, amount: number, currency: string, external: string, metadata: Record<string, unknown> = {}) {
  const existing = await db.prepare("SELECT 1 ok FROM commerce_ledger_entries WHERE COALESCE(order_id,'')=COALESCE(?,'') AND entry_type=? AND account_code=? AND external_reference=? LIMIT 1").bind(orderId, type, account, external).first<any>();
  if (existing) return;
  await db.prepare("INSERT OR IGNORE INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id("led"), orderId, userId, type, account, amount, currency, external, JSON.stringify(metadata), now()).run();
}

export async function calculateAndAccrueRoyalty(db: CatalogDB, ctx: RoyaltyContext) {
  const existing = await db.prepare("SELECT * FROM finance_royalty_calculations WHERE source_type=? AND source_id=? AND product_id=? ORDER BY calculated_at DESC LIMIT 1").bind(ctx.sourceType, ctx.sourceId, ctx.productId).first<any>();
  if (existing) return existing;
  const contract = await contractForContext(db, ctx);
  if (!contract) throw new ApiError(409, `No active royalty contract covers ${ctx.productId} / ${ctx.territory} / ${ctx.salesChannel}.`);
  let chosen: any = null;
  const trace: string[] = [`contract:${contract.id}:v${contract.version}`];
  for (const rule of contract.rules || []) {
    const conditions = safeJson<RoyaltyRuleConditions>(rule.conditions_json, {});
    if (ruleMatches(conditions, ctx)) { chosen = rule; trace.push(`rule:${rule.rule_key}`); break; }
    trace.push(`skip:${rule.rule_key}`);
  }
  const action = { ...defaultAction(contract), ...(chosen ? safeJson<RoyaltyRuleAction>(chosen.action_json, {}) : {}) };
  if (!chosen) trace.push("rule:contract-default");
  const economics = calculateEconomics(ctx, action);
  const rulesCanonical = JSON.stringify((contract.rules || []).map((r: any) => ({ key: r.rule_key, priority: r.priority, conditions: safeJson(r.conditions_json, {}), action: safeJson(r.action_json, {}) })));
  const versionHash = contract.rules_version_hash || await sha256(JSON.stringify({ contractId: contract.id, version: contract.version, defaults: defaultAction(contract), rules: rulesCanonical }));
  const splits = (await db.prepare("SELECT rs.*,fp.withholding_bps,fp.status party_status FROM finance_royalty_splits rs JOIN finance_parties fp ON fp.id=rs.party_id WHERE rs.contract_version_id=? ORDER BY rs.priority,rs.id").bind(contract.contract_version_id).all<any>()).results;
  if (!splits.length) throw new ApiError(409, `Royalty contract version ${contract.contract_version_id} has no payee splits.`);
  const totalShare = splits.reduce((sum: number, s: any) => sum + Number(s.share_bps || 0), 0);
  if (totalShare !== 10000) throw new ApiError(500, `Royalty split must allocate exactly 100% for contract version ${contract.contract_version_id}; found ${totalShare / 100}%.`);

  const calcId = id("roycalc"), calculatedAt = now();
  const snapshot = { context: ctx, economics, action, contract: { id: contract.id, versionId: contract.contract_version_id, version: contract.version }, rule: chosen ? { id: chosen.id, key: chosen.rule_key } : null };
  await db.prepare(`INSERT INTO finance_royalty_calculations(id,source_type,source_id,order_id,order_item_id,usage_event_id,product_id,contract_id,contract_version_id,contract_version_hash,rule_id,territory_code,format,sales_channel,currency,quantity,list_price_minor,customer_price_minor,tax_minor,processor_fee_minor,promotion_discount_minor,fore_funded_discount_minor,publisher_funded_discount_minor,distributor_fee_minor,net_receipts_minor,basis_minor,fore_commission_minor,royalty_pool_minor,rule_trace_json,input_snapshot_json,calculated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(calcId,ctx.sourceType,ctx.sourceId,ctx.orderId||null,ctx.orderItemId||null,ctx.usageEventId||null,ctx.productId,contract.id,contract.contract_version_id,versionHash,chosen?.id||null,ctx.territory.toUpperCase(),ctx.format,ctx.salesChannel,ctx.currency.toUpperCase(),Math.max(1,Math.round(Number(ctx.quantity||1))),economics.list,economics.customer,economics.tax,economics.processor,minor(ctx.promotionDiscountMinor),economics.foreFunded,economics.publisherFunded,economics.distributor,economics.netReceipts,economics.basis,economics.commission,economics.pool,JSON.stringify(trace),JSON.stringify(snapshot),calculatedAt).run();
  const held = await activeDisputeHold(db, ctx.productId);
  const paymentTerms = Math.max(0, Math.min(730, Number(action.paymentTermsDays ?? contract.payment_terms_days ?? 60)));
  const reserveBps = clampBps(action.reserveBps, Number(contract.reserve_bps || 0));
  const occurredMs = Date.parse(ctx.occurredAt);
  const anchorMs = ctx.availabilityAnchorAt ? Date.parse(ctx.availabilityAnchorAt) : occurredMs;
  const availabilityBaseMs = Number.isFinite(anchorMs) ? Math.max(occurredMs, anchorMs) : occurredMs;
  const availableAt = new Date(availabilityBaseMs + paymentTerms * 86400000).toISOString();
  const orderUser = ctx.orderId ? await db.prepare("SELECT user_id FROM commerce_orders WHERE id=?").bind(ctx.orderId).first<any>() : null;
  for (const split of splits) {
    const royalty = Math.floor(economics.pool * clampBps(split.share_bps) / 10000);
    const tax = await effectivePublisherWithholding(db,String(split.party_id),calculatedAt);
    const withholdingBps = tax.taxProfileId ? tax.bps : clampBps(split.withholding_bps);
    const withholding = Math.floor(royalty * clampBps(withholdingBps) / 10000);
    const reserve = Math.floor(royalty * reserveBps / 10000);
    const payable = Math.max(0, royalty - withholding - reserve);
    const status = split.party_status === "hold" || held || !tax.verified ? "held" : "accrued";
    let legacyId: string | null = null;
    if (ctx.orderId && ctx.orderItemId && ["sale","refund","chargeback"].includes(ctx.sourceType)) {
      legacyId = id("roy");
      await db.prepare(`INSERT OR IGNORE INTO finance_royalty_events(id,order_id,order_item_id,contract_version_id,party_id,event_type,basis_minor,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,external_reference,created_at,royalty_calculation_id,sales_channel,territory_code,product_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(legacyId,ctx.orderId,ctx.orderItemId,contract.contract_version_id,split.party_id,ctx.sourceType,economics.basis,royalty,withholding,reserve,payable,ctx.currency,status,availableAt,ctx.sourceId,calculatedAt,calcId,ctx.salesChannel,ctx.territory,ctx.productId).run();
      const persisted = await db.prepare("SELECT id FROM finance_royalty_events WHERE royalty_calculation_id=? AND party_id=? LIMIT 1").bind(calcId,split.party_id).first<any>();
      legacyId = persisted?.id || null;
    }
    await db.prepare(`INSERT INTO finance_royalty_allocations(id,calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,legacy_royalty_event_id,created_at,tax_profile_id,withholding_rule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id("royalloc"),calcId,split.party_id,Number(split.share_bps),royalty,withholding,reserve,payable,ctx.currency.toUpperCase(),status,availableAt,legacyId,calculatedAt,tax.taxProfileId||null,tax.ruleId||null).run();
    const ref = `${calcId}:${split.party_id}`;
    await ledger(db,ctx.orderId||null,orderUser?.user_id||null,"royalty_accrual","royalty_expense",royalty,ctx.currency,ref,{calculationId:calcId,contractVersionId:contract.contract_version_id,partyId:split.party_id,sourceType:ctx.sourceType});
    await ledger(db,ctx.orderId||null,orderUser?.user_id||null,"royalty_accrual",`royalty_payable:${split.party_id}`,-payable,ctx.currency,ref,{calculationId:calcId});
    if (withholding) await ledger(db,ctx.orderId||null,orderUser?.user_id||null,"royalty_withholding","withholding_payable",-withholding,ctx.currency,ref,{calculationId:calcId});
    if (reserve) await ledger(db,ctx.orderId||null,orderUser?.user_id||null,"royalty_reserve","royalty_reserve_liability",-reserve,ctx.currency,ref,{calculationId:calcId});
  }
  return db.prepare("SELECT * FROM finance_royalty_calculations WHERE id=?").bind(calcId).first<any>();
}

export async function accrueSaleRoyaltiesForOrder(db: CatalogDB, orderId: string) {
  const order = await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<any>();
  if (!order) throw new ApiError(404, "Order not found.");
  const items = (await db.prepare(`SELECT oi.*,p.format,e.publisher_id,e.release_status,pd.base_amount_minor,pd.scheduled_amount_minor,pd.promotion_amount_minor,pd.promotion_id,pr.promotion_type pricing_promotion_type,pr.funding_source pricing_funding_source,pr.publisher_funding_bps pricing_publisher_funding_bps,ped.rights_basis,pc.campaign_type checkout_promotion_type,pc.funding_source checkout_funding_source,pc.publisher_funding_bps checkout_publisher_funding_bps,rp.release_at preorder_release_at
    FROM commerce_order_items oi JOIN products p ON p.id=oi.product_id JOIN editions e ON e.id=p.edition_id
    LEFT JOIN pricing_decisions pd ON pd.id=oi.pricing_decision_id LEFT JOIN promotions pr ON pr.id=pd.promotion_id
    LEFT JOIN promotion_campaigns pc ON pc.id=oi.promotion_campaign_id
    LEFT JOIN preorders po ON po.id=oi.preorder_id LEFT JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    LEFT JOIN publishing_publications pub ON pub.id=(SELECT pub2.id FROM publishing_publications pub2 WHERE pub2.product_id=oi.product_id ORDER BY pub2.created_at DESC,pub2.id DESC LIMIT 1)
    LEFT JOIN publishing_submission_snapshots ss ON ss.id=pub.submission_id LEFT JOIN publishing_edition_drafts ped ON ped.id=ss.edition_id
    WHERE oi.order_id=?`).bind(orderId).all<any>()).results;
  const at = order.paid_at || now();
  for (const item of items) {
    const promoDiscount = Number(item.discount_minor || 0) + Number(item.promotion_amount_minor || 0);
    const pricingPromo = Number(item.promotion_amount_minor || 0);
    const pricingPublisherBps = clampBps(item.pricing_publisher_funding_bps, item.pricing_funding_source === "publisher" ? 10000 : item.pricing_funding_source === "fore" ? 0 : 5000);
    const pricingPublisherFunding = Math.floor(pricingPromo * pricingPublisherBps / 10000);
    const pricingCoveFunding = pricingPromo - pricingPublisherFunding;
    const checkoutPublisherFunding = Number(item.publisher_discount_funding_minor || 0);
    const checkoutCoveFunding = Number(item.fore_discount_funding_minor || 0);
    const calc = await calculateAndAccrueRoyalty(db, {
      sourceType: "sale", sourceId: item.id, orderId, orderItemId: item.id, productId: item.product_id, publisherId: item.publisher_id,
      territory: order.territory_code, format: item.format, salesChannel: item.sales_channel || "retail", currency: order.currency, quantity: 1,
      listPriceMinor: Number(item.scheduled_amount_minor ?? item.base_amount_minor ?? item.unit_amount_minor), customerPriceMinor: Math.max(0, Number(item.unit_amount_minor) - Number(item.discount_minor || 0)),
      taxMinor: Number(item.tax_minor || 0), processorFeeMinor: Number(item.processor_fee_minor || 0), promotionDiscountMinor: promoDiscount,
      foreFundedDiscountMinor: pricingCoveFunding + checkoutCoveFunding, publisherFundedDiscountMinor: pricingPublisherFunding + checkoutPublisherFunding,
      distributorFeeMinor: Number(item.distributor_fee_minor || 0), rightsBasis:item.rights_basis||null,promotionType:item.checkout_promotion_type||item.pricing_promotion_type||null,promotionFundingSource:item.checkout_funding_source||item.pricing_funding_source||null,
      occurredAt: at, availabilityAnchorAt: item.fulfillment_type === "preorder" ? item.preorder_release_at || null : null, metadata: { invoiceNumber: order.invoice_number, pricingDecisionId: item.pricing_decision_id || null, promotionCampaignId: item.promotion_campaign_id || null, preorderReleaseAt: item.preorder_release_at || null },
    });
    if (calc) await db.prepare("UPDATE commerce_order_items SET royalty_contract_version_id=?,recognized_revenue_minor=? WHERE id=?").bind(calc.contract_version_id,Number(calc.fore_commission_minor||0),item.id).run();
  }
}

export async function createRoyaltyContractVersion(db: CatalogDB, raw: unknown) {
  const ruleSchema = z.object({
    key: z.string().trim().min(1).max(120), priority: z.number().int().min(0).max(100000).default(100), conditions: z.record(z.string(), z.unknown()).default({}),
    action: z.object({ basis:z.enum(["list_price","customer_price","net_receipts","gross_value"]).optional(), royaltyRateBps:z.number().int().min(0).max(10000).optional(), foreCommissionBps:z.number().int().min(0).max(10000).optional(), flatRoyaltyMinorPerUnit:z.number().int().min(0).optional(), reserveBps:z.number().int().min(0).max(10000).optional(), paymentTermsDays:z.number().int().min(0).max(730).optional(), processorFeeTreatment:z.enum(["deduct","ignore"]).optional(), distributorFeeTreatment:z.enum(["deduct","ignore"]).optional(), taxTreatment:z.enum(["deduct","ignore"]).optional(), foreFundedDiscountTreatment:z.enum(["add_back","ignore"]).optional(), publisherFundedDiscountTreatment:z.enum(["deduct","ignore"]).optional() }).refine(a => a.royaltyRateBps != null || a.foreCommissionBps != null || a.flatRoyaltyMinorPerUnit != null || !!a.basis, "A rule action must change at least one royalty term."),
  });
  const x = z.object({ contractId:z.string().min(1), effectiveFrom:z.string().datetime(), effectiveTo:z.string().datetime().nullable().optional(), basis:z.enum(["list_price","customer_price","net_revenue"]).default("net_revenue"), foreCommissionBps:z.number().int().min(0).max(10000).default(3000), defaultRoyaltyRateBps:z.number().int().min(0).max(10000).nullable().optional(), paymentTermsDays:z.number().int().min(0).max(730).default(60), reserveBps:z.number().int().min(0).max(10000).default(0), notes:z.string().max(2000).default(""), changeReason:z.string().trim().min(1).max(2000).default("Contract terms versioned."), createdByUserId:z.string().max(180).nullable().optional(), supersedesVersionId:z.string().nullable().optional(), splits:z.array(z.object({partyId:z.string().min(1),shareBps:z.number().int().min(0).max(10000)})).min(1), rules:z.array(ruleSchema).default([]) }).parse(raw);
  if (x.effectiveTo && x.effectiveTo <= x.effectiveFrom) throw new ApiError(400,"Contract version end must be after its start.");
  if (x.splits.reduce((s,r)=>s+r.shareBps,0)!==10000) throw new ApiError(400,"Royalty splits must allocate exactly 100%.");
  const contract = await db.prepare("SELECT * FROM finance_royalty_contracts WHERE id=?").bind(x.contractId).first<any>();
  if (!contract) throw new ApiError(404,"Royalty contract not found.");
  const previous = await db.prepare("SELECT id,version FROM finance_royalty_contract_versions WHERE contract_id=? ORDER BY version DESC LIMIT 1").bind(x.contractId).first<any>();
  if(x.supersedesVersionId){
    const target=await db.prepare("SELECT id FROM finance_royalty_contract_versions WHERE id=? AND contract_id=?").bind(x.supersedesVersionId,x.contractId).first<any>();
    if(!target)throw new ApiError(400,"Superseded royalty-contract version does not belong to this contract.");
  }
  const version = Number(previous?.version||0)+1;
  const supersedesVersionId=x.supersedesVersionId||previous?.id||null;
  const versionId = id("rcv"), at = now();
  const canonical = JSON.stringify({contractId:x.contractId,version,supersedesVersionId,effectiveFrom:x.effectiveFrom,effectiveTo:x.effectiveTo||null,basis:x.basis,foreCommissionBps:x.foreCommissionBps,defaultRoyaltyRateBps:x.defaultRoyaltyRateBps??null,paymentTermsDays:x.paymentTermsDays,reserveBps:x.reserveBps,splits:x.splits,rules:x.rules,changeReason:x.changeReason});
  const hash = await sha256(canonical);
  await db.prepare("INSERT INTO finance_royalty_contract_versions(id,contract_id,version,calculation_basis,fore_commission_bps,payment_terms_days,reserve_bps,effective_from,created_at,rules_version_hash,default_royalty_rate_bps,effective_to,notes,supersedes_version_id,created_by_user_id,change_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId,x.contractId,version,x.basis,x.foreCommissionBps,x.paymentTermsDays,x.reserveBps,x.effectiveFrom,at,hash,x.defaultRoyaltyRateBps??null,x.effectiveTo||null,x.notes,supersedesVersionId,x.createdByUserId||null,x.changeReason).run();
  for (const [i,s] of x.splits.entries()) await db.prepare("INSERT INTO finance_royalty_splits(id,contract_version_id,party_id,share_bps,priority,created_at) VALUES(?,?,?,?,?,?)").bind(id("rs"),versionId,s.partyId,s.shareBps,i,at).run();
  const rules = x.rules.length ? x.rules : [{key:"default",priority:100,conditions:{},action:{basis:x.basis==="net_revenue"?"net_receipts":x.basis,foreCommissionBps:x.foreCommissionBps,reserveBps:x.reserveBps,paymentTermsDays:x.paymentTermsDays}}];
  for (const r of rules) await db.prepare("INSERT INTO finance_royalty_rules(id,contract_version_id,rule_key,priority,conditions_json,action_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("rule"),versionId,r.key,r.priority,JSON.stringify(r.conditions),JSON.stringify(r.action),at).run();
  return { contractId:x.contractId, versionId, version, rulesVersionHash:hash };
}

export async function recordUsageEvent(db: CatalogDB, raw: unknown) {
  const x = z.object({ sourceType:z.enum(["subscription_read","subscription_listen","library_loan","library_read","library_listen","wholesale_unit","agency_unit"]), sourceReference:z.string().min(1).max(240), productId:z.string().min(1), userId:z.string().nullable().optional(), territory:z.string().regex(/^[A-Za-z]{2}$/).default("US"), currency:z.string().regex(/^[A-Za-z]{3}$/).default("USD"), units:z.number().min(0).default(0), pagesRead:z.number().int().min(0).default(0), secondsConsumed:z.number().int().min(0).default(0), grossValueMinor:z.number().int().min(0).default(0), poolId:z.string().nullable().optional(), occurredAt:z.string().datetime(), deviceFingerprintHash:z.union([z.literal(""),z.string().min(16).max(128)]).default(""), networkFingerprintHash:z.union([z.literal(""),z.string().min(16).max(128)]).default(""), sessionFingerprintHash:z.union([z.literal(""),z.string().min(16).max(128)]).default(""), metadata:z.record(z.string(),z.unknown()).default({}) }).parse(raw);
  const eventId=id("usage"),at=now();
  await db.prepare(`INSERT OR IGNORE INTO finance_usage_events(id,source_type,source_reference,product_id,user_id,territory_code,currency,units,pages_read,seconds_consumed,gross_value_minor,pool_id,occurred_at,metadata_json,created_at,device_fingerprint_hash,network_fingerprint_hash,session_fingerprint_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(eventId,x.sourceType,x.sourceReference,x.productId,x.userId||null,x.territory.toUpperCase(),x.currency.toUpperCase(),x.units,x.pagesRead,x.secondsConsumed,x.grossValueMinor,x.poolId||null,x.occurredAt,JSON.stringify(x.metadata),at,x.deviceFingerprintHash,x.networkFingerprintHash,x.sessionFingerprintHash).run();
  const persisted=await db.prepare("SELECT * FROM finance_usage_events WHERE source_type=? AND source_reference=?").bind(x.sourceType,x.sourceReference).first<any>();
  return persisted;
}

export async function processUsageEventRoyalty(db: CatalogDB, usageEventId: string) {
  const u=await db.prepare(`SELECT u.*,p.format,e.publisher_id FROM finance_usage_events u JOIN products p ON p.id=u.product_id JOIN editions e ON e.id=p.edition_id WHERE u.id=?`).bind(usageEventId).first<any>();
  if(!u)throw new ApiError(404,"Usage event not found.");
  if(u.processed_at)return{usageEventId,status:"already_processed"};
  const risk=await assessUsageRisk(db,usageEventId);
  if(["hold","block"].includes(risk.action))return{usageEventId,status:"held_for_risk_review",riskAssessmentId:risk.id,riskScore:risk.score};
  const channel=String(u.source_type).startsWith("subscription")?"subscription":String(u.source_type).startsWith("library")?"library":String(u.source_type).startsWith("wholesale")?"wholesale":"agency";
  const quantity=channel==="subscription"?(Number(u.pages_read||0)>0?Number(u.pages_read):Number(u.seconds_consumed||0)>0?Number(u.seconds_consumed):Math.max(1,Number(u.units||0))):Math.max(1,Math.round(Number(u.units||1)));
  const meta=safeJson<any>(u.metadata_json,{});
  const calc=await calculateAndAccrueRoyalty(db,{sourceType:channel as any,sourceId:u.id,usageEventId:u.id,productId:u.product_id,publisherId:u.publisher_id,territory:u.territory_code||"US",format:u.format||"ebook",salesChannel:channel,currency:u.currency||"USD",quantity,grossValueMinor:Number(u.gross_value_minor||0),customerPriceMinor:Number(u.gross_value_minor||0),listPriceMinor:Number(u.gross_value_minor||0),taxMinor:Number(meta.taxMinor||0),processorFeeMinor:Number(meta.processorFeeMinor||0),distributorFeeMinor:Number(meta.distributorFeeMinor||0),rightsBasis:meta.rightsBasis||null,distributorId:meta.distributorId||null,subscriptionPlanId:meta.subscriptionPlanId||null,occurredAt:u.occurred_at,metadata:meta});
  await db.prepare("UPDATE finance_usage_events SET processed_at=? WHERE id=?").bind(now(),u.id).run();
  return{usageEventId:u.id,calculationId:calc?.id,status:"processed"};
}


export async function createUsagePool(db:CatalogDB,raw:unknown){
  const x=z.object({poolType:z.enum(["subscription","library","wholesale"]),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),territory:z.string().regex(/^[A-Za-z]{2}$/).nullable().optional(),currency:z.string().regex(/^[A-Za-z]{3}$/),poolMinor:z.number().int().min(0),metric:z.enum(["units","pages","seconds","weighted"]),rules:z.record(z.string(),z.unknown()).default({})}).parse(raw);
  if(x.periodEnd<=x.periodStart)throw new ApiError(400,"Usage-pool end must be after its start.");const poolId=id("pool"),at=now();
  await db.prepare("INSERT INTO finance_usage_pools(id,pool_type,period_start,period_end,territory_code,currency,pool_minor,metric,status,rules_json,created_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)").bind(poolId,x.poolType,x.periodStart,x.periodEnd,x.territory?.toUpperCase()||null,x.currency.toUpperCase(),x.poolMinor,x.metric,JSON.stringify(x.rules),at).run();return{id:poolId,status:"draft"};
}

export async function allocateUsagePool(db:CatalogDB,poolId:string){
  const pool=await db.prepare("SELECT * FROM finance_usage_pools WHERE id=?").bind(poolId).first<any>();if(!pool)throw new ApiError(404,"Usage pool not found.");if(pool.status==="allocated"||pool.status==="closed")return{poolId,status:pool.status};if(pool.status!=="draft"&&pool.status!=="locked")throw new ApiError(409,"Usage pool cannot be allocated from its current state.");
  const family=pool.pool_type==="subscription"?"subscription_%":pool.pool_type==="library"?"library_%":"wholesale_%";
  const rows=(await db.prepare(`SELECT * FROM finance_usage_events WHERE source_type LIKE ? AND occurred_at>=? AND occurred_at<? AND currency=? AND (? IS NULL OR territory_code=?) AND processed_at IS NULL AND (pool_id IS NULL OR pool_id=?) ORDER BY occurred_at,id`).bind(family,pool.period_start,pool.period_end,pool.currency,pool.territory_code,pool.territory_code,pool.id).all<any>()).results;
  if(!rows.length)throw new ApiError(409,"No unprocessed usage events match this pool.");const rules=safeJson<any>(pool.rules_json,{});
  const weight=(r:any)=>pool.metric==="pages"?Number(r.pages_read||0):pool.metric==="seconds"?Number(r.seconds_consumed||0):pool.metric==="weighted"?(Number(r.units||0)*Number(rules.unitWeight??1)+Number(r.pages_read||0)*Number(rules.pageWeight??0)+Number(r.seconds_consumed||0)*Number(rules.secondWeight??0)):Number(r.units||0);
  const weights=rows.map(weight),total=weights.reduce((a:number,b:number)=>a+b,0);if(total<=0)throw new ApiError(409,"Usage pool has no positive allocation metric.");
  const raw=weights.map((w:number)=>Number(pool.pool_minor)*w/total),alloc=raw.map((v:number)=>Math.floor(v));let remaining=Number(pool.pool_minor)-alloc.reduce((a:number,b:number)=>a+b,0);raw.map((v:number,i:number)=>({i,f:v-Math.floor(v)})).sort((a:any,b:any)=>b.f-a.f||a.i-b.i).forEach((x:any)=>{if(remaining-->0)alloc[x.i]++;});const at=now();
  if(pool.status==="draft")await db.prepare("UPDATE finance_usage_pools SET status='locked',locked_at=? WHERE id=? AND status='draft'").bind(at,pool.id).run();
  for(let i=0;i<rows.length;i++){await db.prepare("UPDATE finance_usage_events SET gross_value_minor=?,pool_id=? WHERE id=? AND processed_at IS NULL").bind(alloc[i],pool.id,rows[i].id).run();await processUsageEventRoyalty(db,rows[i].id);}
  await db.prepare("UPDATE finance_usage_pools SET status='allocated',allocated_at=? WHERE id=?").bind(now(),pool.id).run();return{poolId:pool.id,status:"allocated",events:rows.length,poolMinor:Number(pool.pool_minor),allocatedMinor:alloc.reduce((a:number,b:number)=>a+b,0)};
}
