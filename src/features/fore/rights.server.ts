import { z } from "zod";
import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";

export type SalesChannel = "retail" | "subscription" | "library";
export type PromotionRestrictions = {
  discountsPermitted?: boolean;
  freePromotionsPermitted?: boolean;
  maxDiscountBps?: number;
  minimumCustomerPriceMinor?: number;
  excludedPromotionTypes?: string[];
  requiresRightsholderApproval?: boolean;
  notes?: string;
};
export type RightsDecision = {
  allowed: boolean;
  reasonCode: string;
  grantId: string | null;
  editionId: string;
  productId: string | null;
  territory: string;
  format: string;
  salesChannel: SalesChannel;
  rightsholderName: string;
  licenseType: string;
  drmRequirement: string;
  promotionRestrictions: PromotionRestrictions;
  startsAt: string | null;
  endsAt: string | null;
  subscriptionPermitted: boolean;
  libraryPermitted: boolean;
  contractId: string | null;
  contractVersionId: string | null;
  contractPolicy: Record<string, unknown>;
  contractReference: string;
  exclusivity: string;
  scopeSummary: string;
  languageRights: { contractName?: string; matchMode?: string; editionLanguages?: string[]; permittedLanguages?: string[] };
  sourceEvidenceId: string | null;
  decisionId?: string;
};

type ScopeRule = {
  effect: "include" | "exclude";
  targetType: "territory" | "set" | "historical";
  territoryCode?: string;
  territorySetId?: string;
  historicalCode?: string;
  asOfDate?: string | null;
};

type Conflict = {
  severity: "error" | "warning" | "info";
  code: string;
  grantAId: string;
  grantBId: string;
  editionId: string;
  editionTitle: string;
  format: string;
  channels: string[];
  territories: string[];
  territoryCount: number;
  languages: string[];
  rightsholderA: string;
  rightsholderB: string;
  message: string;
};

const territorySchema = z.string().regex(/^[A-Z]{2}$/);
const channelSchema = z.enum(["retail", "subscription", "library"]);
const now = () => new Date().toISOString();
const STATIC_TERRITORY_ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };

export function normalizeTerritoryCode(value: unknown) {
  const code = String(value || "").trim().toUpperCase();
  const canonical = STATIC_TERRITORY_ALIASES[code] || code;
  if (!/^[A-Z]{2}$/.test(canonical) || ["XX", "T1", "ZZ"].includes(canonical)) throw new ApiError(400, "Use a supported two-letter storefront territory code.");
  return canonical;
}

function parseJsonObject<T extends object>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDrm(value: unknown) { return String(value || "none").trim().toLowerCase().replaceAll("_", "-"); }
function isoAt(value: string | null | undefined) { return value || null; }
function periodsOverlap(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null) {
  return (!aEnd || !bStart || aEnd > bStart) && (!bEnd || !aStart || bEnd > aStart);
}
function channelsForGrant(row: any) {
  const values = new Set<string>([String(row.sales_channel)]);
  if (row.sales_channel === "retail" && Number(row.subscription_permitted)) values.add("subscription");
  if (row.sales_channel === "retail" && Number(row.library_permitted)) values.add("library");
  return values;
}
function intersection<T>(a: Set<T>, b: Set<T>) { return new Set([...a].filter((x) => b.has(x))); }

/** `none` means DRM is optional; `none-only` explicitly requires DRM-free delivery. */
export function drmSatisfiesRequirement(requirement: string, actual: string) {
  const required = normalizeDrm(requirement), delivered = normalizeDrm(actual);
  if (["", "none", "optional", "any"].includes(required)) return true;
  if (required === "none-only" || required === "drm-free") return ["", "none", "drm-free"].includes(delivered);
  if (["required", "drm", "encrypted", "any-drm"].includes(required)) return !["", "none", "drm-free"].includes(delivered);
  if (["watermark", "social-drm"].includes(required)) return ["watermark", "social-drm"].includes(delivered);
  if (["adobe", "adobe-acs", "acs4"].includes(required)) return ["adobe", "adobe-acs", "acs4"].includes(delivered);
  if (["lcp", "readium-lcp"].includes(required)) return ["lcp", "readium-lcp"].includes(delivered);
  return required === delivered;
}

export function promotionPermitted(restrictions: PromotionRestrictions, input: { type?: string | null; baseAmountMinor: number; proposedAmountMinor: number; rightsholderApproved?: boolean }) {
  const type = String(input.type || "").trim().toLowerCase();
  const discount = Math.max(0, input.baseAmountMinor - input.proposedAmountMinor);
  if (!discount) return { allowed: true, reasonCode: "NO_DISCOUNT" };
  if (restrictions.discountsPermitted === false) return { allowed: false, reasonCode: "DISCOUNTS_PROHIBITED" };
  if (input.proposedAmountMinor === 0 && restrictions.freePromotionsPermitted === false) return { allowed: false, reasonCode: "FREE_PROMOTIONS_PROHIBITED" };
  if ((restrictions.excludedPromotionTypes || []).map((x) => x.toLowerCase()).includes(type)) return { allowed: false, reasonCode: "PROMOTION_TYPE_PROHIBITED" };
  if (restrictions.requiresRightsholderApproval && !input.rightsholderApproved) return { allowed: false, reasonCode: "RIGHTSHOLDER_APPROVAL_REQUIRED" };
  if (Number.isFinite(Number(restrictions.minimumCustomerPriceMinor)) && input.proposedAmountMinor < Number(restrictions.minimumCustomerPriceMinor)) return { allowed: false, reasonCode: "MINIMUM_CUSTOMER_PRICE" };
  if (Number.isFinite(Number(restrictions.maxDiscountBps)) && input.baseAmountMinor > 0) {
    const bps = Math.round((discount * 10_000) / input.baseAmountMinor);
    if (bps > Number(restrictions.maxDiscountBps)) return { allowed: false, reasonCode: "MAXIMUM_DISCOUNT_EXCEEDED" };
  }
  return { allowed: true, reasonCode: "PROMOTION_PERMITTED" };
}

export function requestStorefrontTerritory(request: Request, fallback = "US") {
  const platformCountry = String(request.headers.get("cf-ipcountry") || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(platformCountry) && !["XX", "T1", "ZZ"].includes(platformCountry)) return STATIC_TERRITORY_ALIASES[platformCountry] || platformCountry;
  try { return normalizeTerritoryCode(fallback); } catch { return "US"; }
}

async function canonicalTerritoryFromDb(db: CatalogDB, raw: string) {
  const code = normalizeTerritoryCode(raw);
  const alias = await db.prepare("SELECT territory_code FROM territory_aliases WHERE alias_code=?").bind(code).first<any>();
  const canonical = alias?.territory_code ? String(alias.territory_code) : code;
  const row = await db.prepare("SELECT code,is_sellable FROM territories WHERE code=?").bind(canonical).first<any>();
  if (!row || !Number(row.is_sellable)) throw new ApiError(400, `Unsupported storefront territory: ${canonical}.`);
  return canonical;
}

async function expandHistoricalCode(db: CatalogDB, historicalCode: string, asOfDate?: string | null) {
  const code = String(historicalCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new ApiError(400, `Invalid historical territory code: ${historicalCode}.`);
  const rows = await db.prepare(`SELECT * FROM territory_historical_entities WHERE historical_code=? ORDER BY valid_from`).bind(code).all<any>();
  let entities = rows.results;
  if (asOfDate) entities = entities.filter((r) => (!r.valid_from || String(r.valid_from) <= asOfDate) && (!r.valid_to || String(r.valid_to) >= asOfDate));
  if (!entities.length) throw new ApiError(400, `No historical mapping exists for ${code}${asOfDate ? ` at ${asOfDate}` : ""}.`);
  if (entities.length > 1) throw new ApiError(400, `Historical code ${code} is ambiguous. Supply an as-of date to identify the historical entity.`);
  const successors = await db.prepare("SELECT territory_code FROM territory_historical_successors WHERE historical_entity_id=? ORDER BY territory_code").bind(entities[0].id).all<any>();
  if (!successors.results.length) throw new ApiError(400, `Historical territory ${code} has no configured modern successor markets.`);
  return successors.results.map((r) => String(r.territory_code));
}

async function setMembers(db: CatalogDB, setId: string) {
  const set = await db.prepare("SELECT id,status FROM territory_sets WHERE id=?").bind(setId).first<any>();
  if (!set || set.status !== "active") throw new ApiError(400, "Unknown or inactive territory set.");
  const rows = await db.prepare("SELECT territory_code FROM territory_set_members WHERE set_id=? ORDER BY territory_code").bind(setId).all<any>();
  return rows.results.map((r) => String(r.territory_code));
}

async function expandScopeRules(db: CatalogDB, rules: ScopeRule[]) {
  const included = new Set<string>(), excluded = new Set<string>();
  const apply = async (rule: ScopeRule, target: Set<string>) => {
    if (rule.targetType === "territory") target.add(await canonicalTerritoryFromDb(db, String(rule.territoryCode || "")));
    else if (rule.targetType === "set") for (const code of await setMembers(db, String(rule.territorySetId || ""))) target.add(code);
    else for (const code of await expandHistoricalCode(db, String(rule.historicalCode || ""), rule.asOfDate || null)) target.add(code);
  };
  for (const rule of rules.filter((r) => r.effect === "include")) await apply(rule, included);
  for (const rule of rules.filter((r) => r.effect === "exclude")) await apply(rule, excluded);
  for (const code of excluded) included.delete(code);
  if (!included.size) throw new ApiError(400, "Territory expression resolves to zero sellable markets.");
  return [...included].sort();
}

const scopeRuleSchema = z.object({
  effect: z.enum(["include", "exclude"]), targetType: z.enum(["territory", "set", "historical"]),
  territoryCode: z.string().max(2).optional(), territorySetId: z.string().max(180).optional(), historicalCode: z.string().max(2).optional(), asOfDate: z.string().nullable().optional(),
}).strict();

async function grantScopeFromInput(db: CatalogDB, x: any): Promise<{ rules: ScopeRule[]; territories: string[]; summary: string; legacyCode: string }> {
  const mode = String(x.scopeMode || "single");
  let rules: ScopeRule[] = [];
  if (Array.isArray(x.scopeRules) && x.scopeRules.length) rules = x.scopeRules;
  else if (mode === "single") rules = [{ effect: "include", targetType: "territory", territoryCode: x.territory || "US" }];
  else if (mode === "set") rules = [{ effect: "include", targetType: "set", territorySetId: x.territorySetId }];
  else if (mode === "worldwide") rules = [{ effect: "include", targetType: "set", territorySetId: "rset_world" }];
  else if (mode !== "expression") throw new ApiError(400, "Unknown territory scope mode.");
  for (const code of x.includeTerritories || []) rules.push({ effect: "include", targetType: "territory", territoryCode: code });
  for (const setId of x.includeSetIds || []) rules.push({ effect: "include", targetType: "set", territorySetId: setId });
  for (const h of x.includeHistorical || []) rules.push({ effect: "include", targetType: "historical", historicalCode: h.code, asOfDate: h.asOfDate || null });
  for (const code of x.excludeTerritories || []) rules.push({ effect: "exclude", targetType: "territory", territoryCode: code });
  for (const setId of x.excludeSetIds || []) rules.push({ effect: "exclude", targetType: "set", territorySetId: setId });
  for (const h of x.excludeHistorical || []) rules.push({ effect: "exclude", targetType: "historical", historicalCode: h.code, asOfDate: h.asOfDate || null });
  rules = z.array(scopeRuleSchema).min(1).max(500).parse(rules) as ScopeRule[];
  const territories = await expandScopeRules(db, rules);
  const includes = rules.filter((r) => r.effect === "include").map((r) => r.targetType === "territory" ? String(r.territoryCode).toUpperCase() : r.targetType === "set" ? `@${r.territorySetId}` : `#${String(r.historicalCode).toUpperCase()}`);
  const excludes = rules.filter((r) => r.effect === "exclude").map((r) => r.targetType === "territory" ? String(r.territoryCode).toUpperCase() : r.targetType === "set" ? `@${r.territorySetId}` : `#${String(r.historicalCode).toUpperCase()}`);
  const summary = `${includes.join(" + ")}${excludes.length ? ` − ${excludes.join(" − ")}` : ""} (${territories.length} market${territories.length === 1 ? "" : "s"})`;
  const direct = rules.length === 1 && rules[0].effect === "include" && rules[0].targetType === "territory";
  return { rules, territories, summary, legacyCode: direct ? territories[0] : "ZZ" };
}

async function languageEligibility(db: CatalogDB, rows: any[], input: { editionId: string; format: string; salesChannel: SalesChannel; at: string }) {
  if (!rows.length) return [];
  const langs = (await db.prepare("SELECT lower(language_code) language_code FROM edition_languages WHERE edition_id=? AND kind='content'").bind(input.editionId).all<any>()).results.map((r) => String(r.language_code));
  const contractIds = [...new Set(rows.map((r) => r.contract_id).filter(Boolean).map(String))];
  const rulesByContract = new Map<string, any[]>();
  if (contractIds.length) {
    const placeholders = contractIds.map(() => "?").join(",");
    const rules = await db.prepare(`SELECT * FROM rights_contract_languages WHERE contract_id IN (${placeholders})`).bind(...contractIds).all<any>();
    for (const rule of rules.results) { const a = rulesByContract.get(String(rule.contract_id)) || []; a.push(rule); rulesByContract.set(String(rule.contract_id), a); }
  }
  return rows.filter((row) => {
    if (!row.contract_id) { row._edition_languages = langs; row._permitted_languages = langs; return true; }
    if (String(row.contract_status || "") !== "active") { row._language_reason = "CONTRACT_INACTIVE"; return false; }
    if (row.contract_effective_from && String(row.contract_effective_from) > input.at) { row._language_reason = "CONTRACT_NOT_STARTED"; return false; }
    if (row.contract_effective_to && String(row.contract_effective_to) <= input.at) { row._language_reason = "CONTRACT_EXPIRED"; return false; }
    const scoped = (rulesByContract.get(String(row.contract_id)) || []).filter((rule) =>
      (!rule.format || String(rule.format).toLowerCase() === input.format.toLowerCase()) &&
      (!rule.sales_channel || String(rule.sales_channel) === input.salesChannel) &&
      (!rule.starts_at || String(rule.starts_at) <= input.at) && (!rule.ends_at || String(rule.ends_at) > input.at));
    const denied = new Set(scoped.filter((r) => r.decision === "deny").map((r) => String(r.language_code).toLowerCase()));
    if (langs.some((l) => denied.has(l))) { row._language_reason = "LANGUAGE_EXPLICIT_DENY"; return false; }
    const allows = new Set(scoped.filter((r) => r.decision === "allow").map((r) => String(r.language_code).toLowerCase()));
    row._edition_languages = langs;
    row._permitted_languages = allows.size ? [...allows] : langs;
    if (!allows.size) return true;
    if (!langs.length) { row._language_reason = "EDITION_LANGUAGE_UNKNOWN"; return false; }
    const ok = String(row.language_match_mode || "all") === "any" ? langs.some((l) => allows.has(l)) : langs.every((l) => allows.has(l));
    if (!ok) row._language_reason = "LANGUAGE_RIGHTS_UNAVAILABLE";
    return ok;
  });
}

async function activeGrantRows(db: CatalogDB, input: { editionId: string; format: string; territory: string; salesChannel: SalesChannel; at: string }) {
  const rows = await db.prepare(`SELECT rg.*,COALESCE(rp.display_name,pub.name,'') rightsholder_name,
      rc.name contract_name,rc.reference_code contract_reference_code,rc.status contract_status,rc.effective_from contract_effective_from,rc.effective_to contract_effective_to,rc.language_match_mode
    FROM rights_grants rg
    JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id AND upper(rgt.territory_code)=?
    LEFT JOIN rights_parties rp ON rp.id=rg.rightsholder_party_id
    LEFT JOIN publishers pub ON pub.id=rg.rightsholder_id
    LEFT JOIN rights_contracts rc ON rc.id=rg.contract_id
    WHERE rg.edition_id=? AND lower(rg.format)=lower(?) AND rg.status='active'
      AND (rg.starts_at IS NULL OR rg.starts_at<=?) AND (rg.ends_at IS NULL OR rg.ends_at>?)
      AND (rg.sales_channel=? OR (?='subscription' AND rg.sales_channel='retail' AND rg.subscription_permitted=1) OR (?='library' AND rg.sales_channel='retail' AND rg.library_permitted=1))
    ORDER BY CASE WHEN rg.decision='deny' THEN 0 ELSE 1 END,CASE WHEN rg.sales_channel=? THEN 0 ELSE 1 END,COALESCE(rg.starts_at,rg.created_at) DESC,rg.created_at DESC`).bind(
    input.territory,input.editionId,input.format,input.at,input.at,input.salesChannel,input.salesChannel,input.salesChannel,input.salesChannel,
  ).all<any>();
  const eligible = await languageEligibility(db, rows.results, input);
  return { all: rows.results, eligible };
}

type ContractResolution = { allowed: boolean; reasonCode: string; versionId: string | null; drmRequirement: string; policy: Record<string, unknown> };

async function resolveContractPolicyForGrant(db: CatalogDB, row: any, input: { territory: string; format: string; salesChannel: SalesChannel; at: string; actualDrm: string }) : Promise<ContractResolution> {
  if (!row.contract_id) return { allowed:true, reasonCode:"NO_CONTRACT", versionId:null, drmRequirement:String(row.drm_requirement || "none"), policy:{} };
  let version:any = null;
  if (row.contract_version_id) version = await db.prepare("SELECT * FROM rights_contract_versions WHERE id=? AND contract_id=?").bind(row.contract_version_id,row.contract_id).first<any>();
  else version = await db.prepare("SELECT * FROM rights_contract_versions WHERE contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY effective_from DESC,version_number DESC LIMIT 1").bind(row.contract_id,input.at,input.at).first<any>();
  if (!version) {
    const count = await db.prepare("SELECT count(*) n FROM rights_contract_versions WHERE contract_id=?").bind(row.contract_id).first<any>();
    if (!Number(count?.n || 0)) return { allowed:true, reasonCode:"LEGACY_CONTRACT", versionId:null, drmRequirement:String(row.drm_requirement || "none"), policy:{ legacy:true } };
    return { allowed:false, reasonCode:"CONTRACT_VERSION_INACTIVE", versionId:null, drmRequirement:String(row.drm_requirement || "none"), policy:{} };
  }
  if (String(version.status)!=="active" || String(version.effective_from)>input.at || (version.effective_to && String(version.effective_to)<=input.at)) return { allowed:false, reasonCode:"CONTRACT_VERSION_INACTIVE", versionId:String(version.id), drmRequirement:String(row.drm_requirement || "none"), policy:{} };
  const [territory,territoryCount,format,formatCount,channel,channelCount] = await Promise.all([
    db.prepare("SELECT * FROM rights_contract_version_territories WHERE contract_version_id=? AND territory_code=?").bind(version.id,input.territory).first<any>(),
    db.prepare("SELECT count(*) n FROM rights_contract_version_territories WHERE contract_version_id=?").bind(version.id).first<any>(),
    db.prepare("SELECT * FROM rights_contract_version_formats WHERE contract_version_id=? AND lower(format)=lower(?)").bind(version.id,input.format).first<any>(),
    db.prepare("SELECT count(*) n FROM rights_contract_version_formats WHERE contract_version_id=?").bind(version.id).first<any>(),
    db.prepare("SELECT * FROM rights_contract_version_channels WHERE contract_version_id=? AND sales_channel=?").bind(version.id,input.salesChannel).first<any>(),
    db.prepare("SELECT count(*) n FROM rights_contract_version_channels WHERE contract_version_id=?").bind(version.id).first<any>(),
  ]);
  const policy:Record<string,unknown> = {
    versionNumber:Number(version.version_number), effectiveFrom:version.effective_from, effectiveTo:version.effective_to || null,
    retailerCommissionBps:Number(version.retailer_commission_bps), paymentSchedule:parseJsonObject(version.payment_schedule_json,{}), returnsPolicy:parseJsonObject(version.returns_policy_json,{}),
    subscriptionTerms:parseJsonObject(version.subscription_terms_json,{}), marketingPermissions:parseJsonObject(version.marketing_permissions_json,{}), deliveryRules:parseJsonObject(version.delivery_rules_json,{}),
    terminationPolicy:parseJsonObject(version.termination_policy_json,{}), postTerminationAccessPolicy:String(version.post_termination_access_policy),
    formatPolicy:format ? { drmRequirement:String(format.drm_requirement||"none"),downloadLimit:format.download_limit==null?null:Number(format.download_limit),deviceLimit:format.device_limit==null?null:Number(format.device_limit),offlinePermitted:!!format.offline_permitted } : {},
    channelTerms:channel ? parseJsonObject(channel.terms_json,{}) : {},
  };
  if (Number(territoryCount?.n||0)>0 && (!territory || String(territory.decision)!=="allow")) return {allowed:false,reasonCode:"CONTRACT_TERRITORY_DENIED",versionId:String(version.id),drmRequirement:String(format?.drm_requirement||row.drm_requirement||"none"),policy};
  if (Number(formatCount?.n||0)>0 && (!format || String(format.decision)!=="allow")) return {allowed:false,reasonCode:"CONTRACT_FORMAT_DENIED",versionId:String(version.id),drmRequirement:String(row.drm_requirement||"none"),policy};
  if (Number(channelCount?.n||0)>0 && (!channel || !Number(channel.permitted))) return {allowed:false,reasonCode:"CONTRACT_CHANNEL_DENIED",versionId:String(version.id),drmRequirement:String(format?.drm_requirement||row.drm_requirement||"none"),policy};
  const subscriptionTerms = parseJsonObject<any>(version.subscription_terms_json,{});
  if (input.salesChannel==="subscription" && subscriptionTerms.permitted===false) return {allowed:false,reasonCode:"CONTRACT_SUBSCRIPTION_PROHIBITED",versionId:String(version.id),drmRequirement:String(format?.drm_requirement||row.drm_requirement||"none"),policy};
  const globalDrm=parseJsonObject<any>(version.drm_requirements_json,{}), required=String(format?.drm_requirement || globalDrm[input.format] || globalDrm.default || row.drm_requirement || "none");
  if (!drmSatisfiesRequirement(required,input.actualDrm)) return {allowed:false,reasonCode:"CONTRACT_DRM_REQUIREMENT_UNMET",versionId:String(version.id),drmRequirement:required,policy};
  return {allowed:true,reasonCode:"CONTRACT_ACTIVE",versionId:String(version.id),drmRequirement:required,policy};
}

function emptyDecision(raw: { editionId: string; productId?: string | null; format: string; territory: string; salesChannel: SalesChannel }, reasonCode: string): RightsDecision {
  return { allowed:false,reasonCode,grantId:null,editionId:raw.editionId,productId:raw.productId||null,territory:raw.territory,format:raw.format,salesChannel:raw.salesChannel,rightsholderName:"",licenseType:"",drmRequirement:"none",promotionRestrictions:{},startsAt:null,endsAt:null,subscriptionPermitted:false,libraryPermitted:false,contractId:null,contractVersionId:null,contractPolicy:{},contractReference:"",exclusivity:"nonexclusive",scopeSummary:"",languageRights:{},sourceEvidenceId:null };
}

export async function resolveRightsDecision(db: CatalogDB, raw: { editionId: string; productId?: string | null; format: string; territory: string; salesChannel?: SalesChannel; at?: string; actualDrm?: string; persist?: boolean; context?: Record<string, unknown> }): Promise<RightsDecision> {
  const territory = territorySchema.parse(await canonicalTerritoryFromDb(db, raw.territory));
  const salesChannel = channelSchema.parse(raw.salesChannel || "retail"), at = raw.at || now();
  const rows = await activeGrantRows(db,{editionId:raw.editionId,format:raw.format,territory,salesChannel,at});
  const denied = rows.eligible.find((row) => String(row.decision) === "deny");
  const selected = denied || rows.eligible.find((row) => String(row.decision) === "allow");
  let decision: RightsDecision;
  if (!selected) {
    const languageBlocked = rows.all.length > 0 && rows.eligible.length === 0;
    const reason = languageBlocked ? String(rows.all.find((r) => r._language_reason)?._language_reason || "LANGUAGE_RIGHTS_UNAVAILABLE") : "NO_ACTIVE_GRANT";
    decision = emptyDecision({editionId:raw.editionId,productId:raw.productId,format:raw.format,territory,salesChannel},reason);
  } else {
    const restrictions = parseJsonObject<PromotionRestrictions>(selected.promotion_restrictions_json,{});
    const deniedByGrant = String(selected.decision) === "deny";
    const grantDrmOk = deniedByGrant ? false : drmSatisfiesRequirement(String(selected.drm_requirement || "none"),String(raw.actualDrm || "none"));
    const contract = deniedByGrant ? {allowed:false,reasonCode:"EXPLICIT_DENY",versionId:selected.contract_version_id?String(selected.contract_version_id):null,drmRequirement:String(selected.drm_requirement||"none"),policy:{}} : await resolveContractPolicyForGrant(db,selected,{territory,format:raw.format,salesChannel,at,actualDrm:String(raw.actualDrm||"none")});
    const allowed = !deniedByGrant && grantDrmOk && contract.allowed;
    decision = {
      allowed,
      reasonCode: deniedByGrant ? "EXPLICIT_DENY" : !grantDrmOk ? "DRM_REQUIREMENT_UNMET" : !contract.allowed ? contract.reasonCode : "ACTIVE_GRANT",
      grantId:String(selected.id),editionId:raw.editionId,productId:raw.productId||null,territory,format:raw.format,salesChannel,
      rightsholderName:String(selected.rightsholder_name||""),licenseType:String(selected.license_type||""),drmRequirement:String(selected.drm_requirement||"none"),promotionRestrictions:restrictions,
      startsAt:selected.starts_at?String(selected.starts_at):null,endsAt:selected.ends_at?String(selected.ends_at):null,subscriptionPermitted:!!selected.subscription_permitted,libraryPermitted:!!selected.library_permitted,
      contractId:selected.contract_id?String(selected.contract_id):null,contractVersionId:contract.versionId,contractPolicy:contract.policy,contractReference:String(selected.contract_reference_code||selected.contract_reference||""),exclusivity:String(selected.exclusivity||"nonexclusive"),scopeSummary:String(selected.scope_summary||""),
      languageRights:{contractName:selected.contract_name?String(selected.contract_name):undefined,matchMode:selected.language_match_mode?String(selected.language_match_mode):undefined,editionLanguages:selected._edition_languages||[],permittedLanguages:selected._permitted_languages||[]},
      sourceEvidenceId:selected.source_evidence_id?String(selected.source_evidence_id):null,
    };
  }
  if (raw.persist) {
    const id=`rights_${crypto.randomUUID()}`;
    await db.prepare(`INSERT INTO rights_decisions(id,product_id,edition_id,grant_id,territory_code,format,sales_channel,decision,reason_code,rightsholder_name,license_type,drm_requirement,promotion_restrictions_json,context_json,evaluated_at,contract_id,scope_summary,exclusivity,language_rights_json,source_evidence_id,contract_version_id,contract_policy_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,decision.productId,decision.editionId,decision.grantId,decision.territory,decision.format,decision.salesChannel,decision.allowed?"allow":"deny",decision.reasonCode,decision.rightsholderName,decision.licenseType,decision.drmRequirement,JSON.stringify(decision.promotionRestrictions),JSON.stringify(raw.context||{}),at,decision.contractId,decision.scopeSummary,decision.exclusivity,JSON.stringify(decision.languageRights),decision.sourceEvidenceId,decision.contractVersionId,JSON.stringify(decision.contractPolicy||{})).run();
    decision.decisionId=id;
  }
  return decision;
}

export async function resolveProductRights(db: CatalogDB, productId: string, territory: string, options: { salesChannel?: SalesChannel; at?: string; persist?: boolean; context?: Record<string, unknown> } = {}) {
  const canonical = normalizeTerritoryCode(territory);
  const product = await db.prepare(`SELECT p.id,p.edition_id,p.format,p.storefront_status,e.release_status,e.drm_status edition_drm,
      COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none') actual_drm
    FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?`).bind(productId).first<any>();
  if (!product || String(product.storefront_status) !== "active") return emptyDecision({editionId:product?.edition_id||"",productId,territory:canonical,format:product?.format||"",salesChannel:options.salesChannel||"retail"},"PRODUCT_INACTIVE");
  return resolveRightsDecision(db,{editionId:String(product.edition_id),productId,format:String(product.format),territory:canonical,salesChannel:options.salesChannel||"retail",at:options.at,actualDrm:String(product.actual_drm||"none"),persist:options.persist,context:options.context});
}

const restrictionsSchema = z.object({
  discountsPermitted:z.boolean().optional(),freePromotionsPermitted:z.boolean().optional(),maxDiscountBps:z.number().int().min(0).max(10000).optional(),minimumCustomerPriceMinor:z.number().int().min(0).optional(),excludedPromotionTypes:z.array(z.string().trim().min(1).max(80)).max(50).optional(),requiresRightsholderApproval:z.boolean().optional(),notes:z.string().max(1000).optional(),
}).strict();

export async function upsertRightsParty(db: CatalogDB, raw: unknown) {
  const x=z.object({id:z.string().max(160).optional(),displayName:z.string().trim().min(1).max(200),partyType:z.enum(["publisher","author","agent","distributor","estate","licensor","other"]).default("publisher"),publisherId:z.string().max(160).nullable().optional(),contributorId:z.string().max(160).nullable().optional(),contactEmail:z.string().email().or(z.literal("")).default(""),referenceCode:z.string().max(160).default(""),status:z.enum(["active","inactive"]).default("active")}).parse(raw),id=x.id||`rparty_${crypto.randomUUID()}`,at=now();
  await db.prepare(`INSERT INTO rights_parties(id,display_name,party_type,publisher_id,contributor_id,contact_email,reference_code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,party_type=excluded.party_type,publisher_id=excluded.publisher_id,contributor_id=excluded.contributor_id,contact_email=excluded.contact_email,reference_code=excluded.reference_code,status=excluded.status,updated_at=excluded.updated_at`).bind(id,x.displayName,x.partyType,x.publisherId||null,x.contributorId||null,x.contactEmail,x.referenceCode,x.status,at,at).run();
  return{id};
}

async function rebuildAllTerritorySets(db: CatalogDB) {
  const [setsResult,rulesResult,territoriesResult,histResult,succResult] = await Promise.all([
    db.prepare("SELECT * FROM territory_sets WHERE status='active'").all<any>(), db.prepare("SELECT * FROM territory_set_rules ORDER BY position,id").all<any>(),
    db.prepare("SELECT code FROM territories WHERE is_sellable=1 ORDER BY code").all<any>(), db.prepare("SELECT * FROM territory_historical_entities").all<any>(), db.prepare("SELECT * FROM territory_historical_successors").all<any>(),
  ]);
  const sets = new Map(setsResult.results.map((r) => [String(r.id),r] as const)), rules = rulesResult.results;
  const allTerritories = new Set(territoriesResult.results.map((r) => String(r.code)));
  const successors = new Map<string,string[]>(); for (const r of succResult.results) { const a=successors.get(String(r.historical_entity_id))||[];a.push(String(r.territory_code));successors.set(String(r.historical_entity_id),a); }
  const memo = new Map<string,Set<string>>(), visiting = new Set<string>();
  const histExpand = (code:string,asOf:string|null) => {
    let entities=histResult.results.filter((r:any)=>String(r.historical_code)===code);
    if(asOf)entities=entities.filter((r:any)=>(!r.valid_from||String(r.valid_from)<=asOf)&&(!r.valid_to||String(r.valid_to)>=asOf));
    if(entities.length!==1)throw new ApiError(400,entities.length?`Historical code ${code} is ambiguous; set an as-of date.`:`No historical mapping for ${code}.`);
    return new Set(successors.get(String(entities[0].id))||[]);
  };
  const compute=(id:string):Set<string>=>{
    if(memo.has(id))return new Set(memo.get(id)!); if(visiting.has(id))throw new ApiError(400,"Territory sets contain a circular reference.");
    const set=sets.get(id);if(!set)throw new ApiError(400,`Unknown territory set ${id}.`);visiting.add(id);
    if(set.set_type==="worldwide"){const out=new Set(allTerritories);memo.set(id,out);visiting.delete(id);return new Set(out);}
    const own=rules.filter((r:any)=>String(r.set_id)===id),inc=new Set<string>(),exc=new Set<string>();
    const expand=(r:any)=>r.target_type==="territory"?new Set([STATIC_TERRITORY_ALIASES[String(r.territory_code)]||String(r.territory_code)]):r.target_type==="set"?compute(String(r.target_set_id)):histExpand(String(r.historical_code),set.as_of_date?String(set.as_of_date):null);
    for(const r of own.filter((r:any)=>r.effect==="include"))for(const c of expand(r))inc.add(c);
    for(const r of own.filter((r:any)=>r.effect==="exclude"))for(const c of expand(r))exc.add(c);
    for(const c of exc)inc.delete(c); for(const c of [...inc])if(!allTerritories.has(c))inc.delete(c);
    memo.set(id,inc);visiting.delete(id);return new Set(inc);
  };
  for(const id of sets.keys())compute(id);
  const statements:any[]=[db.prepare("DELETE FROM territory_set_members")],at=now();
  for(const [setId,members] of memo){const codes=[...members].sort();for(let i=0;i<codes.length;i+=80){const chunk=codes.slice(i,i+80);if(!chunk.length)continue;const values=chunk.map(()=>"(?,?,?,?)").join(",");const st=db.prepare(`INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at) VALUES ${values}`);const binds:any[]=[];for(const code of chunk)binds.push(setId,code,`resolved:${setId}`,at);statements.push(st.bind(...binds));}}
  await db.batch(statements); return memo;
}

export async function upsertTerritorySet(db: CatalogDB, raw: unknown) {
  const x=z.object({id:z.string().max(180).optional(),code:z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_]+$/).transform(v=>v.toUpperCase()),name:z.string().trim().min(1).max(200),setType:z.enum(["custom","region","market"]).default("custom"),description:z.string().max(2000).default(""),status:z.enum(["active","inactive","archived"]).default("active"),asOfDate:z.string().nullable().optional(),rules:z.array(scopeRuleSchema).max(600).default([])}).parse(raw);
  const id=x.id||`rset_${crypto.randomUUID()}`,at=now();
  if(x.id){const existing=await db.prepare("SELECT is_system FROM territory_sets WHERE id=?").bind(id).first<any>();if(existing&&Number(existing.is_system))throw new ApiError(400,"System territory sets are versioned fixtures and cannot be edited. Create a custom set instead.");}
  const statements:any[]=[db.prepare(`INSERT INTO territory_sets(id,code,name,set_type,description,status,is_system,as_of_date,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,set_type=excluded.set_type,description=excluded.description,status=excluded.status,as_of_date=excluded.as_of_date,updated_at=excluded.updated_at`).bind(id,x.code,x.name,x.setType,x.description,x.status,x.asOfDate||null,at,at),db.prepare("DELETE FROM territory_set_rules WHERE set_id=?").bind(id)];
  x.rules.forEach((r,i)=>statements.push(db.prepare(`INSERT INTO territory_set_rules(id,set_id,effect,target_type,territory_code,target_set_id,historical_code,position,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(`tsr_${crypto.randomUUID()}`,id,r.effect,r.targetType,r.territoryCode?normalizeTerritoryCode(r.territoryCode):null,r.territorySetId||null,r.historicalCode?String(r.historicalCode).toUpperCase():null,i,at)));
  await db.batch(statements); const memo=await rebuildAllTerritorySets(db),members=[...(memo.get(id)||new Set<string>())].sort();
  await db.prepare("INSERT INTO rights_configuration_audit(id,entity_type,entity_id,action,snapshot_json,recorded_at) VALUES(?,?,?,?,?,?)").bind(`rca_${crypto.randomUUID()}`,"territory-set",id,x.id?"update":"insert",JSON.stringify({...x,resolvedTerritories:members}),at).run();
  return{id,code:x.code,memberCount:members.length,members};
}

export async function upsertRightsContract(db: CatalogDB, raw: unknown) {
  const languageRule=z.object({languageCode:z.string().trim().min(2).max(35).transform(v=>v.toLowerCase()),decision:z.enum(["allow","deny"]).default("allow"),format:z.string().max(40).nullable().optional(),salesChannel:channelSchema.nullable().optional(),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional(),notes:z.string().max(500).default("")});
  const x=z.object({id:z.string().max(180).optional(),referenceCode:z.string().trim().min(1).max(200),name:z.string().trim().min(1).max(240),rightsholderPartyId:z.string().max(180).nullable().optional(),status:z.enum(["draft","active","suspended","expired","terminated"]).default("active"),effectiveFrom:z.string().datetime().nullable().optional(),effectiveTo:z.string().datetime().nullable().optional(),languageMatchMode:z.enum(["any","all"]).default("all"),source:z.string().max(120).default("operator"),notes:z.string().max(2000).default(""),languages:z.array(languageRule).max(250).default([])}).parse(raw);
  if(x.effectiveFrom&&x.effectiveTo&&x.effectiveTo<=x.effectiveFrom)throw new ApiError(400,"Contract end date must be after its start date.");
  if(x.rightsholderPartyId){const party=await db.prepare("SELECT id FROM rights_parties WHERE id=? AND status='active'").bind(x.rightsholderPartyId).first<any>();if(!party)throw new ApiError(400,"Unknown or inactive contract rightsholder.");}
  const id=x.id||`rcontract_${crypto.randomUUID()}`,at=now(),before=x.id?await db.prepare("SELECT created_at FROM rights_contracts WHERE id=?").bind(id).first<any>():null;
  const statements:any[]=[db.prepare(`INSERT INTO rights_contracts(id,reference_code,name,rightsholder_party_id,status,effective_from,effective_to,language_match_mode,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reference_code=excluded.reference_code,name=excluded.name,rightsholder_party_id=excluded.rightsholder_party_id,status=excluded.status,effective_from=excluded.effective_from,effective_to=excluded.effective_to,language_match_mode=excluded.language_match_mode,source=excluded.source,notes=excluded.notes,updated_at=excluded.updated_at`).bind(id,x.referenceCode,x.name,x.rightsholderPartyId||null,x.status,x.effectiveFrom||null,x.effectiveTo||null,x.languageMatchMode,x.source,x.notes,before?.created_at||at,at),db.prepare("DELETE FROM rights_contract_languages WHERE contract_id=?").bind(id)];
  x.languages.forEach((r)=>{if(r.startsAt&&r.endsAt&&r.endsAt<=r.startsAt)throw new ApiError(400,`Language-right end date must follow its start for ${r.languageCode}.`);statements.push(db.prepare(`INSERT INTO rights_contract_languages(id,contract_id,language_code,decision,format,sales_channel,starts_at,ends_at,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(`rclang_${crypto.randomUUID()}`,id,r.languageCode,r.decision,r.format||null,r.salesChannel||null,r.startsAt||null,r.endsAt||null,r.notes,at));});
  statements.push(db.prepare("INSERT INTO rights_configuration_audit(id,entity_type,entity_id,action,snapshot_json,recorded_at) VALUES(?,?,?,?,?,?)").bind(`rca_${crypto.randomUUID()}`,"contract",id,x.id?"update":"insert",JSON.stringify(x),at));
  await db.batch(statements); return{id,conflicts:await detectRightsConflicts(db)};
}

function languageSetForConflict(grant:any,editionLanguages:string[],contractRules:Map<string,any[]>,contracts:Map<string,any>,channel:string){
  if(!grant.contract_id)return new Set(editionLanguages.length?editionLanguages:["*"]);
  const contract=contracts.get(String(grant.contract_id));if(!contract)return new Set<string>();
  const scoped=(contractRules.get(String(grant.contract_id))||[]).filter((r:any)=>(!r.format||String(r.format).toLowerCase()===String(grant.format).toLowerCase())&&(!r.sales_channel||String(r.sales_channel)===channel));
  const allow=new Set(scoped.filter((r:any)=>r.decision==="allow").map((r:any)=>String(r.language_code).toLowerCase())),deny=new Set(scoped.filter((r:any)=>r.decision==="deny").map((r:any)=>String(r.language_code).toLowerCase()));
  if(!editionLanguages.length){const out=allow.size?new Set(allow):new Set<string>(["*"]);for(const d of deny)out.delete(d);return out;}
  const out=new Set<string>();for(const l of editionLanguages){if(deny.has(l))continue;if(!allow.size||allow.has(l))out.add(l);}
  if(String(contract.language_match_mode)==="all"&&allow.size&&editionLanguages.some((l)=>!allow.has(l)||deny.has(l)))return new Set<string>();return out;
}

export async function detectRightsConflicts(db: CatalogDB, candidate?: any): Promise<Conflict[]> {
  const [grantsR,territoriesR,contractsR,languagesR,editionLangR]=await Promise.all([
    db.prepare(`SELECT rg.*,e.title edition_title,COALESCE(rp.display_name,p.name,'') rightsholder_name FROM rights_grants rg JOIN editions e ON e.id=rg.edition_id LEFT JOIN rights_parties rp ON rp.id=rg.rightsholder_party_id LEFT JOIN publishers p ON p.id=rg.rightsholder_id WHERE rg.status IN ('active','draft') ORDER BY rg.edition_id,rg.format`).all<any>(),
    db.prepare("SELECT grant_id,territory_code FROM rights_grant_territories ORDER BY grant_id,territory_code").all<any>(),db.prepare("SELECT * FROM rights_contracts").all<any>(),db.prepare("SELECT * FROM rights_contract_languages").all<any>(),db.prepare("SELECT edition_id,lower(language_code) language_code FROM edition_languages WHERE kind='content'").all<any>(),
  ]);
  const territories=new Map<string,Set<string>>();for(const r of territoriesR.results){const s=territories.get(String(r.grant_id))||new Set<string>();s.add(String(r.territory_code));territories.set(String(r.grant_id),s);}
  const contracts=new Map(contractsR.results.map((r)=>[String(r.id),r] as const)),contractRules=new Map<string,any[]>();for(const r of languagesR.results){const a=contractRules.get(String(r.contract_id))||[];a.push(r);contractRules.set(String(r.contract_id),a);}
  const editionLangs=new Map<string,string[]>();for(const r of editionLangR.results){const a=editionLangs.get(String(r.edition_id))||[];a.push(String(r.language_code));editionLangs.set(String(r.edition_id),a);}
  let grants=grantsR.results.filter((g)=>!candidate||String(g.id)!==String(candidate.id));if(candidate){grants=[...grants,candidate];territories.set(String(candidate.id),new Set(candidate.territories||[]));}
  const conflicts:Conflict[]=[];
  for(let i=0;i<grants.length;i++)for(let j=i+1;j<grants.length;j++){
    const a=grants[i],b=grants[j];if(a.edition_id!==b.edition_id||String(a.format).toLowerCase()!==String(b.format).toLowerCase())continue;if(!periodsOverlap(isoAt(a.starts_at),isoAt(a.ends_at),isoAt(b.starts_at),isoAt(b.ends_at)))continue;
    const sharedTerr=[...intersection(territories.get(String(a.id))||new Set(),territories.get(String(b.id))||new Set())];if(!sharedTerr.length)continue;
    const sharedChannels=[...intersection(channelsForGrant(a),channelsForGrant(b))];if(!sharedChannels.length)continue;
    let sharedLanguages=new Set<string>();for(const ch of sharedChannels){const la=languageSetForConflict(a,editionLangs.get(String(a.edition_id))||[],contractRules,contracts,ch),lb=languageSetForConflict(b,editionLangs.get(String(b.edition_id))||[],contractRules,contracts,ch);if(la.has("*"))for(const x of lb)sharedLanguages.add(x);else if(lb.has("*"))for(const x of la)sharedLanguages.add(x);else for(const x of intersection(la,lb))sharedLanguages.add(x);}if(!sharedLanguages.size)continue;
    const bothAllow=a.decision==="allow"&&b.decision==="allow",differentHolder=String(a.rightsholder_party_id||a.rightsholder_id||"")!==String(b.rightsholder_party_id||b.rightsholder_id||""),exclusive=[a.exclusivity,b.exclusivity].some((x)=>["exclusive","sole"].includes(String(x)));
    let severity:"error"|"warning"|"info"="info",code="OVERLAPPING_LICENSE",message="Overlapping rights scopes are configured.";
    if(bothAllow&&exclusive&&differentHolder){severity="error";code="EXCLUSIVE_LICENSE_OVERLAP";message="Exclusive/sole rights overlap an allow grant held by another rightsholder.";}
    else if(bothAllow&&differentHolder){severity="warning";code="MULTIPLE_LICENSORS_OVERLAP";message="Two rightsholders authorize the same edition, market, channel and language scope.";}
    else if(a.decision!==b.decision){severity="warning";code="ALLOW_DENY_OVERLAP";message="An explicit deny overlaps an allow; the deny wins at runtime.";}
    else if(bothAllow){severity="warning";code="DUPLICATE_OVERLAPPING_GRANTS";message="Multiple allow grants overlap for the same rightsholder/scope.";}
    else continue;
    conflicts.push({severity,code,grantAId:String(a.id),grantBId:String(b.id),editionId:String(a.edition_id),editionTitle:String(a.edition_title||a.edition_id),format:String(a.format),channels:sharedChannels,territories:sharedTerr.slice(0,20),territoryCount:sharedTerr.length,languages:[...sharedLanguages].sort(),rightsholderA:String(a.rightsholder_name||""),rightsholderB:String(b.rightsholder_name||""),message});if(conflicts.length>=200)return conflicts;
  }
  return conflicts;
}

export async function upsertRightsGrant(db: CatalogDB, raw: unknown) {
  const hist=z.object({code:z.string().max(2),asOfDate:z.string().nullable().optional()});
  const x=z.object({id:z.string().max(180).optional(),editionId:z.string().min(1).max(180),rightsholderPartyId:z.string().max(180).nullable().optional(),rightsholderId:z.string().max(180).nullable().optional(),territory:z.string().max(2).default("US"),territoryName:z.string().max(120).optional(),scopeMode:z.enum(["single","set","worldwide","expression"]).default("single"),territorySetId:z.string().max(180).nullable().optional(),scopeRules:z.array(scopeRuleSchema).max(500).optional(),includeTerritories:z.array(z.string().max(2)).max(300).default([]),excludeTerritories:z.array(z.string().max(2)).max(300).default([]),includeSetIds:z.array(z.string().max(180)).max(100).default([]),excludeSetIds:z.array(z.string().max(180)).max(100).default([]),includeHistorical:z.array(hist).max(50).default([]),excludeHistorical:z.array(hist).max(50).default([]),format:z.string().trim().min(1).max(40),salesChannel:channelSchema.default("retail"),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional(),licenseType:z.string().trim().min(1).max(80),contractId:z.string().max(180).nullable().optional(),contractVersionId:z.string().max(180).nullable().optional(),exclusivity:z.enum(["nonexclusive","exclusive","sole"]).default("nonexclusive"),drmRequirement:z.string().trim().min(1).max(80).default("none"),subscriptionPermitted:z.boolean().default(false),libraryPermitted:z.boolean().default(false),decision:z.enum(["allow","deny"]).default("allow"),status:z.enum(["draft","active","suspended","revoked","expired"]).default("active"),promotionRestrictions:restrictionsSchema.default({}),contractReference:z.string().max(200).default(""),source:z.string().max(120).default("operator"),notes:z.string().max(2000).default("")}).parse(raw);
  if(x.startsAt&&x.endsAt&&x.endsAt<=x.startsAt)throw new ApiError(400,"Rights end date must be after the start date.");
  if(!x.rightsholderPartyId&&!x.rightsholderId&&x.licenseType.trim().toLowerCase()!=="public-domain")throw new ApiError(400,"A rightsholder is required for licensed distribution rights. Public-domain determinations are the only rightsholder-free exception.");
  const edition=await db.prepare("SELECT id,title FROM editions WHERE id=?").bind(x.editionId).first<any>();if(!edition)throw new ApiError(400,"Unknown edition.");
  let holderName="";if(x.rightsholderPartyId){const party=await db.prepare("SELECT id,display_name FROM rights_parties WHERE id=? AND status='active'").bind(x.rightsholderPartyId).first<any>();if(!party)throw new ApiError(400,"Unknown or inactive rights party.");holderName=String(party.display_name||"");}
  let contractVersionId=x.contractVersionId||null;
  if(x.contractId){const contract=await db.prepare("SELECT id,rightsholder_party_id,reference_code FROM rights_contracts WHERE id=? AND status IN ('draft','active')").bind(x.contractId).first<any>();if(!contract)throw new ApiError(400,"Unknown or inactive rights contract.");if(contract.rightsholder_party_id&&x.rightsholderPartyId&&String(contract.rightsholder_party_id)!==x.rightsholderPartyId)throw new ApiError(400,"Grant rightsholder does not match the selected contract.");if(!x.contractReference)x.contractReference=String(contract.reference_code||"");
    if(contractVersionId){const v=await db.prepare("SELECT id,status,effective_from,effective_to FROM rights_contract_versions WHERE id=? AND contract_id=?").bind(contractVersionId,x.contractId).first<any>();if(!v)throw new ApiError(400,"The selected contract version does not belong to this contract.");if(x.status==="active"&&String(v.status)!=="active")throw new ApiError(409,"Active rights grants must reference an active contract version.");}
    else {const v=await db.prepare("SELECT id FROM rights_contract_versions WHERE contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY version_number DESC LIMIT 1").bind(x.contractId,now(),now()).first<any>();if(v)contractVersionId=String(v.id);else{const versions=await db.prepare("SELECT count(*) n FROM rights_contract_versions WHERE contract_id=?").bind(x.contractId).first<any>();if(x.status==="active"&&Number(versions?.n||0)>0)throw new ApiError(409,"This contract has versioned policy but no active effective version. Activate a contract version before the grant.");}}
  } else if(contractVersionId) throw new ApiError(400,"contractVersionId requires contractId.");
  const id=x.id||`right_${crypto.randomUUID()}`,at=now(),scope=await grantScopeFromInput(db,x),before=x.id?await db.prepare("SELECT created_at FROM rights_grants WHERE id=?").bind(id).first<any>():null;
  if(contractVersionId&&["draft","active"].includes(x.status)){const [tv,fv,cv]=await Promise.all([db.prepare(`SELECT territory_code,decision FROM rights_contract_version_territories WHERE contract_version_id=?`).bind(contractVersionId).all<any>(),db.prepare("SELECT decision,drm_requirement FROM rights_contract_version_formats WHERE contract_version_id=? AND lower(format)=lower(?)").bind(contractVersionId,x.format).first<any>(),db.prepare("SELECT permitted FROM rights_contract_version_channels WHERE contract_version_id=? AND sales_channel=?").bind(contractVersionId,x.salesChannel).first<any>()]);const allowed=new Set(tv.results.filter((r:any)=>r.decision==='allow').map((r:any)=>String(r.territory_code)));const denied=new Set(tv.results.filter((r:any)=>r.decision==='deny').map((r:any)=>String(r.territory_code)));if(tv.results.length&&scope.territories.some((t:string)=>denied.has(t)||!allowed.has(t)))throw new ApiError(409,"The grant territory scope exceeds the selected contract version.");if(!fv||String(fv.decision)!=='allow')throw new ApiError(409,"The grant format is not permitted by the selected contract version.");if(!cv||!Number(cv.permitted))throw new ApiError(409,"The grant sales channel is not permitted by the selected contract version.");if(!drmSatisfiesRequirement(String(fv.drm_requirement||'none'),x.drmRequirement))throw new ApiError(409,"The grant DRM policy is weaker than the selected contract version requires.");}

  const candidate:any={id,edition_id:x.editionId,edition_title:String(edition.title||x.editionId),rightsholder_id:x.rightsholderId||null,rightsholder_party_id:x.rightsholderPartyId||null,rightsholder_name:holderName,format:x.format,sales_channel:x.salesChannel,starts_at:x.startsAt||null,ends_at:x.endsAt||null,contract_id:x.contractId||null,contract_version_id:contractVersionId,exclusivity:x.exclusivity,subscription_permitted:x.subscriptionPermitted?1:0,library_permitted:x.libraryPermitted?1:0,decision:x.decision,status:x.status,territories:scope.territories};
  const preflight=await detectRightsConflicts(db,candidate),blocking=preflight.filter((c)=>c.severity==="error"&&(c.grantAId===id||c.grantBId===id));if(x.status==="active"&&blocking.length)throw new ApiError(409,`Rights conflict: ${blocking[0].message} Conflicting grant ${blocking[0].grantAId===id?blocking[0].grantBId:blocking[0].grantAId}.`);
  const statements:any[]=[db.prepare(`INSERT INTO rights_grants(id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,starts_at,ends_at,license_type,drm_requirement,subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at,contract_id,contract_version_id,exclusivity,scope_summary)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET edition_id=excluded.edition_id,rightsholder_id=excluded.rightsholder_id,rightsholder_party_id=excluded.rightsholder_party_id,territory_code=excluded.territory_code,format=excluded.format,sales_channel=excluded.sales_channel,starts_at=excluded.starts_at,ends_at=excluded.ends_at,license_type=excluded.license_type,drm_requirement=excluded.drm_requirement,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,decision=excluded.decision,status=excluded.status,promotion_restrictions_json=excluded.promotion_restrictions_json,contract_reference=excluded.contract_reference,source=excluded.source,notes=excluded.notes,updated_at=excluded.updated_at,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,exclusivity=excluded.exclusivity,scope_summary=excluded.scope_summary`).bind(id,x.editionId,x.rightsholderId||null,x.rightsholderPartyId||null,scope.legacyCode,x.format,x.salesChannel,x.startsAt||null,x.endsAt||null,x.licenseType,x.drmRequirement,x.subscriptionPermitted?1:0,x.libraryPermitted?1:0,x.decision,x.status,JSON.stringify(x.promotionRestrictions),x.contractReference,x.source,x.notes,before?.created_at||at,at,x.contractId||null,contractVersionId,x.exclusivity,scope.summary),db.prepare("DELETE FROM rights_grant_territory_scopes WHERE grant_id=?").bind(id),db.prepare("DELETE FROM rights_grant_territories WHERE grant_id=?").bind(id)];
  scope.rules.forEach((r,i)=>statements.push(db.prepare(`INSERT INTO rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_code,territory_set_id,historical_code,as_of_date,position,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(`rgscope_${crypto.randomUUID()}`,id,r.effect,r.targetType,r.territoryCode?normalizeTerritoryCode(r.territoryCode):null,r.territorySetId||null,r.historicalCode?String(r.historicalCode).toUpperCase():null,r.asOfDate||null,i,at)));
  for(let i=0;i<scope.territories.length;i+=80){const chunk=scope.territories.slice(i,i+80),values=chunk.map(()=>"(?,?,?,?)").join(","),st=db.prepare(`INSERT INTO rights_grant_territories(grant_id,territory_code,resolved_from,snapshotted_at) VALUES ${values}`),binds:any[]=[];for(const code of chunk)binds.push(id,code,scope.summary,at);statements.push(st.bind(...binds));}
  statements.push(db.prepare("INSERT INTO rights_grant_scope_snapshots(id,grant_id,scope_json,territories_json,recorded_at) VALUES(?,?,?,?,?)").bind(`rgss_${crypto.randomUUID()}`,id,JSON.stringify({mode:x.scopeMode,rules:scope.rules,summary:scope.summary}),JSON.stringify(scope.territories),at));
  await db.batch(statements);return{id,territoryCount:scope.territories.length,territories:scope.territories,scopeSummary:scope.summary,conflicts:preflight.filter((c)=>c.grantAId===id||c.grantBId===id)};
}

export async function territoryExpansionPreview(db: CatalogDB, raw: unknown) {
  const x=z.object({scopeMode:z.enum(["single","set","worldwide","expression"]).default("single"),territory:z.string().max(2).default("US"),territorySetId:z.string().max(180).nullable().optional(),scopeRules:z.array(scopeRuleSchema).max(500).optional(),includeTerritories:z.array(z.string().max(2)).max(300).default([]),excludeTerritories:z.array(z.string().max(2)).max(300).default([]),includeSetIds:z.array(z.string().max(180)).max(100).default([]),excludeSetIds:z.array(z.string().max(180)).max(100).default([]),includeHistorical:z.array(z.object({code:z.string().max(2),asOfDate:z.string().nullable().optional()})).max(50).default([]),excludeHistorical:z.array(z.object({code:z.string().max(2),asOfDate:z.string().nullable().optional()})).max(50).default([])}).parse(raw);
  const scope=await grantScopeFromInput(db,x);return{count:scope.territories.length,territories:scope.territories,summary:scope.summary};
}

export async function rightsAdminSnapshot(db: CatalogDB) {
  const [grants,parties,decisions,grantAudit,grantScopes,territorySets,territorySetRules,contracts,contractLanguages,contractVersions,contractTerritories,contractFormats,contractChannels,contractAssignments,contractAudit,historical,configAudit,conflicts]=await Promise.all([
    db.prepare(`SELECT rg.*,e.title edition_title,COALESCE(rp.display_name,p.name,'') rightsholder_name,rc.name contract_name,(SELECT count(*) FROM rights_grant_territories gt WHERE gt.grant_id=rg.id) territory_count FROM rights_grants rg JOIN editions e ON e.id=rg.edition_id LEFT JOIN rights_parties rp ON rp.id=rg.rightsholder_party_id LEFT JOIN publishers p ON p.id=rg.rightsholder_id LEFT JOIN rights_contracts rc ON rc.id=rg.contract_id ORDER BY COALESCE(rg.updated_at,rg.created_at) DESC LIMIT 1000`).all<any>(),
    db.prepare("SELECT * FROM rights_parties ORDER BY display_name LIMIT 1000").all<any>(),db.prepare("SELECT * FROM rights_decisions ORDER BY evaluated_at DESC LIMIT 200").all<any>(),db.prepare("SELECT * FROM rights_grant_audit ORDER BY recorded_at DESC LIMIT 200").all<any>(),db.prepare("SELECT * FROM rights_grant_territory_scopes ORDER BY grant_id,position").all<any>(),
    db.prepare(`SELECT ts.*,(SELECT count(*) FROM territory_set_members m WHERE m.set_id=ts.id) member_count,(SELECT group_concat(territory_code,',') FROM (SELECT territory_code FROM territory_set_members m2 WHERE m2.set_id=ts.id ORDER BY territory_code LIMIT 30)) member_sample FROM territory_sets ts ORDER BY is_system DESC,code`).all<any>(),db.prepare("SELECT * FROM territory_set_rules ORDER BY set_id,position").all<any>(),
    db.prepare(`SELECT rc.*,rp.display_name rightsholder_name FROM rights_contracts rc LEFT JOIN rights_parties rp ON rp.id=rc.rightsholder_party_id ORDER BY rc.updated_at DESC LIMIT 500`).all<any>(),db.prepare("SELECT * FROM rights_contract_languages ORDER BY contract_id,language_code LIMIT 2000").all<any>(),
    db.prepare("SELECT * FROM rights_contract_versions ORDER BY contract_id,version_number DESC LIMIT 2000").all<any>(),db.prepare("SELECT * FROM rights_contract_version_territories ORDER BY contract_version_id,territory_code LIMIT 10000").all<any>(),db.prepare("SELECT * FROM rights_contract_version_formats ORDER BY contract_version_id,format LIMIT 5000").all<any>(),db.prepare("SELECT * FROM rights_contract_version_channels ORDER BY contract_version_id,sales_channel LIMIT 5000").all<any>(),db.prepare(`SELECT a.*,pa.legal_name,pa.display_name,rc.reference_code,rc.name contract_name FROM publisher_contract_assignments a JOIN publishing_accounts pa ON pa.id=a.account_id JOIN rights_contracts rc ON rc.id=a.contract_id ORDER BY pa.display_name,rc.reference_code LIMIT 2000`).all<any>(),db.prepare("SELECT * FROM rights_contract_audit ORDER BY created_at DESC LIMIT 500").all<any>(),
    db.prepare(`SELECT h.*,group_concat(s.territory_code,',') successors FROM territory_historical_entities h LEFT JOIN territory_historical_successors s ON s.historical_entity_id=h.id GROUP BY h.id ORDER BY h.historical_code,h.valid_from`).all<any>(),db.prepare("SELECT * FROM rights_configuration_audit ORDER BY recorded_at DESC LIMIT 200").all<any>(),detectRightsConflicts(db),
  ]);
  return{grants:grants.results,parties:parties.results,decisions:decisions.results,grantAudit:grantAudit.results,grantScopes:grantScopes.results,territorySets:territorySets.results,territorySetRules:territorySetRules.results,contracts:contracts.results,contractLanguages:contractLanguages.results,contractVersions:contractVersions.results,contractTerritories:contractTerritories.results,contractFormats:contractFormats.results,contractChannels:contractChannels.results,contractAssignments:contractAssignments.results,contractAudit:contractAudit.results,historical:historical.results,configAudit:configAudit.results,conflicts};
}

export async function rightsAvailabilityCheck(db: CatalogDB, raw: unknown) {
  const x=z.object({productId:z.string().min(1).max(180),territory:z.string().regex(/^[A-Za-z]{2}$/),salesChannel:channelSchema.default("retail"),persist:z.boolean().default(true)}).parse(raw);
  return resolveProductRights(db,x.productId,x.territory,{salesChannel:x.salesChannel,persist:x.persist,context:{source:"operator-check"}});
}
