import JSZip from "jszip";
import { z } from "zod";
import { ApiError } from "./service";
import { detectRightsConflicts, upsertRightsContract, upsertRightsGrant, upsertRightsParty } from "./rights.server";
import { runAutomatedPublishingReview } from "./moderation.server";
import { FORE_AI_POLICY_VERSION, FORE_RIGHTS_POLICY_VERSION, assessSubmissionContentPolicy, publisherRightsSnapshot, recordAssetFingerprint, scanAccountRiskLinks, scanIdentitySimilarity } from "./publishing-trust.server";
import { createRoyaltyContractVersion } from "./royalty-engine.server";
import { ensurePreorderReleasePlan } from "./preorder.server";
import { commercialAudioReadiness, commercialAudioSubmissionEvidence } from "./commercial-audio.server";
import { emitNotification } from "./notifications.server";
import { mirrorPublishingMalwareResult } from "./security.server";
import { assessPublisherRisk } from "./risk-tax.server";

export type PublishingDB = {
  prepare(sql: string): { bind(...values: unknown[]): any; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<any> };
  batch(statements: any[]): Promise<unknown>;
};
export type PublishingEnv = {
  DB: PublishingDB;
  BUCKET?: { get(key: string, options?: any): Promise<any>; put(key: string, value: any, options?: any): Promise<any>; delete(key: string): Promise<void> };
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?: string;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const isoOrNull = z.string().datetime().nullable().optional();
const roles = ["owner", "admin", "editor", "finance", "analyst"] as const;
type Role = (typeof roles)[number];
const roleRank: Record<Role, number> = { analyst: 1, editor: 2, finance: 2, admin: 3, owner: 4 };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256Hex(bytes: Uint8Array | string) {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeJson<T>(text: unknown, fallback: T): T {
  try { return JSON.parse(String(text || "")) as T; } catch { return fallback; }
}
function cleanText(value: unknown, max = 500) { return String(value ?? "").trim().slice(0, max); }

async function membership(db: PublishingDB, userId: string, accountId: string) {
  return db.prepare("SELECT * FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'").bind(accountId, userId).first<any>();
}
async function requireRole(db: PublishingDB, userId: string, accountId: string, minimum: Role) {
  const row = await membership(db, userId, accountId);
  if (!row || roleRank[row.role as Role] < roleRank[minimum]) throw new ApiError(403, "You do not have permission to perform this publishing action.");
  return row;
}
async function editionAccess(db: PublishingDB, userId: string, editionId: string, minimum: Role = "analyst") {
  const row = await db.prepare(`SELECT e.*,t.account_id,t.title,t.subtitle,t.description,t.language title_language,t.audience,t.publisher_name,t.imprint_name,t.series_name,t.series_relationship,t.series_position,t.categories_json,t.keywords_json
    FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`).bind(editionId).first<any>();
  if (!row) throw new ApiError(404, "Publishing edition not found.");
  await requireRole(db, userId, String(row.account_id), minimum);
  return row;
}
async function audit(db: PublishingDB, accountId: string | null, actorUserId: string | null, entityType: string, entityId: string, action: string, metadata: Record<string, unknown> = {}) {
  await db.prepare("INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id("pubaudit"), accountId, actorUserId, entityType, entityId, action, JSON.stringify(metadata), now()).run();
}

async function ensurePublishingLifecycle(db: PublishingDB, publishingEditionId: string) {
  let row = await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?").bind(publishingEditionId).first<any>();
  if (row) return row;
  const edition = await db.prepare(`SELECT e.id,e.status,e.created_at,e.updated_at FROM publishing_edition_drafts e WHERE e.id=?`).bind(publishingEditionId).first<any>();
  if (!edition) throw new ApiError(404, "Publishing edition not found.");
  const lifecycleId=id("lifecycle"),state=edition.status==="published"?"live":edition.status==="approved"?"approved":edition.status==="submitted"?"human_review":edition.status==="validating"?"validation":"draft",at=now();
  await db.prepare("INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,state,owner_update_policy,live_at,created_at,updated_at) VALUES(?,?,?,'auto_update',?,?,?)").bind(lifecycleId,publishingEditionId,state,state==="live"?at:null,edition.created_at||at,at).run();
  await db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'migration','lifecycle_created','{}',?)").bind(id("lifeevt"),lifecycleId,null,state,at).run();
  row=await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?").bind(lifecycleId).first<any>();
  return row;
}

const normalLifecycleTransitions: Record<string, Set<string>> = {
  draft: new Set(["draft","validation","submitted","suppressed","takedown","retired"]),
  validation: new Set(["validation","draft","submitted","suppressed","takedown","retired"]),
  submitted: new Set(["automated_review","human_review","draft","suppressed","takedown","retired"]),
  automated_review: new Set(["human_review","approved","draft","suppressed","takedown","retired"]),
  human_review: new Set(["human_review","approved","draft","live","updated","retired","suppressed","takedown"]),
  approved: new Set(["approved","scheduled","preorder","live","updated","draft","suppressed","takedown","retired"]),
  scheduled: new Set(["scheduled","preorder","live","updated","draft","suppressed","takedown","retired"]),
  preorder: new Set(["preorder","live","updated","draft","suppressed","takedown","retired"]),
  live: new Set(["live","updated","draft","suppressed","takedown","retired"]),
  updated: new Set(["updated","draft","suppressed","takedown","retired"]),
  suppressed: new Set(["suppressed"]),
  takedown: new Set(["takedown"]),
  retired: new Set(["retired"]),
};

async function transitionPublishingLifecycle(db: PublishingDB, publishingEditionId: string, toState: string, triggerType: "publisher"|"automation"|"staff"|"schedule"|"moderation"|"rollback"|"migration", actorUserId: string | null, reasonCode = "", metadata: Record<string,unknown> = {}) {
  const lifecycle=await ensurePublishingLifecycle(db,publishingEditionId);
  const allowed=normalLifecycleTransitions[String(lifecycle.state)];
  if(triggerType!=="moderation"&&triggerType!=="migration"&&(!allowed||!allowed.has(toState))) throw new ApiError(409,`Invalid publishing lifecycle transition: ${lifecycle.state} → ${toState}.`);
  const at=now(), timestampColumn=toState==="scheduled"?"scheduled_at":toState==="preorder"?"preorder_at":toState==="live"||toState==="updated"?"live_at":toState==="suppressed"?"suppressed_at":toState==="takedown"?"takedown_at":toState==="retired"?"retired_at":null;
  const sql=`UPDATE publishing_release_lifecycles SET state=?,state_reason=?,${timestampColumn?`${timestampColumn}=COALESCE(${timestampColumn},?),`:""}updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...(timestampColumn?[toState,reasonCode,at,at,lifecycle.id]:[toState,reasonCode,at,lifecycle.id])).run();
  await db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id("lifeevt"),lifecycle.id,lifecycle.state,toState,triggerType,actorUserId,reasonCode,JSON.stringify(metadata),at).run();
  return await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?").bind(lifecycle.id).first<any>();
}

const accountSchema = z.object({
  id: z.string().max(180).optional(),
  accountType: z.enum(["person", "company"]).default("person"),
  legalName: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()),
  contactEmail: z.string().email().or(z.literal("")).default(""),
  website: z.string().url().or(z.literal("")).default(""),
  termsVersion: z.string().max(80).default("fore-publishing-v1"),
  acceptTerms: z.boolean().default(false),
});

export async function upsertPublishingAccount(db: PublishingDB, userId: string, raw: unknown) {
  const x = accountSchema.parse(raw), at = now();
  if (x.id) {
    await requireRole(db, userId, x.id, "admin");
    await db.prepare(`UPDATE publishing_accounts SET account_type=?,legal_name=?,display_name=?,country_code=?,contact_email=?,website=?,terms_version=?,terms_accepted_at=CASE WHEN ?=1 THEN COALESCE(terms_accepted_at,?) ELSE terms_accepted_at END,updated_at=? WHERE id=?`)
      .bind(x.accountType, x.legalName, x.displayName, x.countryCode, x.contactEmail, x.website, x.termsVersion, x.acceptTerms ? 1 : 0, at, at, x.id).run();
    const identityMatches=await scanIdentitySimilarity(db,{accountId:x.id,subjectType:"publisher_name",subjectId:x.id,name:x.displayName});
    const riskLinks=await scanAccountRiskLinks(db,x.id);
    await audit(db, x.id, userId, "publishing_account", x.id, "updated", { identitySimilarityMatches:identityMatches.length, riskLinks: riskLinks.links });
    return { id: x.id, identitySimilarityMatches: identityMatches.length, riskLinks: riskLinks.links };
  }
  const accountId = id("pubacct");
  await db.batch([
    db.prepare(`INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,contact_email,website,status,terms_version,terms_accepted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?)`)
      .bind(accountId, x.accountType, x.legalName, x.displayName, x.countryCode, x.contactEmail, x.website, x.termsVersion, x.acceptTerms ? at : null, at, at),
    db.prepare(`INSERT INTO publishing_account_members(account_id,user_id,role,status,accepted_at,created_at,updated_at) VALUES(?,?,'owner','active',?,?,?)`).bind(accountId, userId, at, at, at),
  ]);
  const identityMatches=await scanIdentitySimilarity(db,{accountId,subjectType:"publisher_name",subjectId:accountId,name:x.displayName});
  const riskLinks=await scanAccountRiskLinks(db,accountId);
  await audit(db, accountId, userId, "publishing_account", accountId, "created", { identitySimilarityMatches:identityMatches.length, riskLinks:riskLinks.links });
  return { id: accountId, identitySimilarityMatches: identityMatches.length, riskLinks:riskLinks.links };
}

export async function savePublishingAddress(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), addressType: z.enum(["legal", "mailing", "tax"]), line1: z.string().trim().min(1).max(200), line2: z.string().max(200).default(""), city: z.string().trim().min(1).max(160), region: z.string().max(160).default(""), postalCode: z.string().max(40).default(""), countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()) }).parse(raw);
  await requireRole(db, userId, x.accountId, "admin"); const at = now();
  const existing = await db.prepare("SELECT id FROM publishing_addresses WHERE account_id=? AND address_type=?").bind(x.accountId, x.addressType).first<any>();
  const addressId = existing?.id || id("pubaddr");
  await db.prepare(`INSERT INTO publishing_addresses(id,account_id,address_type,line1,line2,city,region,postal_code,country_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,address_type) DO UPDATE SET line1=excluded.line1,line2=excluded.line2,city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,country_code=excluded.country_code,updated_at=excluded.updated_at`)
    .bind(addressId, x.accountId, x.addressType, x.line1, x.line2, x.city, x.region, x.postalCode, x.countryCode, at, at).run();
  await audit(db, x.accountId, userId, "address", addressId, "saved", { addressType: x.addressType });
  return { id: addressId };
}

export async function savePenName(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ id: z.string().max(180).optional(), accountId: z.string().min(1), displayName: z.string().trim().min(1).max(220), sortName: z.string().max(220).default("") }).parse(raw);
  await requireRole(db, userId, x.accountId, "editor"); const penId = x.id || id("pen"), at = now();
  await db.prepare(`INSERT INTO publishing_pen_names(id,account_id,display_name,sort_name,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,sort_name=excluded.sort_name,updated_at=excluded.updated_at`).bind(penId, x.accountId, x.displayName, x.sortName, at, at).run();
  const identityMatches=await scanIdentitySimilarity(db,{accountId:x.accountId,subjectType:"pen_name",subjectId:penId,name:x.displayName});
  await audit(db, x.accountId, userId, "pen_name", penId, x.id ? "updated" : "created", { identitySimilarityMatches: identityMatches.length }); return { id: penId, identitySimilarityMatches: identityMatches.length };
}

export async function invitePublishingMember(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), email: z.string().email(), role: z.enum(["admin", "editor", "finance", "analyst"]) }).parse(raw);
  await requireRole(db, userId, x.accountId, "admin"); const invitationUserId = `invite:${crypto.randomUUID()}`, at = now();
  await db.prepare(`INSERT INTO publishing_account_members(account_id,user_id,role,status,invited_email,invited_by_user_id,created_at,updated_at) VALUES(?,?,?,'invited',?,?,?,?)`).bind(x.accountId, invitationUserId, x.role, x.email.toLowerCase(), userId, at, at).run();
  await audit(db, x.accountId, userId, "team_invitation", invitationUserId, "created", { role: x.role, email: x.email.toLowerCase() });
  return { invitationId: invitationUserId, status: "invited" };
}

export async function startIdentityVerification(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), provider: z.string().trim().min(1).max(80).default("external_kyc"), providerReference: z.string().max(240).default(""), verificationType: z.string().max(80).default("government_id") }).parse(raw);
  await requireRole(db, userId, x.accountId, "admin"); const acct = await db.prepare("SELECT legal_name,country_code FROM publishing_accounts WHERE id=?").bind(x.accountId).first<any>(); if (!acct) throw new ApiError(404, "Publishing account not found.");
  const verificationId = id("kyc"), at = now();
  await db.batch([
    db.prepare(`INSERT INTO publishing_identity_verifications(id,account_id,provider,provider_reference,verification_type,status,country_code,legal_name_snapshot,initiated_at) VALUES(?,?,?,?,?,'pending',?,?,?)`).bind(verificationId, x.accountId, x.provider, x.providerReference || verificationId, x.verificationType, acct.country_code, acct.legal_name, at),
    db.prepare("UPDATE publishing_accounts SET identity_status='pending',updated_at=? WHERE id=?").bind(at, x.accountId),
  ]);
  await audit(db, x.accountId, userId, "identity_verification", verificationId, "started", { provider: x.provider });
  return { id: verificationId, status: "pending", rawIdentityDocumentsStoredByCove: false };
}

export async function submitTaxProfile(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()), taxResidencyCountry: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()).optional(), entityType: z.enum(["individual","sole_proprietor","partnership","corporation","llc","nonprofit","trust","other","unknown"]).default("unknown"), taxClassification: z.string().max(120).default(""), formType: z.string().max(80).default(""), provider: z.string().trim().min(1).max(80).default("external_tax"), providerReference: z.string().max(240).default(""), treatyCountryCode: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()).nullable().optional() }).parse(raw);
  await requireRole(db, userId, x.accountId, "finance"); const profileId = id("tax"), at = now();
  await db.batch([
    db.prepare(`INSERT INTO publishing_tax_profiles(id,account_id,country_code,tax_classification,form_type,provider,provider_reference,status,treaty_country_code,created_at,updated_at,entity_type,tax_residency_country,provider_verification_status,form_status) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,'pending','pending')`).bind(profileId, x.accountId, x.countryCode, x.taxClassification, x.formType, x.provider, x.providerReference || profileId, x.treatyCountryCode || null, at, at, x.entityType, x.taxResidencyCountry || x.countryCode),
    db.prepare("UPDATE publishing_accounts SET tax_status='pending',updated_at=? WHERE id=?").bind(at, x.accountId),
  ]);
  await audit(db, x.accountId, userId, "tax_profile", profileId, "submitted", { provider: x.provider, country: x.countryCode, taxResidencyCountry:x.taxResidencyCountry||x.countryCode, entityType:x.entityType });
  await assessPublisherRisk(db,x.accountId,"tax_profile_submitted");
  return { id: profileId, status: "pending", rawTaxIdentifiersStoredByCove: false };
}

export async function submitPayoutAccount(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), provider: z.string().trim().min(1).max(80).default("external_payout"), providerAccountId: z.string().max(240).default(""), method: z.enum(["eft", "ach", "sepa", "wire", "other"]).default("eft"), bankCountryCode: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()), payoutCurrency: z.string().regex(/^[A-Za-z]{3}$/).transform(v => v.toUpperCase()), accountLast4: z.string().regex(/^\d{0,4}$/).default(""), accountHolderType: z.enum(["individual", "company", "unknown"]).default("unknown"), payoutThresholdMinor: z.number().int().min(0).max(10000000).default(5000) }).parse(raw);
  await requireRole(db, userId, x.accountId, "finance"); const payoutId = id("payoutacct"), at = now();
  await db.batch([
    db.prepare(`INSERT INTO publishing_payout_accounts(id,account_id,provider,provider_account_id,method,bank_country_code,payout_currency,account_last4,account_holder_type,status,payout_threshold_minor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).bind(payoutId, x.accountId, x.provider, x.providerAccountId || payoutId, x.method, x.bankCountryCode, x.payoutCurrency, x.accountLast4, x.accountHolderType, x.payoutThresholdMinor, at, at),
    db.prepare("UPDATE publishing_accounts SET payout_status='pending',updated_at=? WHERE id=?").bind(at, x.accountId),
  ]);
  const riskLinks=await scanAccountRiskLinks(db,x.accountId);
  await audit(db, x.accountId, userId, "payout_account", payoutId, "submitted", { provider: x.provider, currency: x.payoutCurrency, bankCountry: x.bankCountryCode, riskLinks:riskLinks.links });
  const risk=await assessPublisherRisk(db,x.accountId,"payout_account_submitted");
  return { id: payoutId, status: "pending", rawBankCredentialsStoredByCove: false, riskLinks:riskLinks.links, risk:{score:risk.score,level:risk.level,action:risk.action} };
}

const titleSchema = z.object({
  id: z.string().max(180).optional(), accountId: z.string().min(1), title: z.string().trim().min(1).max(300), subtitle: z.string().max(300).default(""), description: z.string().max(20000).default(""), language: z.string().trim().min(2).max(35).default("en"), audience: z.enum(["children", "young_adult", "general", "academic", "professional"]).default("general"), publisherName: z.string().max(240).default(""), imprintName: z.string().max(240).default(""), seriesName: z.string().max(300).default(""), seriesRelationship: z.enum(["main", "prequel", "novella", "companion", "boxset", "related"]).default("main"), seriesPosition: z.number().nullable().optional(), categories: z.array(z.string().trim().min(1).max(180)).max(12).default([]), keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export async function savePublishingTitle(db: PublishingDB, userId: string, raw: unknown) {
  const x = titleSchema.parse(raw); await requireRole(db, userId, x.accountId, "editor"); const titleId = x.id || id("pubtitle"), at = now();
  await db.prepare(`INSERT INTO publishing_titles(id,account_id,title,subtitle,description,language,audience,publisher_name,imprint_name,series_name,series_relationship,series_position,categories_json,keywords_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,description=excluded.description,language=excluded.language,audience=excluded.audience,publisher_name=excluded.publisher_name,imprint_name=excluded.imprint_name,series_name=excluded.series_name,series_relationship=excluded.series_relationship,series_position=excluded.series_position,categories_json=excluded.categories_json,keywords_json=excluded.keywords_json,updated_at=excluded.updated_at`)
    .bind(titleId, x.accountId, x.title, x.subtitle, x.description, x.language.toLowerCase(), x.audience, x.publisherName, x.imprintName, x.seriesName, x.seriesRelationship, x.seriesPosition ?? null, JSON.stringify(x.categories), JSON.stringify(x.keywords), at, at).run();
  await audit(db, x.accountId, userId, "publishing_title", titleId, x.id ? "updated" : "created"); return { id: titleId };
}

const territoryScopeSchema = z.object({ mode: z.enum(["single", "set", "worldwide", "expression"]).default("worldwide"), territory: z.string().regex(/^[A-Za-z]{2}$/).optional(), territorySetId: z.string().max(180).optional(), include: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(300).default([]), exclude: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(300).default([]), includeSetIds: z.array(z.string().max(180)).max(100).default([]), excludeSetIds: z.array(z.string().max(180)).max(100).default([]) });
const editionSchema = z.object({
  id: z.string().max(180).optional(), titleId: z.string().min(1), format: z.enum(["ebook", "audiobook"]).default("ebook"), editionLabel: z.string().max(120).default(""), language: z.string().min(2).max(35).default("en"), isbn13: z.string().regex(/^\d{13}$/).nullable().optional(), publisherIdentifier: z.string().max(120).default(""), rightsBasis: z.enum(["owned", "licensed", "public_domain"]).default("owned"), editionType: z.enum(["canonical_public_domain","annotated","new_translation","illustrated","scholarly","commercial_audiobook","original"]).default("original"), differentiationSummary: z.string().max(4000).default(""), contractId: z.string().max(180).nullable().optional(), contractVersionId: z.string().max(180).nullable().optional(), territoryScope: territoryScopeSchema.default({ mode: "worldwide", include: [], exclude: [], includeSetIds: [], excludeSetIds: [] }), rightsStartAt: isoOrNull, rightsEndAt: isoOrNull, releaseDate: isoOrNull, preorderDate: isoOrNull, listCurrency: z.string().regex(/^[A-Za-z]{3}$/).transform(v => v.toUpperCase()).default("USD"), listPriceMinor: z.number().int().min(0).max(100000000).default(0), drmRequirement: z.enum(["none", "watermark", "lcp", "adobe_acs"]).default("none"), downloadable: z.boolean().default(true), subscriptionPermitted: z.boolean().default(false), libraryPermitted: z.boolean().default(false), salesChannels: z.array(z.enum(["retail", "subscription", "library"])).min(1).max(3).default(["retail"]), contributors: z.array(z.object({ penNameId: z.string().max(180).nullable().optional(), displayName: z.string().trim().min(1).max(220), role: z.enum(["author", "editor", "translator", "illustrator", "narrator", "other"]), position: z.number().int().min(0).max(1000).default(0) })).max(50).default([]),
});
export async function savePublishingEdition(db: PublishingDB, userId: string, raw: unknown) {
  const x = editionSchema.parse(raw); const title = await db.prepare("SELECT * FROM publishing_titles WHERE id=?").bind(x.titleId).first<any>(); if (!title) throw new ApiError(404, "Publishing title not found."); await requireRole(db, userId, String(title.account_id), "editor");
  if (x.rightsStartAt && x.rightsEndAt && x.rightsEndAt <= x.rightsStartAt) throw new ApiError(400, "Rights end date must follow the start date.");
  if (x.preorderDate && x.releaseDate && x.preorderDate > x.releaseDate) throw new ApiError(400, "Preorder date cannot be after release date.");
  if (x.contractVersionId && !x.contractId) throw new ApiError(400, "A contract version requires a distribution contract.");
  if (x.contractId) {
    const assignment=await db.prepare("SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)").bind(title.account_id,x.contractId,now(),now()).first<any>();
    if(!assignment) throw new ApiError(403,"That distribution contract is not actively assigned to this publishing organization.");
    if(x.contractVersionId){const v=await db.prepare("SELECT 1 ok FROM rights_contract_versions WHERE id=? AND contract_id=? AND status='active'").bind(x.contractVersionId,x.contractId).first<any>();if(!v)throw new ApiError(400,"The selected contract version is not active for that contract.");}
  }
  const editionId = x.id || id("pubed"), at = now();
  const existing = x.id ? await db.prepare("SELECT id,status,revision FROM publishing_edition_drafts WHERE id=? AND title_id=?").bind(x.id, x.titleId).first<any>() : null;
  if (x.id && !existing) throw new ApiError(404, "Publishing edition not found.");
  if (existing && ["submitted", "approved", "published"].includes(String(existing.status))) throw new ApiError(409, "Create a new revision before changing a submitted or published edition.");
  const nextRevision = existing?.status === "changes_requested" ? Number(existing.revision || 1) + 1 : Number(existing?.revision || 1);
  const nextStatus = existing?.status === "changes_requested" ? "draft" : (existing?.status || "draft");
  const statements: any[] = [db.prepare(`INSERT INTO publishing_edition_drafts(id,title_id,format,edition_label,language,isbn13,publisher_identifier,rights_basis,edition_type,differentiation_summary,contract_id,contract_version_id,territory_scope_json,rights_start_at,rights_end_at,release_date,preorder_date,list_currency,list_price_minor,drm_requirement,downloadable,subscription_permitted,library_permitted,sales_channels_json,status,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET format=excluded.format,edition_label=excluded.edition_label,language=excluded.language,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,rights_basis=excluded.rights_basis,edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,territory_scope_json=excluded.territory_scope_json,rights_start_at=excluded.rights_start_at,rights_end_at=excluded.rights_end_at,release_date=excluded.release_date,preorder_date=excluded.preorder_date,list_currency=excluded.list_currency,list_price_minor=excluded.list_price_minor,drm_requirement=excluded.drm_requirement,downloadable=excluded.downloadable,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,sales_channels_json=excluded.sales_channels_json,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at`)
    .bind(editionId, x.titleId, x.format, x.editionLabel, x.language.toLowerCase(), x.isbn13 || null, x.publisherIdentifier, x.rightsBasis, x.editionType, x.differentiationSummary, x.contractId||null, x.contractVersionId||null, JSON.stringify({ ...x.territoryScope, include: x.territoryScope.include.map(v => v.toUpperCase()), exclude: x.territoryScope.exclude.map(v => v.toUpperCase()), territory: x.territoryScope.territory?.toUpperCase() }), x.rightsStartAt || null, x.rightsEndAt || null, x.releaseDate || null, x.preorderDate || null, x.listCurrency, x.listPriceMinor, x.drmRequirement, x.downloadable ? 1 : 0, x.subscriptionPermitted ? 1 : 0, x.libraryPermitted ? 1 : 0, JSON.stringify(x.salesChannels), nextStatus, nextRevision, at, at), db.prepare("DELETE FROM publishing_edition_contributors WHERE edition_id=?").bind(editionId)];
  x.contributors.forEach(c => statements.push(db.prepare("INSERT INTO publishing_edition_contributors(edition_id,pen_name_id,display_name,role,position) VALUES(?,?,?,?,?)").bind(editionId, c.penNameId || null, c.displayName, c.role, c.position)));
  await db.batch(statements); await ensurePublishingLifecycle(db,editionId); await transitionPublishingLifecycle(db,editionId,"draft","publisher",userId,x.id?"draft_updated":"draft_created"); await audit(db, String(title.account_id), userId, "publishing_edition", editionId, x.id ? "updated" : "created"); return { id: editionId };
}

function publishingChecks(kind: string, format: string) {
  if (kind === "cover") return [
    ["malware", true, "external"], ["cover", true, "inline"], ["images", true, "inline"], ["render", true, "external"], ["duplicate", false, "inline"],
  ] as const;
  if (kind === "manuscript" && format === "ebook") return [
    ["malware", true, "external"], ["archive_safety", true, "inline"], ["epubcheck", true, "external"], ["metadata", true, "inline"], ["images", false, "inline"], ["navigation", true, "inline"], ["links", true, "inline"], ["fonts", false, "inline"], ["fixed_layout", false, "inline"], ["accessibility", false, "inline"], ["render", true, "external"], ["device_compatibility", true, "external"], ["duplicate", true, "inline"],
  ] as const;
  if (kind === "audio") return [["malware", true, "external"], ["audio_integrity", true, "external"], ["duplicate", true, "inline"]] as const;
  return [["malware", true, "external"], ["duplicate", false, "inline"]] as const;
}

function imageDimensions(bytes: Uint8Array, mime: string) {
  if (mime === "image/png" && bytes.length >= 24 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if ((mime === "image/jpeg" || mime === "image/jpg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2; while (p + 9 < bytes.length) { if (bytes[p] !== 0xff) { p++; continue; } const marker = bytes[p + 1], len = (bytes[p + 2] << 8) | bytes[p + 3]; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height:(bytes[p+5]<<8)|bytes[p+6], width:(bytes[p+7]<<8)|bytes[p+8] }; if (len < 2) break; p += 2 + len; }
  }
  return null;
}

async function inspectEpub(bytes: Uint8Array) {
  const issues: { code: string; severity: "warning" | "error"; message: string }[] = [];
  let zip: JSZip; try { zip = await JSZip.loadAsync(bytes); } catch { throw new ApiError(400, "The manuscript is not a readable EPUB archive."); }
  const entries = Object.values(zip.files); if (entries.length > 10000) throw new ApiError(413, "The EPUB contains too many archive entries.");
  let expanded = 0; for (const f of entries) expanded += Number((f as any)._data?.uncompressedSize || 0); if (expanded > 500 * 1024 * 1024 || (bytes.byteLength && expanded / bytes.byteLength > 120)) throw new ApiError(413, "The EPUB expands beyond Cove's archive-safety limits.");
  const mimetype = await zip.file("mimetype")?.async("string"); if (mimetype?.trim() !== "application/epub+zip") issues.push({ code:"MIMETYPE", severity:"error", message:"EPUB mimetype entry is missing or invalid." });
  if (zip.file("META-INF/encryption.xml")) issues.push({ code:"ENCRYPTED", severity:"error", message:"Encrypted/DRM EPUB uploads are not accepted as source manuscripts." });
  const container = await zip.file("META-INF/container.xml")?.async("string"); const rootfile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1]; if (!rootfile) issues.push({ code:"CONTAINER", severity:"error", message:"EPUB package path is missing." });
  const opf = rootfile ? await zip.file(rootfile)?.async("string") : ""; if (!opf) issues.push({ code:"OPF", severity:"error", message:"EPUB package document is missing." });
  const cleanText=(v:string)=>v.replace(/<[^>]+>/g," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim();
  const metaValues=(property:string)=>Array.from(opf.matchAll(new RegExp(`<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}["'][^>]*>([\\s\\S]*?)<\\/meta>|<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}["'][^>]+content=["']([^"']*)["'][^>]*\\/?\\s*>`,"gi"))).map(m=>cleanText(m[1]||m[2]||"")).filter(Boolean);
  const title = cleanText(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]||"");
  const language = cleanText(opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1]||"");
  const packageVersion=opf.match(/<package\b[^>]*\bversion=["']([^"']+)["']/i)?.[1]||"";
  if (!title) issues.push({ code:"METADATA_TITLE", severity:"error", message:"EPUB metadata has no title." }); if (!language) issues.push({ code:"METADATA_LANGUAGE", severity:"warning", message:"EPUB metadata has no primary language." });
  const hasNav=/properties\s*=\s*["'][^"']*\bnav\b/i.test(opf),hasNcx=/media-type\s*=\s*["']application\/x-dtbncx\+xml/i.test(opf); if (!hasNav&&!hasNcx) issues.push({ code:"NAV", severity:"error", message:"EPUB has no navigation document or NCX." });
  const renditionLayout=metaValues("rendition:layout")[0]||(/name=["']fixed-layout["'][^>]+content=["']true["']/i.test(opf)?"pre-paginated":"reflowable"),fixed=renditionLayout==="pre-paginated";
  const pageProgression=(opf.match(/page-progression-direction=["'](ltr|rtl|default)["']/i)?.[1]||metaValues("page-progression-direction")[0]||"default").toLowerCase();
  const primaryWritingMode=(metaValues("primary-writing-mode")[0]||metaValues("rendition:orientation")[0]||"horizontal-tb").toLowerCase();
  const accessModes=[...new Set(metaValues("schema:accessMode").concat(metaValues("accessMode")))];
  const accessibilityFeatures=[...new Set(metaValues("schema:accessibilityFeature").concat(metaValues("accessibilityFeature")))];
  const accessibilityHazards=[...new Set(metaValues("schema:accessibilityHazard").concat(metaValues("accessibilityHazard")))];
  const accessModeSufficient=[...new Set(metaValues("schema:accessModeSufficient").concat(metaValues("accessModeSufficient")))];
  const accessibilitySummary=metaValues("schema:accessibilitySummary")[0]||metaValues("accessibilitySummary")[0]||"";
  const conformsTo=[...new Set(metaValues("dcterms:conformsTo").concat(metaValues("schema:conformsTo")))];
  const certifier=metaValues("a11y:certifiedBy")[0]||metaValues("schema:certifiedBy")[0]||"";
  const certifierCredential=metaValues("a11y:certifierCredential")[0]||"",certifierReport=metaValues("a11y:certifierReport")[0]||"",certificationDate=metaValues("dcterms:modified")[0]||"";
  const fonts = entries.filter(f => /\.(woff2?|ttf|otf)$/i.test(f.name)).map(f => f.name);
  const cssFiles=entries.filter(f=>/\.css$/i.test(f.name)&&!f.dir).slice(0,250);
  let cssText="";for(const f of cssFiles){if(cssText.length>750000)break;cssText+=(await f.async("string")).slice(0,100000);}
  const htmlFiles = entries.filter(f => /\.(xhtml|html|htm)$/i.test(f.name) && !f.dir).slice(0, 1200);
  let broken = 0, images = 0, missingAlt = 0, emptyAlt = 0, headings=0, headingJumps=0, tables=0, tablesWithoutHeaders=0, mathml=0, svg=0, svgMissingTextAlternative=0, footnotes=0, endnotes=0, pagebreaks=0, langNodes=0, remoteResources=0, scriptedContent=0, fingerprintTextSize = 0; const fingerprintTextParts: string[] = [];
  let previousHeading=0,oversizedImages=false;
  const normalize = (base: string, ref: string) => { if (/^(https?:|mailto:|tel:|data:|#)/i.test(ref)) return null; const clean = ref.split("#")[0].split("?")[0]; if (!clean) return null; const stack = base.split("/").slice(0,-1); for (const part of clean.split("/")) { if (!part || part === ".") continue; if (part === "..") stack.pop(); else stack.push(decodeURIComponent(part)); } return stack.join("/"); };
  for (const file of htmlFiles) { const text = await file.async("string"); if (fingerprintTextSize < 500000) { const chunk = text.slice(0, Math.min(50000, 500000 - fingerprintTextSize)); fingerprintTextParts.push(chunk); fingerprintTextSize += chunk.length; }
    for (const m of text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) { const p = normalize(file.name, m[1]); if (p && !zip.file(p)) broken++; }
    for (const m of text.matchAll(/<(img|audio|video|source|link|iframe|object|embed|image)\b[^>]*(?:src|href|xlink:href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (/^(?:https?:)?\/\//i.test(m[2])) remoteResources++;
    scriptedContent += (text.match(/<script\b/gi)||[]).length;
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) { images++; const tag=m[0],alt=tag.match(/\balt\s*=\s*["']([^"']*)["']/i); if (!alt) missingAlt++; else if(!alt[1].trim())emptyAlt++; const w=Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1]||0),h=Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1]||0);if(w>5000||h>5000)oversizedImages=true; }
    for(const m of text.matchAll(/<h([1-6])\b/gi)){const level=Number(m[1]);headings++;if(previousHeading&&level>previousHeading+1)headingJumps++;previousHeading=level;}
    for(const m of text.matchAll(/<table\b[\s\S]*?<\/table>/gi)){tables++;if(!/<th\b/i.test(m[0]))tablesWithoutHeaders++;}
    mathml+=(text.match(/<math\b/gi)||[]).length;svg+=(text.match(/<svg\b/gi)||[]).length;
    for(const m of text.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)){const node=m[0];if(!/aria-hidden\s*=\s*["']true["']/i.test(node)&&!/(?:aria-label|aria-labelledby)\s*=/i.test(node)&&!/<(?:title|desc)\b/i.test(node))svgMissingTextAlternative++;}
    footnotes+=(text.match(/epub:type=["'][^"']*\bfootnote\b/gi)||[]).length;endnotes+=(text.match(/epub:type=["'][^"']*\bendnote\b/gi)||[]).length;pagebreaks+=(text.match(/epub:type=["'][^"']*\bpagebreak\b/gi)||[]).length;langNodes+=(text.match(/(?:xml:lang|\blang)=["'][^"']+["']/gi)||[]).length;
  }
  remoteResources += (cssText.match(/url\(\s*["']?(?:https?:)?\/\//gi)||[]).length + (cssText.match(/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//gi)||[]).length;
  const mediaOverlays=/media-overlay\s*=/i.test(opf),dictionaryContent=/<dc:type[^>]*>\s*dictionary\s*<\/dc:type>/i.test(opf)||/epub:type=["'][^"']*\bdictionary\b/i.test(fingerprintTextParts.join("\n"));
  const verticalWriting=/writing-mode\s*:\s*(vertical|tb-|sideways)/i.test(cssText)||/^vertical/.test(primaryWritingMode),rtl=pageProgression==="rtl"||/direction\s*:\s*rtl/i.test(cssText);
  const complexCss=/(position\s*:\s*(absolute|fixed)|transform\s*:|columns?\s*:|float\s*:|writing-mode\s*:|shape-outside\s*:)/i.test(cssText);
  if (broken) issues.push({ code:"BROKEN_LINKS", severity:"error", message:`${broken} internal EPUB references could not be resolved.` });
  if (remoteResources) issues.push({ code:"REMOTE_RESOURCES", severity:"error", message:`${remoteResources} remote resource reference${remoteResources===1?"":"s"} would require network access while reading. Package required assets inside the EPUB.` });
  if (scriptedContent) issues.push({ code:"SCRIPTED_CONTENT", severity:"error", message:`${scriptedContent} scripted content reference${scriptedContent===1?"":"s"} detected. Cove strips executable EPUB scripting for reader security; publish a non-scripted fallback edition.` });
  if (missingAlt) issues.push({ code:"MISSING_ALT", severity:"warning", message:`${missingAlt} images do not declare alt text.` });
  if (svgMissingTextAlternative) issues.push({ code:"SVG_TEXT_ALTERNATIVE", severity:"warning", message:`${svgMissingTextAlternative} inline SVG graphic${svgMissingTextAlternative===1?"":"s"} lack a title, description, ARIA label, or explicit decorative marker.` });
  if (!headings && htmlFiles.length > 1) issues.push({code:"HEADING_STRUCTURE",severity:"warning",message:"No semantic heading elements were detected across the EPUB content documents."});
  if (headingJumps) issues.push({code:"HEADING_STRUCTURE",severity:"warning",message:`${headingJumps} heading transitions skip a semantic level.`});
  if (tablesWithoutHeaders) issues.push({code:"TABLE_SEMANTICS",severity:"warning",message:`${tablesWithoutHeaders} tables do not contain header cells.`});
  const claimedConformance=conformsTo.some(v=>/EPUB Accessibility|wcag/i.test(v));
  const requiredAccessibilityMetadata=accessModes.length>0&&accessibilityFeatures.length>0&&accessibilityHazards.length>0;
  if(!requiredAccessibilityMetadata)issues.push({code:"ACCESSIBILITY_METADATA",severity:claimedConformance?"error":"warning",message:"EPUB accessibility discoverability metadata is incomplete (accessMode, accessibilityFeature, accessibilityHazard)."});
  if(claimedConformance&&(missingAlt||headingJumps||tablesWithoutHeaders||!language))issues.push({code:"ACCESSIBILITY_CONFORMANCE_MISMATCH",severity:"error",message:"The EPUB claims accessibility conformance but Cove detected unresolved structural/accessibility issues."});
  const altTextComplete=missingAlt===0&&svgMissingTextAlternative===0,semanticStructure=headings>0&&headingJumps===0,tableSemantics=tablesWithoutHeaders===0;
  const mathmlDeclaredAccessible=mathml>0&&accessibilityFeatures.some(v=>/^mathml$/i.test(v.trim()));
  if(mathml>0&&!mathmlDeclaredAccessible)issues.push({code:"MATHML_DISCLOSURE",severity:"warning",message:"MathML is present, but the EPUB accessibility metadata does not declare the MathML accessibility feature."});
  const nonvisualReading=fixed&&images>0&&!altTextComplete?"not_supported":altTextComplete&&semanticStructure&&!!language?"supported":"partial";
  const visualAdjustments=fixed?"not_supported":"supported";
  const validationStatus=issues.some(i=>i.severity==="error")?"failed":issues.length?"warning":"passed";
  const accessibility={visualAdjustments,nonvisualReading,primaryLanguageDeclared:!!language,readingOrderVerified:(hasNav||hasNcx)&&broken===0,altTextComplete,semanticStructure,tableSemanticsComplete:tableSemantics,mathmlPresent:mathml>0,mathmlAccessible:mathmlDeclaredAccessible,accessibilityNavigation:hasNav,pageNavigation:pagebreaks>0,accessModes,accessModeSufficient,features:accessibilityFeatures,hazards:accessibilityHazards,conformsTo,summary:accessibilitySummary,certification:{certifier,credential:certifierCredential,report:certifierReport,date:certificationDate},validationPolicyVersion:"fore-epub-accessibility-v1",validationStatus};
  let compatibilityClass:"reflowable_standard"|"reflowable_complex"|"fixed_layout"|"comic_manga"|"picture_book"|"dictionary"|"unknown"=dictionaryContent?"dictionary":fixed?(images>Math.max(8,htmlFiles.length/2)?"comic_manga":"fixed_layout"):(complexCss||verticalWriting?"reflowable_complex":"reflowable_standard");
  const warnings:string[]=[];if(fixed)warnings.push("Fixed-layout content does not support Cove text-size or line-spacing overrides.");if(verticalWriting)warnings.push("Vertical writing relies on publisher CSS and may vary by browser engine.");if(mediaOverlays)warnings.push("Embedded EPUB media overlays are detected but Cove uses its separate audiobook/Biosync system for synchronized audio.");if(oversizedImages)warnings.push("Oversized images are scaled in reflowable reading mode.");if(dictionaryContent)warnings.push("Dictionary semantics are preserved, but Cove does not yet provide a dedicated dictionary lookup/navigation mode.");if(complexCss)warnings.push("Complex publisher CSS is preserved where safe and may render differently across browser engines.");if(remoteResources)warnings.push("Remote resource dependencies are not supported for commercial publication or offline reading.");if(scriptedContent)warnings.push("Executable EPUB scripting is not supported and is stripped by the Cove reader.");
  const readerSupport=(remoteResources||scriptedContent)?"unsupported":(mediaOverlays||fixed||verticalWriting||dictionaryContent||complexCss)?"supported_with_limits":"full";
  const formatProfile={epubVersion:packageVersion.startsWith("2")?"EPUB 2":packageVersion.startsWith("3")?"EPUB 3":"EPUB",packageVersion,navigationType:hasNav&&hasNcx?"both":hasNav?"epub3_nav":hasNcx?"ncx":"unknown",renditionLayout,pageProgressionDirection:pageProgression,writingMode:verticalWriting?(primaryWritingMode.startsWith("vertical")?primaryWritingMode:"vertical-rl"):"horizontal-tb",rtl,verticalWriting,complexCss,embeddedFonts:fonts.length>0,svg:svg>0,mathml:mathml>0,complexTables:tables>0,footnotes:footnotes>0,endnotes:endnotes>0,dictionaryContent,mediaOverlays,oversizedImages,accessibilityNavigation:hasNav,compatibilityClass,readerSupport,features:{fontCount:fonts.length,imageCount:images,htmlFileCount:htmlFiles.length,tableCount:tables,mathmlCount:mathml,svgCount:svg,svgMissingTextAlternativeCount:svgMissingTextAlternative,footnoteCount:footnotes,endnoteCount:endnotes,pagebreakCount:pagebreaks,langNodeCount:langNodes,remoteResourceCount:remoteResources,scriptedContentCount:scriptedContent},warnings};
  return { zip, expandedBytes: expanded, metadata: { title, language, packageVersion, fixedLayout: fixed, accessibilityMetadata: requiredAccessibilityMetadata, fontCount: fonts.length, imageCount: images, brokenInternalReferences: broken, missingAlt,emptyAlt,accessibility,formatProfile }, fingerprintText: fingerprintTextParts.join("\n").slice(0,500000), issues };
}

export async function readBoundedPublishingUpload(request: Request, limit: number) {
  const length = Number(request.headers.get("content-length") || 0); if (length > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit."); chunks.push(value); }
  const out = new Uint8Array(total); let p = 0; for (const c of chunks) { out.set(c, p); p += c.byteLength; } return out;
}
export function publishingUploadLimit(kind: string) { return kind === "audio" ? 750 * 1024 * 1024 : kind === "manuscript" ? 150 * 1024 * 1024 : kind === "cover" ? 25 * 1024 * 1024 : 100 * 1024 * 1024; }

async function recordInlineResult(db: PublishingDB, jobId: string, versionId: string, check: string, status: "passed"|"warning"|"failed"|"blocked", issues: any[] = [], validator = "fore-inline", version = "1") {
  const at = now();
  await db.batch([
    db.prepare("UPDATE publishing_validation_jobs SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?").bind(status, status === "failed" || status === "blocked" ? cleanText(issues[0]?.message || "Validation failed", 1000) : "", at, jobId),
    db.prepare("INSERT INTO publishing_validation_results(id,job_id,asset_version_id,check_type,validator_name,validator_version,status,issue_count,issues_json,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id("pubval"), jobId, versionId, check, validator, version, status, issues.length, JSON.stringify(issues), at),
  ]);
}

async function refreshAssetValidationSummary(db: PublishingDB, assetVersionId: string) {
  const jobs = (await db.prepare("SELECT status,required FROM publishing_validation_jobs WHERE asset_version_id=?").bind(assetVersionId).all<any>()).results;
  const required = jobs.filter(j => Number(j.required) === 1); let summary = "pending", quarantine = "quarantined";
  if (required.some(j => ["failed","blocked"].includes(String(j.status)))) summary = "blocked", quarantine = "rejected";
  else if (required.some(j => ["queued","leased"].includes(String(j.status)))) summary = required.some(j => String(j.status) === "leased") ? "running" : "pending", quarantine = "scanning";
  else if (required.every(j => String(j.status) === "passed")) { summary = jobs.some(j => String(j.status) === "warning") ? "warning" : "passed"; quarantine = "clean"; }
  else summary = "blocked";
  await db.prepare("UPDATE publishing_asset_versions SET validation_summary=?,quarantine_status=? WHERE id=?").bind(summary, quarantine, assetVersionId).run();
  return { summary, quarantine };
}

export async function uploadPublishingAsset(env: PublishingEnv, userId: string, input: { editionId: string; kind: string; filename: string; mimeType: string; bytes: Uint8Array }) {
  if (!env.BUCKET) throw new ApiError(503, "Publishing asset storage is not configured.");
  const edition = await editionAccess(env.DB, userId, input.editionId, "editor"); const kind = z.enum(["manuscript","cover","supplement","audio"]).parse(input.kind);
  if (!["draft","changes_requested"].includes(String(edition.status))) throw new ApiError(409, "Open a new publishing revision before replacing production assets.");
  if (!input.bytes.byteLength) throw new ApiError(400, "The uploaded file is empty."); if (input.bytes.byteLength > publishingUploadLimit(kind)) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
  const mime = cleanText(input.mimeType || "application/octet-stream", 120).toLowerCase();
  if (kind === "manuscript" && edition.format === "ebook" && !(mime === "application/epub+zip" || input.filename.toLowerCase().endsWith(".epub"))) throw new ApiError(415, "Cove Publishing currently accepts EPUB source manuscripts for eBooks.");
  if (kind === "cover" && !["image/jpeg","image/png"].includes(mime)) throw new ApiError(415, "Cover artwork must be JPEG or PNG.");
  const digest = await sha256Hex(input.bytes), at = now();
  let asset = await env.DB.prepare("SELECT * FROM publishing_assets WHERE edition_id=? AND kind=?").bind(input.editionId, kind).first<any>();
  const assetId = asset?.id || id("pubasset"), previousCount = Number((await env.DB.prepare("SELECT max(version_number) n FROM publishing_asset_versions WHERE asset_id=?").bind(assetId).first<any>())?.n || 0), versionNumber = previousCount + 1, versionId = id("pubassetv");
  const ext = kind === "cover" ? (mime === "image/png" ? "png" : "jpg") : kind === "manuscript" ? "epub" : input.filename.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(0,8) || "bin";
  const objectKey = `publishing/quarantine/${edition.account_id}/${input.editionId}/${assetId}/${versionId}/source.${ext}`;
  let metadata: Record<string, unknown> = {}; let fingerprintText = "";
  if (kind === "manuscript" && edition.format === "ebook") { const result = await inspectEpub(input.bytes); metadata = result.metadata; fingerprintText = result.fingerprintText; }
  if (kind === "cover") { const dims = imageDimensions(input.bytes, mime); if (!dims) throw new ApiError(400, "Cove could not read the cover image dimensions."); metadata = dims; if (dims.width < 1000 || dims.height < 1400) metadata.coverWarning = "Cover is below Cove's recommended production dimensions."; if (dims.height <= dims.width) throw new ApiError(400, "Book cover artwork must be portrait-oriented."); }
  await env.BUCKET.put(objectKey, input.bytes, { httpMetadata: { contentType: mime }, customMetadata: { sha256: digest, source: "fore-publishing-quarantine" } });
  const checks = publishingChecks(kind, String(edition.format)); const jobs = checks.map(([check, required, execution]) => ({ jobId: id("pubjob"), check, required, execution }));
  try {
    const statements: any[] = [];
    if (!asset) statements.push(env.DB.prepare("INSERT INTO publishing_assets(id,edition_id,kind,required,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(assetId, input.editionId, kind, ["manuscript","cover"].includes(kind) ? 1 : 0, at, at));
    statements.push(env.DB.prepare("INSERT INTO publishing_asset_versions(id,asset_id,version_number,object_key,original_filename,mime_type,size_bytes,sha256,quarantine_status,extracted_metadata_json,validation_summary,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?, 'quarantined',?,'pending',?,?)").bind(versionId, assetId, versionNumber, objectKey, cleanText(input.filename, 240), mime, input.bytes.byteLength, digest, JSON.stringify(metadata), userId, at));
    statements.push(env.DB.prepare("UPDATE publishing_assets SET current_version_id=?,updated_at=? WHERE id=?").bind(versionId, at, assetId));
    for (const j of jobs) statements.push(env.DB.prepare("INSERT INTO publishing_validation_jobs(id,asset_version_id,check_type,required,execution_class,status,priority,available_at,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,'queued',100,?,?,?,?)").bind(j.jobId, versionId, j.check, j.required ? 1 : 0, j.execution, at, `${versionId}:${j.check}:v1`, at, at));
    await env.DB.batch(statements);
  } catch (e) { await env.BUCKET.delete(objectKey); throw e; }
  // Run cheap deterministic checks immediately. Production-only services remain queued and fail closed.
  let epubInspection: Awaited<ReturnType<typeof inspectEpub>> | null = null;
  if (kind === "manuscript" && edition.format === "ebook") {
    epubInspection = await inspectEpub(input.bytes);
    await env.DB.prepare("INSERT INTO publishing_epub_inspections(asset_version_id,inspection_version,metadata_json,accessibility_json,format_profile_json,issue_summary_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(versionId,"fore-epub-inspection-v1",JSON.stringify(epubInspection.metadata),JSON.stringify(epubInspection.metadata.accessibility),JSON.stringify(epubInspection.metadata.formatProfile),JSON.stringify(epubInspection.issues),at).run();
  }
  for (const j of jobs.filter(j => j.execution === "inline")) {
    let status: "passed"|"warning"|"failed" = "passed", issues: any[] = [];
    if (j.check === "archive_safety") { issues = epubInspection?.issues.filter(i => i.code === "SCRIPTED_CONTENT") || []; status = issues.some(i=>i.severity==="error") ? "failed" : "passed"; }
    else if (j.check === "metadata") { issues = epubInspection?.issues.filter(i => i.code.startsWith("METADATA") || ["MIMETYPE","CONTAINER","OPF","ENCRYPTED"].includes(i.code)) || []; status = issues.some(i=>i.severity==="error") ? "failed" : issues.length ? "warning" : "passed"; }
    else if (j.check === "navigation") { issues = epubInspection?.issues.filter(i => i.code === "NAV") || []; status = issues.length ? "failed" : "passed"; }
    else if (j.check === "links") { issues = epubInspection?.issues.filter(i => ["BROKEN_LINKS","REMOTE_RESOURCES"].includes(i.code)) || []; status = issues.some(i=>i.severity==="error") ? "failed" : issues.length ? "warning" : "passed"; }
    else if (j.check === "accessibility") { issues = epubInspection?.issues.filter(i => ["MISSING_ALT","SVG_TEXT_ALTERNATIVE","HEADING_STRUCTURE","TABLE_SEMANTICS","ACCESSIBILITY_METADATA","ACCESSIBILITY_CONFORMANCE_MISMATCH","METADATA_LANGUAGE","MATHML_DISCLOSURE"].includes(i.code)) || []; status = issues.some(i=>i.severity==="error") ? "failed" : issues.length ? "warning" : "passed"; }
    else if (j.check === "cover") { const dims = metadata as any; issues = dims.coverWarning ? [{code:"COVER_DIMENSIONS",severity:"warning",message:dims.coverWarning}] : []; status = issues.length ? "warning" : "passed"; }
    else if (j.check === "duplicate") {
      const matches = (await env.DB.prepare(`SELECT v.id,v.asset_id FROM publishing_asset_versions v WHERE v.sha256=? AND v.id<>? LIMIT 10`).bind(digest, versionId).all<any>()).results;
      const catalog = (await env.DB.prepare("SELECT id,asset_id FROM asset_versions WHERE sha256=? LIMIT 10").bind(digest).all<any>()).results;
      if (matches.length || catalog.length) { status = "warning"; issues = [{code:"EXACT_DUPLICATE",severity:"warning",message:"Identical content already exists in Cove. Review is required before publication."}]; const dups:any[]=[]; for (const m of matches) dups.push(env.DB.prepare("INSERT INTO publishing_duplicate_matches(id,asset_version_id,matched_asset_version_id,match_type,confidence,disposition,created_at,updated_at) VALUES(?,?,?,'exact_hash',1,'review',?,?)").bind(id("pubdup"),versionId,m.id,at,at)); for (const m of catalog) dups.push(env.DB.prepare("INSERT INTO publishing_duplicate_matches(id,asset_version_id,match_type,confidence,disposition,created_at,updated_at) VALUES(?,?,'exact_hash',1,'review',?,?)").bind(id("pubdup"),versionId,at,at)); if (dups.length) await env.DB.batch(dups); }
    }
    await recordInlineResult(env.DB, j.jobId, versionId, j.check, status, issues);
  }
  await recordAssetFingerprint(env.DB,{assetVersionId:versionId,accountId:String(edition.account_id),editionId:input.editionId,assetKind:kind,exactSha256:digest,text:fingerprintText,metadata});
  const validation = await refreshAssetValidationSummary(env.DB, versionId); await transitionPublishingLifecycle(env.DB,input.editionId,"validation","publisher",userId,"asset_uploaded",{assetVersionId:versionId,kind}); await audit(env.DB, String(edition.account_id), userId, "publishing_asset_version", versionId, "uploaded", { kind, sizeBytes: input.bytes.byteLength, sha256: digest, validation: validation.summary });
  return { assetId, versionId, versionNumber, sha256: digest, quarantineStatus: validation.quarantine, validationSummary: validation.summary, queuedChecks: jobs.filter(j=>j.execution!=="inline").map(j=>j.check), metadata };
}

export async function signPublishingAccessibilityDeclaration(db: PublishingDB, userId: string, raw: unknown) {
  const x=z.object({editionId:z.string().min(1),accessibilitySummary:z.string().trim().max(3000).default(""),certifier:z.string().trim().max(300).default(""),credential:z.string().trim().max(500).default(""),claimsConformance:z.boolean().default(false),knownLimitations:z.string().trim().max(3000).default(""),metadataAccurateAttestation:z.literal(true),signatureName:z.string().trim().min(2).max(200)}).parse(raw);
  const edition=await editionAccess(db,userId,x.editionId,"editor");if(String(edition.format)!=="ebook")throw new ApiError(409,"Accessibility declarations currently apply to EPUB editions.");
  const asset=await db.prepare(`SELECT v.id version_id,i.accessibility_json,i.format_profile_json,i.issue_summary_json FROM publishing_assets a JOIN publishing_asset_versions v ON v.id=a.current_version_id LEFT JOIN publishing_epub_inspections i ON i.asset_version_id=v.id WHERE a.edition_id=? AND a.kind='manuscript' LIMIT 1`).bind(x.editionId).first<any>();
  if(!asset?.version_id||!asset.accessibility_json)throw new ApiError(409,"Upload and inspect the current EPUB before signing its accessibility declaration.");
  const detected=safeJson<any>(asset.accessibility_json,{});if(x.claimsConformance&&detected.validationStatus==="failed")throw new ApiError(409,"This EPUB cannot be declared conformant while Cove's current accessibility validation is failing.");
  const revision=Number(edition.revision||1),existing=await db.prepare("SELECT 1 ok FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?").bind(x.editionId,revision).first<any>();if(existing)throw new ApiError(409,"An immutable accessibility declaration already exists for this revision. Open a new revision to change it.");
  const declaration={policyVersion:"fore-epub-accessibility-v1",sourceAssetVersionId:String(asset.version_id),publisher:{summary:x.accessibilitySummary,certifier:x.certifier,credential:x.credential,claimsConformance:x.claimsConformance,knownLimitations:x.knownLimitations,metadataAccurateAttestation:true,signatureName:x.signatureName},detectedAccessibility:detected,detectedFormat:safeJson<any>(asset.format_profile_json,{}),issues:safeJson<any[]>(asset.issue_summary_json,[])};
  const at=now();await db.prepare("INSERT INTO publishing_accessibility_declarations(edition_id,revision,policy_version,declaration_json,attested_by_user_id,created_at) VALUES(?,?,?,?,?,?)").bind(x.editionId,revision,"fore-epub-accessibility-v1",stableJson(declaration),userId,at).run();
  await audit(db,String(edition.account_id),userId,"publishing_accessibility_declaration",`${x.editionId}:${revision}`,"signed",{sourceAssetVersionId:asset.version_id,claimsConformance:x.claimsConformance});return{editionId:x.editionId,revision,policyVersion:"fore-epub-accessibility-v1",createdAt:at};
}

export async function leasePublishingValidationJobs(db: PublishingDB, raw: unknown) {
  const x = z.object({ workerId: z.string().trim().min(3).max(120), limit: z.number().int().min(1).max(50).default(10), leaseSeconds: z.number().int().min(30).max(900).default(300), executionClasses: z.array(z.enum(["worker","external"])).min(1).max(2).default(["worker","external"]) }).parse(raw), at = now(), expires = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  // Recover abandoned leases before taking new work. Jobs retry up to max_attempts and then
  // fail closed as blocked instead of circulating forever or silently passing.
  await db.batch([
    db.prepare("UPDATE publishing_validation_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,last_error='Previous worker lease expired; retrying.',updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts").bind(at,at,at),
    db.prepare("UPDATE publishing_validation_jobs SET status='blocked',lease_owner=NULL,lease_expires_at=NULL,last_error='Validation exhausted its retry budget.',updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts>=max_attempts").bind(at,at),
  ]);
  const candidates = (await db.prepare(`SELECT id FROM publishing_validation_jobs WHERE status='queued' AND attempts<max_attempts AND available_at<=? AND execution_class IN (${x.executionClasses.map(()=>'?').join(",")}) ORDER BY priority ASC,created_at ASC LIMIT ?`).bind(at, ...x.executionClasses, x.limit).all<any>()).results;
  for (const row of candidates) await db.prepare("UPDATE publishing_validation_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").bind(x.workerId, expires, at, row.id).run();
  const jobs = (await db.prepare(`SELECT j.*,v.object_key,v.mime_type,v.size_bytes,v.sha256,v.original_filename,a.kind,a.edition_id FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE j.status='leased' AND j.lease_owner=? AND j.lease_expires_at=? ORDER BY j.priority,j.created_at`).bind(x.workerId, expires).all<any>()).results;
  return { jobs, leaseExpiresAt: expires };
}

export async function completePublishingValidationJob(db: PublishingDB, raw: unknown) {
  const x = z.object({ jobId: z.string().min(1), workerId: z.string().min(3).max(120), status: z.enum(["passed","warning","failed","blocked"]), validatorName: z.string().min(1).max(120), validatorVersion: z.string().max(80).default(""), issues: z.array(z.object({ code:z.string().max(120), severity:z.enum(["info","warning","error"]).default("error"), message:z.string().max(2000), location:z.string().max(500).optional() })).max(2000).default([]), reportObjectKey: z.string().max(500).nullable().optional(), reportSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional() }).parse(raw);
  const job = await db.prepare("SELECT * FROM publishing_validation_jobs WHERE id=?").bind(x.jobId).first<any>(); if (!job) throw new ApiError(404, "Validation job not found."); if (job.status !== "leased" || job.lease_owner !== x.workerId || (job.lease_expires_at && job.lease_expires_at < now())) throw new ApiError(409, "This validation lease is no longer active.");
  const at = now(); await db.batch([
    db.prepare("UPDATE publishing_validation_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?").bind(x.status, ["failed","blocked"].includes(x.status) ? cleanText(x.issues[0]?.message || "Validation failed", 1000) : "", at, x.jobId),
    db.prepare("INSERT INTO publishing_validation_results(id,job_id,asset_version_id,check_type,validator_name,validator_version,status,issue_count,issues_json,report_object_key,report_sha256,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id("pubval"), x.jobId, job.asset_version_id, job.check_type, x.validatorName, x.validatorVersion, x.status, x.issues.length, JSON.stringify(x.issues), x.reportObjectKey || null, x.reportSha256 || null, at),
  ]);
  if(String(job.check_type)==="malware") await mirrorPublishingMalwareResult(db,{assetVersionId:String(job.asset_version_id),status:x.status,validatorName:x.validatorName,validatorVersion:x.validatorVersion,issues:x.issues,reportObjectKey:x.reportObjectKey||null,reportSha256:x.reportSha256||null});
  const asset = await refreshAssetValidationSummary(db, String(job.asset_version_id)); return { jobId: x.jobId, assetVersionId: job.asset_version_id, ...asset };
}

async function assetStatus(db: PublishingDB, editionId: string) {
  const rows = (await db.prepare(`SELECT a.id,a.kind,a.required,a.current_version_id,v.quarantine_status,v.validation_summary,v.sha256,v.object_key,v.mime_type,v.size_bytes,v.original_filename
    FROM publishing_assets a LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE a.edition_id=? ORDER BY a.kind`).bind(editionId).all<any>()).results;
  return rows;
}

export async function publishingReadiness(db: PublishingDB, userId: string, editionId: string) {
  const edition = await editionAccess(db, userId, editionId, "analyst"), account = await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(edition.account_id).first<any>();
  const contributors = (await db.prepare("SELECT * FROM publishing_edition_contributors WHERE edition_id=? ORDER BY position").bind(editionId).all<any>()).results, assets = await assetStatus(db, editionId);
  const blockers: string[] = [];
  if (!account?.terms_accepted_at) blockers.push("Accept the current Cove Publishing agreement.");
  const legalAddress = await db.prepare("SELECT id FROM publishing_addresses WHERE account_id=? AND address_type='legal' LIMIT 1").bind(edition.account_id).first<any>();
  if (!legalAddress) blockers.push("Add a legal business/residential address.");
  if (account?.identity_status !== "verified") blockers.push("Identity verification must be complete.");
  if (account?.tax_status !== "verified") blockers.push("Tax information must be validated.");
  if (account?.payout_status !== "verified") blockers.push("A verified payout method is required.");
  if (!contributors.some(c => c.role === "author")) blockers.push("Add at least one author/contributor.");
  if (!edition.description?.trim()) blockers.push("Add a book description.");
  if (Number(edition.list_price_minor) < 0) blockers.push("Set a valid list price.");
  if (edition.format === "ebook" && !assets.some(a => a.kind === "manuscript")) blockers.push("Upload an EPUB manuscript.");
  if (!assets.some(a => a.kind === "cover")) blockers.push("Upload cover artwork.");
  for (const a of assets.filter(a => Number(a.required) === 1)) if (a.validation_summary !== "passed" && a.validation_summary !== "warning") blockers.push(`${a.kind} validation is not complete.`);
  const openRequired = (await db.prepare(`SELECT count(*) n FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND j.required=1 AND j.status<>'passed'`).bind(editionId).first<any>())?.n || 0;
  if (Number(openRequired) > 0) blockers.push(`${openRequired} required validation check${Number(openRequired)===1?" is":"s are"} still unresolved.`);
  const duplicateReview = (await db.prepare(`SELECT count(*) n FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND d.disposition IN ('review','fraud_hold')`).bind(editionId).first<any>())?.n || 0;
  if (Number(duplicateReview) > 0) blockers.push("Potential duplicate content requires review.");
  const declaration=await db.prepare("SELECT * FROM publishing_rights_declarations WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
  if(!declaration) blockers.push("Sign the Cove publisher rights declaration for this revision.");
  else {
    if(String(declaration.policy_version)!==FORE_RIGHTS_POLICY_VERSION) blockers.push(`Re-sign the publisher rights declaration under the current ${FORE_RIGHTS_POLICY_VERSION} policy.`);
    if(!Number(declaration.authority_attestation)||!Number(declaration.no_infringement_attestation)||!Number(declaration.evidence_complete_attestation)) blockers.push("The rights declaration attestations are incomplete.");
    const evidence=(await db.prepare("SELECT * FROM publishing_rights_evidence WHERE declaration_id=?").bind(declaration.id).all<any>()).results;
    if(["licensed","public_domain"].includes(String(declaration.rights_basis))&&!evidence.length) blockers.push("Upload rights evidence for licensed or public-domain material.");
    if(evidence.some((r:any)=>!["clean"].includes(String(r.scan_status)))) blockers.push("Rights evidence scanning must complete before submission.");
    if(evidence.some((r:any)=>r.verification_status==="rejected")) blockers.push("Rejected rights evidence must be resolved before submission.");
    if(["licensed","public_domain"].includes(String(declaration.rights_basis))&&!evidence.some((r:any)=>r.verification_status==="verified")) blockers.push("Licensed or public-domain material requires at least one staff-verified rights evidence record before submission.");
  }
  const aiDisclosure=await db.prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
  if(!aiDisclosure) blockers.push("Sign the Cove AI-content disclosure for this revision, including fully human-created works.");
  else {
    if(String(aiDisclosure.policy_version)!==FORE_AI_POLICY_VERSION) blockers.push(`Re-sign the AI-content disclosure under the current ${FORE_AI_POLICY_VERSION} policy.`);
    if(edition.format==="audiobook"&&["ai_generated","mixed"].includes(String(aiDisclosure.narration_origin))&&!String(aiDisclosure.synthetic_voice_label||"").trim()) blockers.push("Synthetic or mixed AI narration requires a customer-facing synthetic voice label.");
  }
  let accessibilityDeclaration:any=null;
  if(String(edition.format)==="ebook"){
    const manuscript=assets.find((a:any)=>a.kind==="manuscript");
    accessibilityDeclaration=await db.prepare("SELECT * FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
    if(!accessibilityDeclaration) blockers.push("Sign the Cove EPUB accessibility declaration for this revision, including editions with no formal conformance claim.");
    else {
      if(String(accessibilityDeclaration.policy_version)!=="fore-epub-accessibility-v1") blockers.push("Re-sign the EPUB accessibility declaration under the current Cove accessibility policy.");
      const declaration=safeJson<any>(accessibilityDeclaration.declaration_json,{});
      if(!manuscript?.current_version_id||String(declaration.sourceAssetVersionId||"")!==String(manuscript.current_version_id||"")) blockers.push("The accessibility declaration is bound to an older manuscript. Open a new revision and sign against the current EPUB.");
      const inspection=manuscript?.current_version_id?await db.prepare("SELECT accessibility_json FROM publishing_epub_inspections WHERE asset_version_id=?").bind(manuscript.current_version_id).first<any>():null;
      const detected=safeJson<any>(inspection?.accessibility_json,{});
      if(declaration?.publisher?.claimsConformance&&detected.validationStatus==="failed") blockers.push("The current EPUB fails Cove accessibility validation and cannot retain a formal conformance claim.");
    }
  }
  if(String(edition.rights_basis)==="public_domain"){
    const et=String(edition.edition_type||"original"),summary=String(edition.differentiation_summary||"").trim();
    if(["original","canonical_public_domain"].includes(et)) blockers.push("Public-domain submissions must be a differentiated annotated, translated, illustrated, scholarly, or commercial-audiobook edition. Cove reserves the canonical free edition for its canonical public-domain source.");
    if(!summary) blockers.push("Describe the substantive differentiation in this public-domain edition.");
    if(et==="new_translation"&&!contributors.some(c=>c.role==="translator")) blockers.push("A new translation edition must identify at least one translator.");
    const manuscript=assets.find((a:any)=>a.kind==="manuscript");
    if(manuscript?.sha256){const duplicate=await db.prepare(`SELECT e.id FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND (? IS NULL OR e.id<>?) LIMIT 1`).bind(manuscript.sha256,edition.catalog_edition_id||null,edition.catalog_edition_id||null).first<any>();if(duplicate) blockers.push("This public-domain EPUB is byte-identical to an existing edition. Commercial public-domain editions must add substantive differentiation rather than duplicate the canonical free copy.");}
  }
  const partner=await db.prepare("SELECT production_status,default_contract_id FROM publisher_partner_profiles WHERE account_id=?").bind(edition.account_id).first<any>();
  if(partner&&String(partner.production_status)==="active"){
    if(!edition.contract_id) blockers.push("Production partner titles must be governed by an assigned distribution contract; per-book flags cannot substitute for contract policy.");
    if(edition.contract_id){const assigned=await db.prepare("SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'").bind(edition.account_id,edition.contract_id).first<any>();if(!assigned)blockers.push("The selected distribution contract is not actively assigned to this publisher.");}
    if(edition.contract_version_id){const active=await db.prepare("SELECT 1 ok FROM rights_contract_versions WHERE id=? AND contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)").bind(edition.contract_version_id,edition.contract_id,now(),now()).first<any>();if(!active)blockers.push("The selected distribution contract version is not currently effective.");}
  }
  const similarityReview=(await db.prepare(`SELECT count(*) n FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND sm.cross_account=1 AND sm.disposition IN ('review','fraud_hold') AND sm.score>=.95`).bind(editionId).first<any>())?.n||0;
  if(Number(similarityReview)>0) blockers.push("High-confidence cross-publisher content similarity requires review.");
  let commercialAudio:any=null;
  if(String(edition.format)==="audiobook"){commercialAudio=await commercialAudioReadiness(db as any,editionId);blockers.push(...commercialAudio.blockers);}

  return { ready: blockers.length === 0, blockers, account: { identityStatus:account?.identity_status, taxStatus:account?.tax_status, payoutStatus:account?.payout_status, termsAccepted:!!account?.terms_accepted_at }, assets, contributors, rightsDeclaration:declaration?{id:declaration.id,status:declaration.status,rightsBasis:declaration.rights_basis}:null, aiDisclosure:aiDisclosure?{id:aiDisclosure.id,policyVersion:aiDisclosure.policy_version,textOrigin:aiDisclosure.text_origin,coverOrigin:aiDisclosure.cover_origin,narrationOrigin:aiDisclosure.narration_origin}:null, accessibilityDeclaration:accessibilityDeclaration?{policyVersion:accessibilityDeclaration.policy_version,revision:Number(accessibilityDeclaration.revision||0),createdAt:accessibilityDeclaration.created_at}:null, commercialAudio };

}

export async function submitPublishingEdition(env: PublishingEnv, userId: string, editionId: string) {
  const db=env.DB,edition = await editionAccess(db, userId, editionId, "editor"), lifecycle=await ensurePublishingLifecycle(db,editionId);
  if(["suppressed","takedown","retired"].includes(String(lifecycle.state)))throw new ApiError(409,"This release is under staff enforcement and cannot be submitted until Cove restores it.");
  const readiness = await publishingReadiness(db, userId, editionId); if (!readiness.ready) throw new ApiError(409, readiness.blockers.join(" "));
  const title = await db.prepare("SELECT * FROM publishing_titles WHERE id=?").bind(edition.title_id).first<any>(), account = await db.prepare("SELECT id,legal_name,display_name,country_code,contact_email,website,identity_status,tax_status,payout_status,terms_version,terms_accepted_at FROM publishing_accounts WHERE id=?").bind(edition.account_id).first<any>();
  const addresses=(await db.prepare("SELECT address_type,line1,line2,city,region,postal_code,country_code FROM publishing_addresses WHERE account_id=? ORDER BY address_type").bind(edition.account_id).all<any>()).results;
  const tax=await db.prepare("SELECT id,country_code,tax_classification,form_type,provider,provider_reference,status,withholding_bps,treaty_country_code,validated_at,expires_at FROM publishing_tax_profiles WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1").bind(edition.account_id).first<any>();
  const payout=await db.prepare("SELECT id,provider,provider_account_id,method,bank_country_code,payout_currency,account_last4,status,payout_threshold_minor,verified_at FROM publishing_payout_accounts WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1").bind(edition.account_id).first<any>();
  const contributors=(await db.prepare("SELECT pen_name_id,display_name,role,position FROM publishing_edition_contributors WHERE edition_id=? ORDER BY position").bind(editionId).all<any>()).results, assets=readiness.assets;
  const rightsDeclaration=await db.prepare("SELECT * FROM publishing_rights_declarations WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
  const rightsEvidence=rightsDeclaration?(await db.prepare("SELECT id,evidence_type,description,original_filename,mime_type,size_bytes,sha256,scan_status,verification_status,issued_by,issued_at,expires_at,created_at FROM publishing_rights_evidence WHERE declaration_id=? ORDER BY created_at").bind(rightsDeclaration.id).all<any>()).results:[];
  const aiDisclosure=await db.prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
  const accessibilityDeclaration=await db.prepare("SELECT * FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?").bind(editionId,edition.revision).first<any>();
  const commercialAudio=String(edition.format)==="audiobook"?await commercialAudioSubmissionEvidence(db as any,editionId):null;
  const snapshot={ schemaVersion:5, account, addresses, tax, payout, title, edition, contributors, assets, rightsDeclaration, rightsEvidence, aiDisclosure, accessibilityDeclaration, commercialAudio:commercialAudio?.manifest||null, commercialAudioManifestSha256:commercialAudio?.manifestSha256||null, submittedAt:now() }, serialized=stableJson(snapshot), digest=await sha256Hex(serialized), submissionId=id("pubsub"), revision=Number(edition.revision||1), at=now();
  const submissionStatements:any[]=[
    db.prepare("INSERT INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at) VALUES(?,?,?,?,?,?,'submitted',?,?)").bind(submissionId, editionId, edition.account_id, revision, serialized, digest, userId, at),
    db.prepare("UPDATE publishing_edition_drafts SET status='submitted',updated_at=? WHERE id=?").bind(at, editionId),
    db.prepare("UPDATE publishing_titles SET status='in_review',updated_at=? WHERE id=?").bind(at, edition.title_id),
    db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,available_at,created_at) VALUES(?,'publishing.submitted','submission',?,?,?,?)").bind(id("pubout"), submissionId, JSON.stringify({submissionId,editionId,accountId:edition.account_id,snapshotSha256:digest}), at, at),
  ];
  if(commercialAudio)submissionStatements.push(db.prepare("INSERT INTO commercial_audio_submission_snapshots(submission_id,edition_id,policy_id,manifest_json,manifest_sha256,created_at) VALUES(?,?,?,?,?,?)").bind(submissionId,editionId,commercialAudio.policyId,commercialAudio.manifestJson,commercialAudio.manifestSha256,at));
  await db.batch(submissionStatements);
  await transitionPublishingLifecycle(db,editionId,"submitted","publisher",userId,"submitted",{submissionId,revision,snapshotSha256:digest});
  await transitionPublishingLifecycle(db,editionId,"automated_review","automation",null,"automated_review_started",{submissionId});
  await assessSubmissionContentPolicy(db,submissionId);
  const automated=await runAutomatedPublishingReview(db,submissionId),publisherRisk=await assessPublisherRisk(db,String(edition.account_id),"publishing_submission"),autoApprove=automated.outcome==="pass"&&!(["hold","block"].includes(publisherRisk.action))&&String(env.FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK||"false").toLowerCase()==="true";
  if(autoApprove){
    const decided=now();await db.batch([db.prepare("UPDATE publishing_submission_snapshots SET status='approved',decided_at=? WHERE id=?").bind(decided,submissionId),db.prepare("UPDATE publishing_edition_drafts SET status='approved',updated_at=? WHERE id=?").bind(decided,editionId)]);
    await transitionPublishingLifecycle(db,editionId,"approved","automation",null,"automated_low_risk_approval",{submissionId,riskScore:Number(automated.risk_score||0)});
    const publication=await materializePublishingSubmission(env,submissionId,"system:automated-review");
    await audit(db, String(edition.account_id), userId, "publishing_submission", submissionId, "auto_approved", { editionId, revision, snapshotSha256:digest, automatedOutcome:automated.outcome, automatedRiskScore:automated.risk_score,publicationVersionId:publication.publicationVersionId });
    try{const members=(await db.prepare("SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','editor')").bind(edition.account_id).all<any>()).results;for(const m of members)await emitNotification(db,{userId:String(m.user_id),eventType:"publisher_book_approved",dedupeKey:`publishing-auto-review:${submissionId}:${m.user_id}`,title:`${title?.title||"Your book"} approved`,body:"Cove's automated publishing review approved this low-risk submission and published it.",subjectType:"publishing_submission",subjectId:submissionId,actionUrl:"/publishing",payload:{submissionId,editionId,decision:"approve",automated:true,publicationVersionId:publication.publicationVersionId}});}catch(e){console.error("Automated publishing approval notification enqueue failed",e);}
    return { submissionId, snapshotSha256:digest, status:"published", lifecycleState:publication.releaseState, automatedReview:{outcome:automated.outcome,riskScore:automated.risk_score},publisherRisk:{score:publisherRisk.score,level:publisherRisk.level,action:publisherRisk.action},publication };
  }
  await db.prepare("UPDATE publishing_submission_snapshots SET status='in_review' WHERE id=?").bind(submissionId).run();
  await transitionPublishingLifecycle(db,editionId,"human_review","automation",null,automated.outcome==="pass"?"human_review_policy":`automated_${automated.outcome}`,{submissionId,riskScore:Number(automated.risk_score||0),caseId:(automated as any).caseId||null});
  await audit(db, String(edition.account_id), userId, "publishing_submission", submissionId, "submitted", { editionId, revision, snapshotSha256:digest, automatedOutcome:automated.outcome, automatedRiskScore:automated.risk_score });
  return { submissionId, snapshotSha256:digest, status:"in_review", lifecycleState:"human_review", automatedReview:{outcome:automated.outcome,riskScore:automated.risk_score},publisherRisk:{score:publisherRisk.score,level:publisherRisk.level,action:publisherRisk.action} };
}

export async function openPublishingRevision(db: PublishingDB, userId: string, editionId: string) {
  const edition=await editionAccess(db,userId,editionId,"editor");
  if(!["published","approved","submitted","changes_requested","withdrawn"].includes(String(edition.status))) throw new ApiError(409,"This edition is already editable.");
  const lifecycle=await ensurePublishingLifecycle(db,editionId);
  if(["suppressed","takedown","retired"].includes(String(lifecycle.state))) throw new ApiError(409,"This release must be restored by Cove staff before a publisher update can be opened.");
  const at=now(),nextRevision=Number(edition.revision||1)+1;
  await db.batch([db.prepare("UPDATE publishing_submission_snapshots SET status='withdrawn',decided_at=COALESCE(decided_at,?) WHERE edition_id=? AND revision=? AND status IN ('submitted','in_review','approved')").bind(at,editionId,Number(edition.revision||1)),db.prepare("UPDATE publishing_edition_drafts SET status='draft',revision=?,updated_at=? WHERE id=?").bind(nextRevision,at,editionId)]);
  await transitionPublishingLifecycle(db,editionId,"draft","publisher",userId,"publisher_update_opened",{revision:nextRevision,currentlyLive:!!edition.catalog_product_id});
  await audit(db,String(edition.account_id),userId,"publishing_edition",editionId,"revision_opened",{revision:nextRevision});
  return {editionId,revision:nextRevision,status:"draft"};
}

export async function setPublishingUpdatePolicy(db: PublishingDB,userId:string,raw:unknown){
  const x=z.object({editionId:z.string().min(1),policy:z.enum(["auto_update","manual_opt_in","preserve_purchased_version"])}).parse(raw),edition=await editionAccess(db,userId,x.editionId,"admin"),lifecycle=await ensurePublishingLifecycle(db,x.editionId),at=now();
  await db.prepare("UPDATE publishing_release_lifecycles SET owner_update_policy=?,updated_at=? WHERE id=?").bind(x.policy,at,lifecycle.id).run();
  let pinnedExistingOwners=0;
  if(x.policy!=="auto_update"&&lifecycle.current_publication_version_id){
    const product=await db.prepare(`SELECT p.product_id FROM publishing_publication_versions pv JOIN publishing_publications p ON p.id=pv.publication_id WHERE pv.id=?`).bind(lifecycle.current_publication_version_id).first<any>();
    if(product?.product_id){
      const entitlements=(await db.prepare("SELECT id,user_id FROM entitlements WHERE product_id=? AND entitlement_type='purchase' AND status='active'").bind(product.product_id).all<any>()).results;
      for(const ent of entitlements){const exists=await db.prepare("SELECT entitlement_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?").bind(ent.id).first<any>();if(exists)continue;await db.prepare("INSERT INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?)").bind(ent.id,lifecycle.id,lifecycle.current_publication_version_id,x.policy,at,at).run();await db.prepare("INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,?,?,'policy_pin',?,?)").bind(id("ownevt"),ent.id,lifecycle.id,null,lifecycle.current_publication_version_id,userId,at).run();pinnedExistingOwners++;}
    }
  }
  await audit(db,String(edition.account_id),userId,"publishing_release",lifecycle.id,"owner_update_policy_changed",{policy:x.policy,pinnedExistingOwners});return{saved:true,policy:x.policy,pinnedExistingOwners};
}

export async function optInOwnedPublicationUpdate(db: PublishingDB,userId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1)}).parse(raw),ent=await db.prepare("SELECT * FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase' AND status='active' ORDER BY granted_at DESC LIMIT 1").bind(userId,x.productId).first<any>();if(!ent)throw new ApiError(403,"An active purchase entitlement is required.");
  const lifecycle=await db.prepare(`SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=? LIMIT 1`).bind(x.productId).first<any>();if(!lifecycle||!lifecycle.current_publication_version_id)throw new ApiError(404,"This product does not have a versioned Cove Publishing release.");
  if(lifecycle.owner_update_policy!=="manual_opt_in")throw new ApiError(409,"This title does not use manual owner updates.");
  const prior=await db.prepare("SELECT publication_version_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?").bind(ent.id).first<any>(),at=now();
  if(prior?.publication_version_id===lifecycle.current_publication_version_id)return{updated:false,publicationVersionId:lifecycle.current_publication_version_id};
  await db.prepare(`INSERT INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entitlement_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,publication_version_id=excluded.publication_version_id,policy_at_grant=excluded.policy_at_grant,updated_at=excluded.updated_at`).bind(ent.id,lifecycle.id,lifecycle.current_publication_version_id,"manual_opt_in",at,at).run();
  await db.prepare("INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,?,?,'owner_opt_in',?,?)").bind(id("ownevt"),ent.id,lifecycle.id,prior?.publication_version_id||null,lifecycle.current_publication_version_id,userId,at).run();return{updated:true,publicationVersionId:lifecycle.current_publication_version_id};
}

function scopeToGrant(scope: any) {
  const mode = scope?.mode || "worldwide"; if (mode === "single") return { scopeMode:"single" as const, territory:String(scope.territory||"US").toUpperCase() };
  if (mode === "set") return { scopeMode:"set" as const, territorySetId:String(scope.territorySetId||"WORLD") };
  if (mode === "expression") return { scopeMode:"expression" as const, includeTerritories:(scope.include||[]).map((x:string)=>x.toUpperCase()), excludeTerritories:(scope.exclude||[]).map((x:string)=>x.toUpperCase()), includeSetIds:scope.includeSetIds||[], excludeSetIds:scope.excludeSetIds||[] };
  return { scopeMode:"worldwide" as const, excludeTerritories:(scope.exclude||[]).map((x:string)=>x.toUpperCase()) };
}
async function bucketBytes(env: PublishingEnv, key: string) { const obj = await env.BUCKET?.get(key); if (!obj) throw new ApiError(503, "A publication asset is missing from storage."); return new Uint8Array(await new Response(obj.body).arrayBuffer()); }

async function ensureCatalogParties(db: PublishingDB, account: any, tax: any, payout: any) {
  const at=now(); let publisherId=account.publisher_id, financePartyId=account.finance_party_id, rightsPartyId=account.rights_party_id;
  if (!publisherId) { publisherId=id("publisher"); await db.prepare("INSERT INTO publishers(id,name,website,created_at,updated_at) VALUES(?,?,?,?,?)").bind(publisherId,account.display_name,account.website||"",at,at).run(); }
  if (!rightsPartyId) { const r=await upsertRightsParty(db as any,{displayName:account.display_name,partyType:"publisher",publisherId,contactEmail:account.contact_email||"",referenceCode:`FORE-PUB-${account.id}`,status:"active"}); rightsPartyId=r.id; }
  if (!financePartyId) { financePartyId=id("finparty"); await db.prepare(`INSERT INTO finance_parties(id,party_type,display_name,publisher_id,tax_country,withholding_bps,payout_currency,status,created_at,updated_at) VALUES(?,'publisher',?,?,?,?,?,'active',?,?)`).bind(financePartyId,account.display_name,publisherId,tax?.country_code||account.country_code,Number(tax?.withholding_bps||0),payout?.payout_currency||"USD",at,at).run(); }
  await db.prepare("UPDATE publishing_accounts SET publisher_id=?,finance_party_id=?,rights_party_id=?,status='active',updated_at=? WHERE id=?").bind(publisherId,financePartyId,rightsPartyId,at,account.id).run(); return {publisherId,financePartyId,rightsPartyId};
}

async function publicationVersionManifest(db: PublishingDB, publicationVersionId: string | null | undefined) {
  if(!publicationVersionId)return null;
  const row=await db.prepare("SELECT id,manifest_json FROM publishing_publication_versions WHERE id=?").bind(publicationVersionId).first<any>();
  return row?{id:String(row.id),manifest:safeJson<any>(row.manifest_json,{})}:null;
}

async function syncCatalogAccessibility(db: PublishingDB, manifest: any, at: string) {
  if (!manifest?.catalogEditionId) return;
  const a=manifest.accessibilityProfile||null,f=manifest.formatProfile||null;
  if (a) {
    await db.prepare(`INSERT INTO accessibility_metadata(edition_id,screen_reader_compatible,alt_text_complete,semantic_structure,accessibility_summary,certifier,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET screen_reader_compatible=excluded.screen_reader_compatible,alt_text_complete=excluded.alt_text_complete,semantic_structure=excluded.semantic_structure,accessibility_summary=excluded.accessibility_summary,certifier=excluded.certifier,updated_at=excluded.updated_at`)
      .bind(manifest.catalogEditionId,a.nonvisualReading==="supported"?1:a.nonvisualReading==="not_supported"?0:null,a.altTextComplete?1:0,a.semanticStructure?1:0,a.summary||"",a.certification?.certifier||"",at).run();
    await db.prepare(`INSERT INTO edition_accessibility_profiles(edition_id,source_asset_version_id,visual_adjustments,nonvisual_reading,primary_language_declared,reading_order_verified,table_semantics_complete,mathml_present,mathml_accessible,page_navigation,accessibility_navigation,access_modes_json,access_mode_sufficient_json,features_json,hazards_json,conforms_to_json,certification_json,accessibility_summary,validation_policy_version,validation_status,validation_report_json,publisher_declaration_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET source_asset_version_id=excluded.source_asset_version_id,visual_adjustments=excluded.visual_adjustments,nonvisual_reading=excluded.nonvisual_reading,primary_language_declared=excluded.primary_language_declared,reading_order_verified=excluded.reading_order_verified,table_semantics_complete=excluded.table_semantics_complete,mathml_present=excluded.mathml_present,mathml_accessible=excluded.mathml_accessible,page_navigation=excluded.page_navigation,accessibility_navigation=excluded.accessibility_navigation,access_modes_json=excluded.access_modes_json,access_mode_sufficient_json=excluded.access_mode_sufficient_json,features_json=excluded.features_json,hazards_json=excluded.hazards_json,conforms_to_json=excluded.conforms_to_json,certification_json=excluded.certification_json,accessibility_summary=excluded.accessibility_summary,validation_policy_version=excluded.validation_policy_version,validation_status=excluded.validation_status,validation_report_json=excluded.validation_report_json,publisher_declaration_json=excluded.publisher_declaration_json,updated_at=excluded.updated_at`)
      .bind(manifest.catalogEditionId,manifest.manuscriptCatalogAssetVersionId||null,a.visualAdjustments||"unknown",a.nonvisualReading||"unknown",a.primaryLanguageDeclared?1:0,a.readingOrderVerified?1:0,a.tableSemanticsComplete?1:0,a.mathmlPresent?1:0,a.mathmlAccessible?1:0,a.pageNavigation?1:0,a.accessibilityNavigation?1:0,JSON.stringify(a.accessModes||[]),JSON.stringify(a.accessModeSufficient||[]),JSON.stringify(a.features||[]),JSON.stringify(a.hazards||[]),JSON.stringify(a.conformsTo||[]),JSON.stringify(a.certification||{}),a.summary||"",a.validationPolicyVersion||"fore-epub-accessibility-v1",a.validationStatus||"unknown",JSON.stringify(a.validationReport||{}),JSON.stringify(a.publisherDeclaration||{}),at).run();
  }
  if (f) {
    await db.prepare(`INSERT INTO edition_format_profiles(edition_id,source_asset_version_id,epub_version,package_version,navigation_type,rendition_layout,page_progression_direction,writing_mode,rtl,vertical_writing,complex_css,embedded_fonts,svg,mathml,complex_tables,footnotes,endnotes,dictionary_content,media_overlays,oversized_images,accessibility_navigation,compatibility_class,reader_support,features_json,warnings_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET source_asset_version_id=excluded.source_asset_version_id,epub_version=excluded.epub_version,package_version=excluded.package_version,navigation_type=excluded.navigation_type,rendition_layout=excluded.rendition_layout,page_progression_direction=excluded.page_progression_direction,writing_mode=excluded.writing_mode,rtl=excluded.rtl,vertical_writing=excluded.vertical_writing,complex_css=excluded.complex_css,embedded_fonts=excluded.embedded_fonts,svg=excluded.svg,mathml=excluded.mathml,complex_tables=excluded.complex_tables,footnotes=excluded.footnotes,endnotes=excluded.endnotes,dictionary_content=excluded.dictionary_content,media_overlays=excluded.media_overlays,oversized_images=excluded.oversized_images,accessibility_navigation=excluded.accessibility_navigation,compatibility_class=excluded.compatibility_class,reader_support=excluded.reader_support,features_json=excluded.features_json,warnings_json=excluded.warnings_json,updated_at=excluded.updated_at`)
      .bind(manifest.catalogEditionId,manifest.manuscriptCatalogAssetVersionId||null,f.epubVersion||"",f.packageVersion||"",f.navigationType||"unknown",f.renditionLayout||"reflowable",f.pageProgressionDirection||"default",f.writingMode||"horizontal-tb",f.rtl?1:0,f.verticalWriting?1:0,f.complexCss?1:0,f.embeddedFonts?1:0,f.svg?1:0,f.mathml?1:0,f.complexTables?1:0,f.footnotes?1:0,f.endnotes?1:0,f.dictionaryContent?1:0,f.mediaOverlays?1:0,f.oversizedImages?1:0,f.accessibilityNavigation?1:0,f.compatibilityClass||"unknown",f.readerSupport||"supported_with_limits",JSON.stringify(f.features||{}),JSON.stringify(f.warnings||[]),at).run();
    await db.prepare("UPDATE editions SET layout=?,epub_version=?,updated_at=? WHERE id=?").bind(f.renditionLayout==="pre-paginated"?"fixed":"reflowable",f.epubVersion||null,at,manifest.catalogEditionId).run();
  }
}

async function activatePublicationCommercialTerms(db: PublishingDB, currentManifest: any, previousManifest: any | null, at: string) {
  const statements:any[]=[];
  const prior=previousManifest||{};
  // Publication approval can precede release by months. Revalidate the exact
  // immutable B2B contract version at the moment commercial terms go live so
  // a scheduled title cannot activate after its distribution authority ended.
  if(currentManifest.rightsContractVersionId){
    const contract=await db.prepare(`SELECT rcv.id,rcv.status,rcv.effective_from,rcv.effective_to,rc.id contract_id,rc.status contract_status,rc.effective_from contract_effective_from,rc.effective_to contract_effective_to
      FROM rights_contract_versions rcv JOIN rights_contracts rc ON rc.id=rcv.contract_id WHERE rcv.id=? AND rc.id=?`).bind(currentManifest.rightsContractVersionId,currentManifest.rightsContractId).first<any>();
    const effective=contract&&String(contract.status)==="active"&&String(contract.contract_status)==="active"&&String(contract.effective_from)<=at&&(!contract.effective_to||String(contract.effective_to)>at)&&(!contract.contract_effective_from||String(contract.contract_effective_from)<=at)&&(!contract.contract_effective_to||String(contract.contract_effective_to)>at);
    if(!effective)throw new ApiError(409,"This publication's approved distribution contract version is no longer active/effective. Cove will not activate the scheduled commercial release until a new approved submission references current contract authority.");
    if(currentManifest.publishingAccountId&&!currentManifest.rightsContractManagedByPublication){
      const assignment=await db.prepare(`SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`).bind(currentManifest.publishingAccountId,currentManifest.rightsContractId,at,at).first<any>();
      if(!assignment)throw new ApiError(409,"This publisher is no longer assigned to the distribution contract referenced by the scheduled release.");
    }
  }
  const ids=(value:any)=>Array.isArray(value)?value.map(String).filter(Boolean):[];
  let activatingIds=ids(currentManifest.rightsGrantIds),previousIds=ids(prior.rightsGrantIds);
  // Compatibility for publication versions created before grant ids were frozen into the manifest.
  if(!activatingIds.length&&currentManifest.rightsContractManagedByPublication&&currentManifest.rightsContractId)activatingIds=(await db.prepare("SELECT id FROM rights_grants WHERE contract_id=?").bind(currentManifest.rightsContractId).all<any>()).results.map((r:any)=>String(r.id));
  if(!previousIds.length&&prior.rightsContractManagedByPublication&&prior.rightsContractId)previousIds=(await db.prepare("SELECT id FROM rights_grants WHERE contract_id=?").bind(prior.rightsContractId).all<any>()).results.map((r:any)=>String(r.id));
  if(activatingIds.length){
    const conflicts=await detectRightsConflicts(db as any),activating=new Set(activatingIds),replaced=new Set(previousIds);
    const blocking=conflicts.find((conflict:any)=>{
      if(conflict.severity!=="error")return false;
      const a=String(conflict.grantAId),b=String(conflict.grantBId);
      if(!activating.has(a)&&!activating.has(b))return false;
      const counterpart=activating.has(a)?b:a;
      return !activating.has(counterpart)&&!replaced.has(counterpart);
    });
    if(blocking)throw new ApiError(409,`Rights conflict at activation: ${blocking.message} Conflicting grant ${activating.has(String(blocking.grantAId))?blocking.grantBId:blocking.grantAId}.`);
  }
  if(prior.offerId&&prior.offerId!==currentManifest.offerId) statements.push(db.prepare("UPDATE offers SET active=0,updated_at=? WHERE id=?").bind(at,prior.offerId));
  if(prior.royaltyContractId&&prior.royaltyContractId!==currentManifest.royaltyContractId) statements.push(db.prepare("UPDATE finance_royalty_contracts SET status='retired',updated_at=? WHERE id=?").bind(at,prior.royaltyContractId));
  if(previousIds.length){const placeholders=previousIds.map(()=>"?").join(",");statements.push(db.prepare(`UPDATE rights_grants SET status='revoked',updated_at=? WHERE id IN (${placeholders}) AND status IN ('draft','active','suspended')`).bind(at,...previousIds));}
  if(prior.rightsContractManagedByPublication&&prior.rightsContractId&&prior.rightsContractId!==currentManifest.rightsContractId)statements.push(db.prepare("UPDATE rights_contracts SET status='terminated',updated_at=? WHERE id=?").bind(at,prior.rightsContractId));
  if(currentManifest.rightsContractManagedByPublication&&currentManifest.rightsContractId)statements.push(db.prepare("UPDATE rights_contracts SET status='active',updated_at=? WHERE id=?").bind(at,currentManifest.rightsContractId));
  if(activatingIds.length){const placeholders=activatingIds.map(()=>"?").join(",");statements.push(db.prepare(`UPDATE rights_grants SET status='active',updated_at=? WHERE id IN (${placeholders}) AND status IN ('draft','suspended','revoked')`).bind(at,...activatingIds));}
  if(currentManifest.royaltyContractId) statements.push(db.prepare("UPDATE finance_royalty_contracts SET status='active',updated_at=? WHERE id=?").bind(at,currentManifest.royaltyContractId));
  if(currentManifest.offerId){
    statements.push(db.prepare("UPDATE offers SET active=1,updated_at=? WHERE id=?").bind(at,currentManifest.offerId));
    statements.push(db.prepare("INSERT INTO product_pricing_assignments(product_id,policy_id,base_offer_id,preorder_guarantee,publisher_floor_minor,updated_at) VALUES(?,'pricing_default',?,1,NULL,?) ON CONFLICT(product_id) DO UPDATE SET base_offer_id=excluded.base_offer_id,updated_at=excluded.updated_at").bind(currentManifest.productId,currentManifest.offerId,at));
  }
  if(statements.length)await db.batch(statements);
  await syncCatalogAccessibility(db,currentManifest,at);
}

export async function materializePublishingSubmission(env: PublishingEnv, submissionId: string, reviewerUserId: string) {
  const db=env.DB; const submission=await db.prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?").bind(submissionId).first<any>(); if(!submission)throw new ApiError(404,"Publishing submission not found.");
  const existing=await db.prepare("SELECT * FROM publishing_publications WHERE submission_id=?").bind(submissionId).first<any>(); if(existing)return existing;
  if(!["approved","in_review","submitted"].includes(String(submission.status)))throw new ApiError(409,"This submission cannot be published from its current state.");
  const snapshot=safeJson<any>(submission.snapshot_json,{}), currentAccount=await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(submission.account_id).first<any>(); if(!currentAccount)throw new ApiError(409,"Publishing account no longer exists.");
  if(submission.status!=="approved")throw new ApiError(409,"Only an approved immutable submission can be materialized.");
  if(currentAccount.identity_status!=="verified"||currentAccount.tax_status!=="verified"||currentAccount.payout_status!=="verified")throw new ApiError(409,"Publisher compliance status changed after submission; re-review is required.");
  const draftState=await db.prepare("SELECT id,revision,status FROM publishing_edition_drafts WHERE id=?").bind(submission.edition_id).first<any>();
  if(!draftState||Number(draftState.revision)!==Number(submission.revision)||draftState.status!=="approved")throw new ApiError(409,"The publishing draft revision no longer matches the approved submission.");
  const frozenTax=snapshot.tax||{}, frozenPayout=snapshot.payout||{};
  const activeTax=frozenTax.id?await db.prepare("SELECT id,status FROM publishing_tax_profiles WHERE id=? AND account_id=?").bind(frozenTax.id,currentAccount.id).first<any>():await db.prepare("SELECT id,status FROM publishing_tax_profiles WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1").bind(currentAccount.id).first<any>();
  const activePayout=frozenPayout.id?await db.prepare("SELECT id,status FROM publishing_payout_accounts WHERE id=? AND account_id=?").bind(frozenPayout.id,currentAccount.id).first<any>():await db.prepare("SELECT id,status FROM publishing_payout_accounts WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1").bind(currentAccount.id).first<any>();
  if(activeTax?.status!=="verified"||activePayout?.status!=="verified")throw new ApiError(409,"The tax or payout profile attached to this submission is no longer verified; submit a new revision.");
  const frozenAccount=snapshot.account||{}, account={...frozenAccount,id:currentAccount.id,publisher_id:currentAccount.publisher_id,finance_party_id:currentAccount.finance_party_id,rights_party_id:currentAccount.rights_party_id};
  const tax=frozenTax, payout=frozenPayout, frozenTitle=snapshot.title||{}, frozenEdition=snapshot.edition||{};
  if(!frozenTitle.id||!frozenEdition.id||!Array.isArray(snapshot.contributors)||!Array.isArray(snapshot.assets))throw new ApiError(409,"The immutable submission snapshot is incomplete.");
  const edition={...frozenTitle,...frozenEdition,publishing_edition_id:frozenEdition.id,publishing_title_id:frozenTitle.id,title:frozenTitle.title,subtitle:frozenTitle.subtitle||"",description:frozenTitle.description||"",title_language:frozenTitle.language||frozenEdition.language,categories_json:frozenTitle.categories_json||"[]",keywords_json:frozenTitle.keywords_json||"[]",publisher_name:frozenTitle.publisher_name||"",imprint_name:frozenTitle.imprint_name||"",series_name:frozenTitle.series_name||"",series_relationship:frozenTitle.series_relationship||"main",series_position:frozenTitle.series_position??null};
  const frozenContributors=snapshot.contributors, frozenAssets=snapshot.assets;
  const lifecycle=await ensurePublishingLifecycle(db,String(frozenEdition.id));
  if(["suppressed","takedown","retired"].includes(String(lifecycle.state)))throw new ApiError(409,"This release is under staff enforcement and cannot be materialized until Cove restores it.");
  const priorVersion=await db.prepare("SELECT * FROM publishing_publication_versions WHERE lifecycle_id=? ORDER BY version_number DESC LIMIT 1").bind(lifecycle.id).first<any>();
  const servingVersion=await publicationVersionManifest(db,lifecycle.current_publication_version_id);
  const at=now(),releaseAt=edition.release_date?new Date(edition.release_date).getTime():Date.now(),futureRelease=Number.isFinite(releaseAt)&&releaseAt>Date.now(),preorderAt=edition.preorder_date?new Date(edition.preorder_date).getTime():NaN;
  const desiredState=priorVersion?(futureRelease?"scheduled":"updated"):(futureRelease?(Number.isFinite(preorderAt)&&preorderAt<=Date.now()?"preorder":"scheduled"):"live"),stageOnly=!!priorVersion&&futureRelease,commercialActive=!stageOnly&&["preorder","live","updated"].includes(desiredState);
  const {publisherId,financePartyId,rightsPartyId}=await ensureCatalogParties(db,account,tax,payout);
  let imprintId:string|null=null; if(String(edition.imprint_name||"").trim()){const old=await db.prepare("SELECT id FROM imprints WHERE publisher_id=? AND lower(name)=lower(?)").bind(publisherId,edition.imprint_name).first<any>(); imprintId=old?.id||id("imprint"); if(!old)await db.prepare("INSERT INTO imprints(id,publisher_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").bind(imprintId,publisherId,edition.imprint_name,at,at).run();}
  let workId=edition.catalog_work_id||id("work"), catalogEditionId=edition.catalog_edition_id||id("edition"), productId=edition.catalog_product_id||id("product");
  if(!stageOnly){
    if(!edition.catalog_work_id)await db.prepare(`INSERT INTO works(id,title,subtitle,description,original_language,min_age,max_age,work_type,canonical_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, ?,?)`).bind(workId,edition.title,edition.subtitle||"",edition.description||"",edition.title_language||edition.language,null,null,edition.rights_basis==="public_domain"?"public_domain":"original","canonical",at,at).run();
    else await db.prepare("UPDATE works SET title=?,subtitle=?,description=?,original_language=COALESCE(?,original_language),work_type=CASE WHEN ?='public_domain' THEN 'public_domain' ELSE work_type END,updated_at=? WHERE id=?").bind(edition.title,edition.subtitle||"",edition.description||"",edition.title_language||edition.language,edition.rights_basis,at,workId).run();
    await db.prepare(`INSERT INTO editions(id,work_id,publisher_id,imprint_id,title,subtitle,description,edition_number,language,publication_date,release_date,preorder_date,isbn13,publisher_identifier,layout,drm_status,downloadable,release_status,subscription_eligible,library_eligible,publisher_description,edition_type,differentiation_status,differentiation_summary,canonical_public_domain,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET publisher_id=excluded.publisher_id,imprint_id=excluded.imprint_id,title=excluded.title,subtitle=excluded.subtitle,description=excluded.description,edition_number=excluded.edition_number,language=excluded.language,release_date=excluded.release_date,preorder_date=excluded.preorder_date,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,drm_status=excluded.drm_status,downloadable=excluded.downloadable,release_status=excluded.release_status,subscription_eligible=excluded.subscription_eligible,library_eligible=excluded.library_eligible,publisher_description=excluded.publisher_description,edition_type=excluded.edition_type,differentiation_status=excluded.differentiation_status,differentiation_summary=excluded.differentiation_summary,canonical_public_domain=excluded.canonical_public_domain,updated_at=excluded.updated_at`)
      .bind(catalogEditionId,workId,publisherId,imprintId,edition.title,edition.subtitle||"",edition.description||"",edition.edition_label||"",edition.language,edition.release_date,edition.release_date,edition.preorder_date,edition.isbn13||null,edition.publisher_identifier||"","reflowable",edition.drm_requirement||"none",Number(edition.downloadable),desiredState==="scheduled"?"scheduled":desiredState==="preorder"?"preorder":"available",Number(edition.subscription_permitted),Number(edition.library_permitted),edition.description||"",edition.edition_type||"original",edition.rights_basis==="public_domain"?"pending":"not_required",edition.differentiation_summary||"",0,at,at).run();
    await db.prepare("DELETE FROM edition_languages WHERE edition_id=? AND kind='content'").bind(catalogEditionId).run();
    await db.prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')").bind(catalogEditionId,String(edition.language).toLowerCase()).run();
    await db.prepare("DELETE FROM edition_contributors WHERE edition_id=?").bind(catalogEditionId).run();
    await db.prepare("DELETE FROM series_memberships WHERE edition_id=?").bind(catalogEditionId).run();
    await db.prepare("DELETE FROM edition_categories WHERE edition_id=?").bind(catalogEditionId).run();
    await db.prepare("DELETE FROM edition_keywords WHERE edition_id=?").bind(catalogEditionId).run();
  }
  const contributors=frozenContributors, contributorLinks:any[]=[];
  for(const c of contributors){
    let contributorId:string|null=null, pen:any=null;
    if(c.pen_name_id){
      pen=await db.prepare("SELECT id,contributor_id FROM publishing_pen_names WHERE id=? AND account_id=?").bind(c.pen_name_id,account.id).first<any>();
      if(pen?.contributor_id){const linked=await db.prepare("SELECT id,name FROM contributors WHERE id=?").bind(pen.contributor_id).first<any>();if(linked&&String(linked.name).toLowerCase()===String(c.display_name).toLowerCase())contributorId=linked.id;}
    }
    if(!contributorId){const old=await db.prepare("SELECT id FROM contributors WHERE lower(name)=lower(?) ORDER BY created_at LIMIT 1").bind(c.display_name).first<any>();contributorId=old?.id||id("contrib");if(!old)await db.prepare("INSERT INTO contributors(id,name,sort_name,bio,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(contributorId,c.display_name,c.display_name,"",at,at).run();if(pen&&!pen.contributor_id)await db.prepare("UPDATE publishing_pen_names SET contributor_id=?,updated_at=? WHERE id=?").bind(contributorId,at,pen.id).run();}
    contributorLinks.push({contributorId,role:c.role,position:Number(c.position||0)});
    if(!stageOnly)await db.prepare("INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,?,?)").bind(catalogEditionId,contributorId,c.role,Number(c.position||0)).run();
  }
  let seriesLink:any=null;
  if(edition.series_name){let seriesRow=await db.prepare("SELECT id FROM series WHERE publisher_id=? AND lower(name)=lower(?)").bind(publisherId,edition.series_name).first<any>();const seriesId=seriesRow?.id||id("series");if(!seriesRow)await db.prepare("INSERT INTO series(id,name,description,publisher_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(seriesId,edition.series_name,"",publisherId,at,at).run();seriesLink={seriesId,position:edition.series_position||null,label:"",relationship:edition.series_relationship||"main",readingOrder:edition.series_position||null,displayOrder:Number(edition.series_position||0)*100};if(!stageOnly)await db.prepare(`INSERT INTO series_memberships(series_id,edition_id,position,label,relationship,reading_order,display_order) VALUES(?,?,?,?,?,?,?)`).bind(seriesId,catalogEditionId,seriesLink.position,"",seriesLink.relationship,seriesLink.readingOrder,seriesLink.displayOrder).run();}
  const categoryLinks:any[]=[];
  for(const [i,name] of safeJson<string[]>(edition.categories_json,[]).entries()){let cat=await db.prepare("SELECT id FROM categories WHERE scheme='publisher' AND lower(name)=lower(?)").bind(name).first<any>();const catId=cat?.id||id("cat");if(!cat)await db.prepare("INSERT INTO categories(id,scheme,code,name,parent_id) VALUES(?,'publisher','',?,NULL)").bind(catId,name).run();categoryLinks.push({categoryId:catId,position:i});if(!stageOnly)await db.prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES(?,?,?)").bind(catalogEditionId,catId,i).run();}
  const keywordLinks:any[]=[];
  for(const kw of safeJson<string[]>(edition.keywords_json,[])){let row=await db.prepare("SELECT id FROM keywords WHERE value=? COLLATE NOCASE").bind(kw).first<any>();const kid=row?.id||id("kw");if(!row)await db.prepare("INSERT INTO keywords(id,value) VALUES(?,?)").bind(kid,kw).run();keywordLinks.push({keywordId:kid});if(!stageOnly)await db.prepare("INSERT INTO edition_keywords(edition_id,keyword_id) VALUES(?,?)").bind(catalogEditionId,kid).run();}
  const storefrontStatus=desiredState==="scheduled"&&!priorVersion?"inactive":"active";
  await db.prepare(`INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,?,?,'fore_publishing',?,?,?) ON CONFLICT(id) DO UPDATE SET storefront_status=excluded.storefront_status,updated_at=excluded.updated_at`).bind(productId,catalogEditionId,`FORE-${productId.slice(-18)}`,edition.format,storefrontStatus,edition.publishing_edition_id,at,at).run();
  const assets=frozenAssets; let manuscriptVersion:any=null,coverVersion:any=null; const catalogAssets:any[]=[];
  for(const pa of assets){
    if(!pa.current_version_id)continue;
    const sourceVersion=await db.prepare("SELECT id,object_key,mime_type,size_bytes,sha256 FROM publishing_asset_versions WHERE id=? AND asset_id=?").bind(pa.current_version_id,pa.id).first<any>();
    if(!sourceVersion||sourceVersion.object_key!==pa.object_key||sourceVersion.sha256!==pa.sha256||Number(sourceVersion.size_bytes)!==Number(pa.size_bytes))throw new ApiError(409,"A submitted asset no longer matches its immutable snapshot.");
    const liveKey=`publishing/live/${catalogEditionId}/${pa.kind}/${pa.sha256}.${pa.kind==='cover'?(String(pa.mime_type)==='image/png'?'png':'jpg'):(pa.kind==='manuscript'?'epub':'bin')}`;
    if(env.BUCKET){const bytes=await bucketBytes(env,String(pa.object_key));await env.BUCKET.put(liveKey,bytes,{httpMetadata:{contentType:pa.mime_type},customMetadata:{sha256:pa.sha256,source:"fore-publishing-live"}});}
    const catalogKind=pa.kind==='manuscript'?'epub':pa.kind,daId=`asset_${pa.kind}_${catalogEditionId}`,avId=`assetver_${pa.kind}_${catalogEditionId}_${pa.sha256.slice(0,12)}`;
    const priorAsset=await db.prepare("SELECT id,current_version_id FROM digital_assets WHERE edition_id=? AND kind=?").bind(catalogEditionId,catalogKind).first<any>();
    if(!priorAsset) await db.prepare("INSERT INTO digital_assets(id,edition_id,kind,current_version_id,drm_status,downloadable,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(daId,catalogEditionId,catalogKind,stageOnly?null:avId,edition.drm_requirement||"none",Number(edition.downloadable),at,at).run();
    else if(!stageOnly) await db.prepare("UPDATE digital_assets SET current_version_id=?,drm_status=?,downloadable=?,updated_at=? WHERE id=?").bind(avId,edition.drm_requirement||"none",Number(edition.downloadable),at,priorAsset.id).run();
    const existingAssetVersion=await db.prepare("SELECT id,version_number FROM asset_versions WHERE id=?").bind(avId).first<any>();
    if(!existingAssetVersion){const maxVersion=Number((await db.prepare("SELECT COALESCE(MAX(version_number),0) n FROM asset_versions WHERE asset_id=?").bind(priorAsset?.id||daId).first<any>())?.n||0);const publicUrl=pa.kind==='cover'?`/api/fore/catalog-assets/${encodeURIComponent(avId)}`:null;await db.prepare("INSERT INTO asset_versions(id,asset_id,version_number,object_key,source_url,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(avId,priorAsset?.id||daId,maxVersion+1,liveKey,publicUrl,pa.mime_type,pa.size_bytes,pa.sha256,at).run();}
    catalogAssets.push({kind:catalogKind,digitalAssetId:priorAsset?.id||daId,catalogAssetVersionId:avId,publishingAssetVersionId:pa.current_version_id,sha256:pa.sha256,mimeType:pa.mime_type,sizeBytes:pa.size_bytes});
    if(pa.kind==='manuscript')manuscriptVersion=pa;if(pa.kind==='cover')coverVersion=pa;
    await db.prepare("UPDATE publishing_asset_versions SET quarantine_status='promoted' WHERE id=?").bind(pa.current_version_id).run();
  }
  let accessibilityProfile:any=null,formatProfile:any=null,manuscriptCatalogAssetVersionId:string|null=null;
  if(manuscriptVersion?.current_version_id){
    const inspection=await db.prepare("SELECT inspection_version,accessibility_json,format_profile_json,issue_summary_json,created_at FROM publishing_epub_inspections WHERE asset_version_id=?").bind(manuscriptVersion.current_version_id).first<any>();
    if(inspection){
      accessibilityProfile=safeJson<any>(inspection.accessibility_json,{});formatProfile=safeJson<any>(inspection.format_profile_json,{});
      const mapped=catalogAssets.find((a:any)=>a.kind==="epub"&&a.publishingAssetVersionId===manuscriptVersion.current_version_id);manuscriptCatalogAssetVersionId=mapped?.catalogAssetVersionId||null;
      const frozenDeclaration=safeJson<any>(snapshot.accessibilityDeclaration?.declaration_json,{});
      if(String(frozenDeclaration.sourceAssetVersionId||"")!==String(manuscriptVersion.current_version_id))throw new ApiError(409,"The approved accessibility declaration does not match the submitted manuscript asset.");
      const publisher=frozenDeclaration.publisher||{};
      accessibilityProfile.publisherDeclaration={summary:String(publisher.summary||""),knownLimitations:String(publisher.knownLimitations||""),claimsConformance:!!publisher.claimsConformance,certifier:String(publisher.certifier||""),credential:String(publisher.credential||""),policyVersion:String(snapshot.accessibilityDeclaration?.policy_version||"fore-epub-accessibility-v1"),declaredAt:String(snapshot.accessibilityDeclaration?.created_at||"")};
      accessibilityProfile.validationReport={sourcePublishingAssetVersionId:manuscriptVersion.current_version_id,inspectionVersion:String(inspection.inspection_version||""),inspectedAt:String(inspection.created_at||""),issues:safeJson<any[]>(inspection.issue_summary_json,[])};
    }
  }
  let rightsContract:any,rightsContractManagedByPublication=false;
  if(edition.contract_id){
    const assigned=await db.prepare(`SELECT rc.*,rcv.id active_version_id FROM publisher_contract_assignments a JOIN rights_contracts rc ON rc.id=a.contract_id LEFT JOIN rights_contract_versions rcv ON rcv.id=? AND rcv.contract_id=rc.id AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) WHERE a.account_id=? AND a.contract_id=? AND a.status='active' AND rc.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?)`).bind(edition.contract_version_id||null,at,at,account.id,edition.contract_id,at,at).first<any>();
    if(!assigned)throw new ApiError(409,"The approved submission's distribution contract is no longer assigned to this publisher.");
    if(edition.contract_version_id&&!assigned.active_version_id)throw new ApiError(409,"The approved submission's contract version is no longer active/effective; resubmit against the current approved contract version.");
    rightsContract={id:String(assigned.id)};
  } else {
    rightsContract=await upsertRightsContract(db as any,{referenceCode:`FORE-PUBLISH-${submissionId}`,name:`Cove Publishing rights — ${edition.title}`,rightsholderPartyId:rightsPartyId,status:"draft",effectiveFrom:edition.rights_start_at||edition.release_date||at,effectiveTo:edition.rights_end_at||null,languageMatchMode:"all",source:"fore-publishing",languages:[{languageCode:String(edition.language).toLowerCase(),decision:"allow",format:edition.format}]});
    rightsContractManagedByPublication=true;
  }
  const scope=safeJson<any>(edition.territory_scope_json,{mode:"worldwide",exclude:[]}),channels=safeJson<string[]>(edition.sales_channels_json,["retail"]),rightsGrantIds:string[]=[];
  for(const channel of channels){const grant=await upsertRightsGrant(db as any,{editionId:catalogEditionId,rightsholderPartyId:rightsPartyId,format:edition.format,salesChannel:channel,startsAt:edition.rights_start_at||edition.release_date||null,endsAt:edition.rights_end_at||null,licenseType:edition.rights_basis==='licensed'?"publisher-license":edition.rights_basis==='public_domain'?"public-domain":"copyright-owner",contractId:rightsContract.id,contractVersionId:edition.contract_version_id||null,drmRequirement:edition.drm_requirement||"none",subscriptionPermitted:!!edition.subscription_permitted,libraryPermitted:!!edition.library_permitted,decision:"allow",status:"draft",source:"fore-publishing",notes:`Materialized from ${submissionId}`,...scopeToGrant(scope)});rightsGrantIds.push(grant.id);}
  if(!stageOnly&&edition.rights_basis==="public_domain"){
    const manuscript=catalogAssets.find((a:any)=>a.kind==="epub"),translator=contributorLinks.find((c:any)=>c.role==="translator");
    await db.prepare(`INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,translator_contributor_id,source_text_fingerprint,asset_sha256,verification_status,verified_by_user_id,verified_at,policy_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'verified',?,?,'fore-public-domain-editions-v1',?,?) ON CONFLICT(edition_id) DO UPDATE SET edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,translator_contributor_id=excluded.translator_contributor_id,asset_sha256=excluded.asset_sha256,verification_status='verified',verified_by_user_id=excluded.verified_by_user_id,verified_at=excluded.verified_at,updated_at=excluded.updated_at`).bind(catalogEditionId,edition.edition_type||"original",edition.differentiation_summary||"",translator?.contributorId||null,"",manuscript?.sha256||"",reviewerUserId,at,at,at).run();
    await db.batch([db.prepare("UPDATE editions SET differentiation_status='verified',updated_at=? WHERE id=?").bind(at,catalogEditionId),db.prepare("INSERT INTO edition_duplicate_policy_decisions(id,edition_id,policy_version,decision,reason_code,evidence_json,decided_by,created_at) VALUES(?,?,'fore-public-domain-editions-v1','allow','DIFFERENTIATED_PUBLIC_DOMAIN_EDITION',?,'system',?)").bind(id("pddecision"),catalogEditionId,JSON.stringify({editionType:edition.edition_type||"original",assetSha256:manuscript?.sha256||"",differentiationSummary:edition.differentiation_summary||""}),at)]);
  }
  const offerId=id("offer");await db.prepare("INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'purchase',?,?,0,?,?,?,?)").bind(offerId,productId,edition.list_currency,edition.list_price_minor,edition.preorder_date||edition.release_date||at,edition.rights_end_at||null,at,at).run();
  let foreCommissionBps=3000,paymentTermsDays=60,royaltyTermsSource="Cove Publishing default terms";
  if(edition.contract_version_id){const commercialTerms=await db.prepare("SELECT retailer_commission_bps,payment_schedule_json FROM rights_contract_versions WHERE id=? AND contract_id=?").bind(edition.contract_version_id,rightsContract.id).first<any>();if(!commercialTerms)throw new ApiError(409,"The approved distribution contract version is unavailable for finance materialization.");const schedule=safeJson<any>(commercialTerms.payment_schedule_json,{});foreCommissionBps=Number(commercialTerms.retailer_commission_bps);paymentTermsDays=Math.max(0,Math.min(180,Number(schedule.netDays??30)));royaltyTermsSource=`Distribution contract version ${edition.contract_version_id}`;}
  const royaltyContractId=id("royalty");await db.prepare(`INSERT INTO finance_royalty_contracts(id,name,publisher_id,product_id,edition_id,format,sales_channel,effective_from,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'retail',?,'draft',?,?)`).bind(royaltyContractId,`Cove Publishing — ${edition.title}`,publisherId,productId,catalogEditionId,edition.format,edition.rights_start_at||edition.release_date||at,at,at).run();
  await createRoyaltyContractVersion(db as any,{contractId:royaltyContractId,effectiveFrom:edition.rights_start_at||edition.release_date||at,effectiveTo:edition.rights_end_at||null,basis:"net_revenue",foreCommissionBps,paymentTermsDays,reserveBps:0,notes:`${royaltyTermsSource}; immutable finance terms materialized with publication.`,changeReason:"Initial commercial terms created with approved publication.",createdByUserId:reviewerUserId,splits:[{partyId:financePartyId,shareBps:10000}],rules:[{key:"default_retail",priority:100,conditions:{salesChannels:["retail"]},action:{basis:"net_receipts",foreCommissionBps,processorFeeTreatment:"deduct",taxTreatment:"deduct",foreFundedDiscountTreatment:"add_back",publisherFundedDiscountTreatment:"deduct",paymentTermsDays}}]});
  const publicationId=id("publication"),materializationKey=`submission:${submissionId}:v2`;
  await db.batch([db.prepare(`INSERT INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,rights_contract_id,royalty_contract_id,offer_id,manuscript_asset_version_id,cover_asset_version_id,materialization_key,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(publicationId,submissionId,account.id,workId,catalogEditionId,productId,rightsContract.id,royaltyContractId,offerId,manuscriptVersion?.current_version_id||null,coverVersion?.current_version_id||null,materializationKey,at),db.prepare("UPDATE publishing_submission_snapshots SET status='published',published_at=?,decided_at=COALESCE(decided_at,?) WHERE id=?").bind(at,at,submissionId),db.prepare("UPDATE publishing_edition_drafts SET status='published',catalog_edition_id=?,catalog_product_id=?,updated_at=? WHERE id=?").bind(catalogEditionId,productId,at,edition.publishing_edition_id),db.prepare("UPDATE publishing_titles SET status='published',catalog_work_id=?,updated_at=? WHERE id=?").bind(workId,at,edition.publishing_title_id),db.prepare("INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,available_at,created_at) VALUES(?,'publishing.published','publication',?,?,?,?)").bind(id("pubout"),publicationId,JSON.stringify({publicationId,submissionId,workId,editionId:catalogEditionId,productId,releaseState:desiredState}),at,at)]);
  await db.prepare("UPDATE publisher_catalog_mappings SET catalog_work_id=?,catalog_edition_id=?,catalog_product_id=?,status='active',updated_at=? WHERE account_id=? AND publishing_edition_id=?").bind(workId,catalogEditionId,productId,at,account.id,edition.publishing_edition_id).run();
  const latestLifecycle=await ensurePublishingLifecycle(db,edition.publishing_edition_id),versionNumber=Number((await db.prepare("SELECT COALESCE(MAX(version_number),0) n FROM publishing_publication_versions WHERE lifecycle_id=?").bind(latestLifecycle.id).first<any>())?.n||0)+1,publicationVersionId=id("pubver");
  const manifest={schemaVersion:4,submissionId,snapshotSha256:submission.snapshot_sha256,publishingAccountId:account.id,workId,catalogEditionId,productId,publisherId,imprintId,offerId,rightsContractId:rightsContract.id,rightsContractVersionId:edition.contract_version_id||null,rightsContractManagedByPublication,rightsGrantIds,royaltyContractId,catalogAssets,contributorLinks,seriesLink,categoryLinks,keywordLinks,accessibilityProfile,formatProfile,manuscriptCatalogAssetVersionId,metadata:{title:edition.title,subtitle:edition.subtitle||"",description:edition.description||"",editionLabel:edition.edition_label||"",language:edition.language,isbn13:edition.isbn13||null,publisherIdentifier:edition.publisher_identifier||"",releaseDate:edition.release_date||null,preorderDate:edition.preorder_date||null,drmRequirement:edition.drm_requirement||"none",downloadable:Number(edition.downloadable),subscriptionPermitted:Number(edition.subscription_permitted),libraryPermitted:Number(edition.library_permitted),listCurrency:edition.list_currency,listPriceMinor:Number(edition.list_price_minor||0)},sourceSnapshot:snapshot};
  const publishedAi=snapshot.aiDisclosure;
  if(!publishedAi?.id||!publishedAi?.policy_version)throw new ApiError(409,"The approved submission is missing its immutable AI-content disclosure evidence.");
  const publicAiBadges:any[]=[];
  if(["ai_generated","mixed"].includes(String(publishedAi.text_origin)))publicAiBadges.push({key:"ai_generated_text",label:"Contains AI-generated text"});
  if(["ai_generated","mixed"].includes(String(publishedAi.cover_origin)))publicAiBadges.push({key:"ai_generated_cover",label:"AI-generated cover art"});
  if(["ai_generated","mixed"].includes(String(publishedAi.narration_origin)))publicAiBadges.push({key:"synthetic_narration",label:String(publishedAi.synthetic_voice_label||"Synthetic narration")});
  if(["ai_generated","mixed"].includes(String(publishedAi.translation_origin)))publicAiBadges.push({key:"ai_generated_translation",label:"Contains AI-generated translation"});
  await db.batch([
    db.prepare("INSERT INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,previous_version_id,snapshot_sha256,manifest_json,owner_delivery_policy,release_state,activated_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(publicationVersionId,latestLifecycle.id,publicationId,submissionId,versionNumber,priorVersion?.id||null,submission.snapshot_sha256,stableJson(manifest),latestLifecycle.owner_update_policy||"auto_update",desiredState,commercialActive?at:null,reviewerUserId,at),
    db.prepare("INSERT INTO publishing_publication_disclosures(publication_version_id,ai_disclosure_id,policy_version,text_origin,cover_origin,narration_origin,translation_origin,synthetic_voice_label,public_badges_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(publicationVersionId,publishedAi.id,publishedAi.policy_version,publishedAi.text_origin,publishedAi.cover_origin,publishedAi.narration_origin,publishedAi.translation_origin,publishedAi.synthetic_voice_label||"",JSON.stringify(publicAiBadges),at),
  ]);
  if(commercialActive){
    await activatePublicationCommercialTerms(db,manifest,servingVersion?.manifest||null,at);
    await recordPublicationActivation(db,{lifecycleId:latestLifecycle.id,publicationVersionId,fromPublicationVersionId:servingVersion?.id||null,activationType:versionNumber>1?"update":"initial",actorUserId:reviewerUserId,reasonCode:desiredState==="preorder"?"preorder_materialized":"approved_and_materialized",metadata:{publicationId,versionNumber,releaseState:desiredState},at});
  }
  if(stageOnly) await db.prepare("UPDATE publishing_release_lifecycles SET state='scheduled',pending_publication_version_id=?,scheduled_at=COALESCE(scheduled_at,?),state_reason='approved_update_waiting_release',updated_at=? WHERE id=?").bind(publicationVersionId,at,at,latestLifecycle.id).run();
  else await db.prepare("UPDATE publishing_release_lifecycles SET state=?,current_publication_version_id=?,pending_publication_version_id=NULL,state_reason='approved_and_materialized',live_at=CASE WHEN ? IN ('live','updated') THEN COALESCE(live_at,?) ELSE live_at END,preorder_at=CASE WHEN ?='preorder' THEN COALESCE(preorder_at,?) ELSE preorder_at END,scheduled_at=CASE WHEN ?='scheduled' THEN COALESCE(scheduled_at,?) ELSE scheduled_at END,updated_at=? WHERE id=?").bind(desiredState,publicationVersionId,desiredState,at,desiredState,at,desiredState,at,at,latestLifecycle.id).run();
  await db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'staff',?,?,?,?)").bind(id("lifeevt"),latestLifecycle.id,latestLifecycle.state,desiredState,reviewerUserId,"approved_and_materialized",JSON.stringify({publicationId,publicationVersionId,versionNumber,stageOnly}),at).run();
  await audit(db,account.id,reviewerUserId,"publishing_submission",submissionId,"published",{publicationId,publicationVersionId,versionNumber,workId,editionId:catalogEditionId,productId,releaseState:desiredState,ownerUpdatePolicy:latestLifecycle.owner_update_policy||"auto_update"});
  if(["preorder","scheduled"].includes(desiredState)&&edition.release_date)try{await ensurePreorderReleasePlan(db as any,productId,reviewerUserId);}catch(e){console.error("Unable to materialize preorder operations plan",e);}
  return {...(await db.prepare("SELECT * FROM publishing_publications WHERE id=?").bind(publicationId).first<any>()),publicationVersionId,versionNumber,releaseState:desiredState,ownerUpdatePolicy:latestLifecycle.owner_update_policy||"auto_update"};
}

async function activatePublicationVersion(db: PublishingDB, publicationVersionId: string, actorUserId: string | null, triggerType: "schedule"|"rollback"|"staff") {
  const v=await db.prepare(`SELECT pv.*,l.publishing_edition_id,l.state,l.current_publication_version_id,l.owner_update_policy FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id WHERE pv.id=?`).bind(publicationVersionId).first<any>();
  if(!v)throw new ApiError(404,"Publication version not found.");
  if(["suppressed","takedown","retired"].includes(String(v.state)))throw new ApiError(409,"An enforced or retired release cannot activate another publication version until staff restores it.");
  const m=safeJson<any>(v.manifest_json,{}),meta=m.metadata||{},at=now(),previousServing=await publicationVersionManifest(db,v.current_publication_version_id);if(!m.workId||!m.catalogEditionId||!m.productId)throw new ApiError(409,"Publication version manifest is incomplete.");
  await db.prepare("UPDATE works SET title=?,subtitle=?,description=?,original_language=COALESCE(?,original_language),updated_at=? WHERE id=?").bind(meta.title||"",meta.subtitle||"",meta.description||"",meta.language||null,at,m.workId).run();
  await db.prepare("UPDATE editions SET publisher_id=COALESCE(?,publisher_id),imprint_id=?,title=?,subtitle=?,description=?,edition_number=?,language=?,release_date=?,preorder_date=?,isbn13=?,publisher_identifier=?,drm_status=?,downloadable=?,subscription_eligible=?,library_eligible=?,release_status='available',publisher_description=?,updated_at=? WHERE id=?").bind(m.publisherId||null,m.imprintId||null,meta.title||"",meta.subtitle||"",meta.description||"",meta.editionLabel||"",meta.language||"en",meta.releaseDate||null,meta.preorderDate||null,meta.isbn13||null,meta.publisherIdentifier||"",meta.drmRequirement||"none",Number(meta.downloadable??1),Number(meta.subscriptionPermitted||0),Number(meta.libraryPermitted||0),meta.description||"",at,m.catalogEditionId).run();
  await db.prepare("DELETE FROM edition_languages WHERE edition_id=? AND kind='content'").bind(m.catalogEditionId).run();
  await db.prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')").bind(m.catalogEditionId,String(meta.language||"en").toLowerCase()).run();
  await db.prepare("DELETE FROM edition_contributors WHERE edition_id=?").bind(m.catalogEditionId).run();
  for(const c of (m.contributorLinks||[]))await db.prepare("INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,?,?)").bind(m.catalogEditionId,c.contributorId,c.role,Number(c.position||0)).run();
  await db.prepare("DELETE FROM series_memberships WHERE edition_id=?").bind(m.catalogEditionId).run();
  if(m.seriesLink)await db.prepare("INSERT INTO series_memberships(series_id,edition_id,position,label,relationship,reading_order,display_order) VALUES(?,?,?,?,?,?,?)").bind(m.seriesLink.seriesId,m.catalogEditionId,m.seriesLink.position??null,m.seriesLink.label||"",m.seriesLink.relationship||"main",m.seriesLink.readingOrder??null,Number(m.seriesLink.displayOrder||0)).run();
  await db.prepare("DELETE FROM edition_categories WHERE edition_id=?").bind(m.catalogEditionId).run();
  for(const c of (m.categoryLinks||[]))await db.prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES(?,?,?)").bind(m.catalogEditionId,c.categoryId,Number(c.position||0)).run();
  await db.prepare("DELETE FROM edition_keywords WHERE edition_id=?").bind(m.catalogEditionId).run();
  for(const k of (m.keywordLinks||[]))await db.prepare("INSERT INTO edition_keywords(edition_id,keyword_id) VALUES(?,?)").bind(m.catalogEditionId,k.keywordId).run();
  for(const a of (m.catalogAssets||[])) await db.prepare("UPDATE digital_assets SET current_version_id=?,drm_status=?,downloadable=?,updated_at=? WHERE id=?").bind(a.catalogAssetVersionId,meta.drmRequirement||"none",Number(meta.downloadable??1),at,a.digitalAssetId).run();
  await activatePublicationCommercialTerms(db,m,previousServing?.manifest||null,at);
  await db.prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?").bind(at,m.productId).run();
  const nextState=triggerType==="rollback"?"updated":Number(v.version_number)>1?"updated":"live";
  await db.prepare("UPDATE publishing_release_lifecycles SET state=?,current_publication_version_id=?,pending_publication_version_id=NULL,state_reason=?,live_at=COALESCE(live_at,?),updated_at=? WHERE id=?").bind(nextState,publicationVersionId,triggerType==="rollback"?"rollback_activated":"scheduled_version_activated",at,at,v.lifecycle_id).run();
  await db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id("lifeevt"),v.lifecycle_id,v.state,nextState,triggerType,actorUserId,triggerType==="rollback"?"rollback":"activation",JSON.stringify({publicationVersionId,versionNumber:v.version_number,previousCurrentVersionId:v.current_publication_version_id}),at).run();
  await recordPublicationActivation(db,{lifecycleId:v.lifecycle_id,publicationVersionId,fromPublicationVersionId:v.current_publication_version_id||null,activationType:triggerType==="rollback"?"rollback":triggerType==="schedule"?"schedule":"staff",actorUserId,reasonCode:triggerType==="rollback"?"rollback_activated":"publication_version_activated",metadata:{versionNumber:Number(v.version_number),fromState:v.state,toState:nextState},at});
  return{publicationVersionId,state:nextState,versionNumber:Number(v.version_number)};
}

export async function advancePublishingReleaseSchedules(db: PublishingDB) {
  const atMs=Date.now(),rows=(await db.prepare(`SELECT l.*,pv.id version_id,pv.manifest_json,pv.version_number FROM publishing_release_lifecycles l LEFT JOIN publishing_publication_versions pv ON pv.id=COALESCE(l.pending_publication_version_id,l.current_publication_version_id) WHERE l.state IN ('scheduled','preorder') ORDER BY l.updated_at LIMIT 500`).all<any>()).results;const advanced:any[]=[];
  for(const row of rows){if(!row.version_id)continue;const m=safeJson<any>(row.manifest_json,{}),meta=m.metadata||{},releaseMs=meta.releaseDate?new Date(meta.releaseDate).getTime():NaN,preorderMs=meta.preorderDate?new Date(meta.preorderDate).getTime():NaN;
    if(Number.isFinite(releaseMs)&&releaseMs<=atMs){advanced.push(await activatePublicationVersion(db,row.version_id,null,"schedule"));continue;}
    if(row.state==="scheduled"&&!row.pending_publication_version_id&&Number.isFinite(preorderMs)&&preorderMs<=atMs){
      const at=now();
      await activatePublicationCommercialTerms(db,m,null,at);
      await db.prepare("UPDATE publishing_release_lifecycles SET state='preorder',preorder_at=COALESCE(preorder_at,?),state_reason='preorder_window_open',updated_at=? WHERE id=?").bind(at,at,row.id).run();
      if(m.productId)await db.prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?").bind(at,m.productId).run();
      if(m.catalogEditionId)await db.prepare("UPDATE editions SET release_status='preorder',updated_at=? WHERE id=?").bind(at,m.catalogEditionId).run();
      if(m.productId)try{await ensurePreorderReleasePlan(db as any,String(m.productId),null);}catch(e){console.error("Unable to activate preorder operations plan",e);}
      await db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,reason_code,metadata_json,created_at) VALUES(?,?,?,'preorder','schedule','preorder_opened',?,?)").bind(id("lifeevt"),row.id,row.state,JSON.stringify({publicationVersionId:row.version_id}),at).run();
      await recordPublicationActivation(db,{lifecycleId:row.id,publicationVersionId:row.version_id,fromPublicationVersionId:null,activationType:"schedule",reasonCode:"preorder_opened",metadata:{versionNumber:Number(row.version_number),visibility:"preorder"},at});
      advanced.push({publicationVersionId:row.version_id,state:"preorder",versionNumber:Number(row.version_number)});
    }
  }return{checked:rows.length,advanced};
}

export async function rollbackPublishingVersion(db: PublishingDB, reviewerUserId: string, raw: unknown) {
  const x=z.object({editionId:z.string().min(1),versionNumber:z.number().int().min(1),reasonCode:z.string().trim().min(3).max(120),notes:z.string().max(4000).default("")}).parse(raw),lifecycle=await ensurePublishingLifecycle(db,x.editionId),target=await db.prepare("SELECT * FROM publishing_publication_versions WHERE lifecycle_id=? AND version_number=?").bind(lifecycle.id,x.versionNumber).first<any>();if(!target)throw new ApiError(404,"Publication version not found.");
  if(["suppressed","takedown","retired"].includes(String(lifecycle.state)))throw new ApiError(409,"Rollback is blocked while the release is suppressed, taken down, or retired. Restore the release through moderation first.");
  if(target.id===lifecycle.current_publication_version_id)return{publicationVersionId:target.id,state:lifecycle.state,versionNumber:x.versionNumber,alreadyCurrent:true};
  const result=await activatePublicationVersion(db,target.id,reviewerUserId,"rollback");await audit(db,null,reviewerUserId,"publishing_release",lifecycle.id,"rollback",{toVersion:x.versionNumber,fromVersionId:lifecycle.current_publication_version_id,reasonCode:x.reasonCode,notes:x.notes});return result;
}

export async function reviewPublishingSubmission(env: PublishingEnv, reviewerUserId: string, raw: unknown) {
  const x=z.object({submissionId:z.string().min(1),decision:z.enum(["approve","request_changes","reject","hold"]),reasonCode:z.string().max(120).default(""),notes:z.string().max(4000).default(""),publishNow:z.boolean().default(true)}).parse(raw),db=env.DB,sub=await db.prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?").bind(x.submissionId).first<any>();if(!sub)throw new ApiError(404,"Publishing submission not found.");if(!["submitted","in_review"].includes(String(sub.status)))throw new ApiError(409,"This submission is not in an actionable review state. Requested changes require a new revision and submission.");
  const lifecycleBefore=await ensurePublishingLifecycle(db,String(sub.edition_id));if(x.decision==="approve"&&["suppressed","takedown","retired"].includes(String(lifecycleBefore.state)))throw new ApiError(409,"This release is under staff enforcement. Restore the release before approving a publisher update.");
  const at=now(),next=x.decision==="approve"?"approved":x.decision==="request_changes"?"changes_requested":x.decision==="reject"?"rejected":"in_review";
  await db.batch([db.prepare("INSERT INTO publishing_submission_reviews(id,submission_id,reviewer_user_id,decision,reason_code,notes,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("pubreview"),x.submissionId,reviewerUserId,x.decision,x.reasonCode,x.notes,at),db.prepare("UPDATE publishing_submission_snapshots SET status=?,decided_at=? WHERE id=?").bind(next,at,x.submissionId),db.prepare("UPDATE publishing_edition_drafts SET status=?,updated_at=? WHERE id=?").bind(x.decision==="request_changes"?"changes_requested":x.decision==="approve"?"approved":x.decision==="reject"?"withdrawn":"submitted",at,sub.edition_id)]);
  const hasLiveVersion=!!lifecycleBefore.current_publication_version_id;
  const lifecycleDecision=x.decision==="approve"?"approved":x.decision==="request_changes"?(hasLiveVersion?"live":"draft"):x.decision==="reject"?(hasLiveVersion?"live":"retired"):"human_review";
  await transitionPublishingLifecycle(db,String(sub.edition_id),lifecycleDecision,"staff",reviewerUserId,x.reasonCode||x.decision,{submissionId:x.submissionId,notes:x.notes,keptPriorLiveVersion:hasLiveVersion&&x.decision!=="approve"});
  await audit(db,String(sub.account_id),reviewerUserId,"publishing_submission",x.submissionId,x.decision,{reasonCode:x.reasonCode});
  if(x.decision==="approve"||x.decision==="reject"||x.decision==="request_changes")try{const edition=await db.prepare(`SELECT e.id,t.title FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`).bind(sub.edition_id).first<any>(),members=(await db.prepare("SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','editor')").bind(sub.account_id).all<any>()).results,eventType=x.decision==="approve"?"publisher_book_approved":"publisher_book_rejected",label=x.decision==="approve"?"approved":x.decision==="request_changes"?"needs changes":"rejected";for(const m of members)await emitNotification(db,{userId:String(m.user_id),eventType,dedupeKey:`publishing-review:${x.submissionId}:${x.decision}:${m.user_id}`,title:`${edition?.title||"Your book"} ${label}`,body:x.notes|| (x.decision==="approve"?"Cove approved this submission.":x.decision==="request_changes"?"Cove requested changes before this submission can be published.":"Cove rejected this submission."),urgency:x.decision==="approve"?"normal":"high",subjectType:"publishing_submission",subjectId:x.submissionId,actionUrl:"/publishing",payload:{submissionId:x.submissionId,editionId:sub.edition_id,decision:x.decision,reasonCode:x.reasonCode}});}catch(e){console.error("Publishing decision notification enqueue failed",e);}
  if(x.decision==="approve"&&x.publishNow)return {decision:x.decision,publication:await materializePublishingSubmission(env,x.submissionId,reviewerUserId)};return {decision:x.decision,status:next};
}

export async function reviewPublishingOnboarding(db: PublishingDB, reviewerUserId: string, raw: unknown) {
  const x=z.object({accountId:z.string().min(1),kind:z.enum(["identity","tax","payout"]),recordId:z.string().min(1),status:z.enum(["verified","failed","expired","manual_review","restricted"]),reasonCode:z.string().max(120).default(""),withholdingBps:z.number().int().min(0).max(10000).optional(),requirementsDue:z.array(z.string().max(240)).max(100).optional()}).parse(raw),at=now();
  if(x.kind==="identity"){if(x.status==="restricted")throw new ApiError(400,"Restricted is not an identity status.");await db.batch([db.prepare("UPDATE publishing_identity_verifications SET status=?,reason_code=?,decided_at=? WHERE id=? AND account_id=?").bind(x.status,x.reasonCode,at,x.recordId,x.accountId),db.prepare("UPDATE publishing_accounts SET identity_status=?,updated_at=? WHERE id=?").bind(x.status,at,x.accountId)]);}
  else if(x.kind==="tax"){if(x.status==="restricted")throw new ApiError(400,"Restricted is not a tax status.");await db.batch([db.prepare("UPDATE publishing_tax_profiles SET status=?,reason_code=?,withholding_bps=COALESCE(?,withholding_bps),validated_at=CASE WHEN ?='verified' THEN ? ELSE validated_at END,updated_at=? WHERE id=? AND account_id=?").bind(x.status,x.reasonCode,x.withholdingBps??null,x.status,at,at,x.recordId,x.accountId),db.prepare("UPDATE publishing_accounts SET tax_status=?,updated_at=? WHERE id=?").bind(x.status,at,x.accountId)]);}
  else {const status=x.status==="expired"||x.status==="manual_review"?"restricted":x.status;await db.batch([db.prepare("UPDATE publishing_payout_accounts SET status=?,requirements_due_json=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,updated_at=? WHERE id=? AND account_id=?").bind(status,JSON.stringify(x.requirementsDue||[]),status,at,at,x.recordId,x.accountId),db.prepare("UPDATE publishing_accounts SET payout_status=?,updated_at=? WHERE id=?").bind(status,at,x.accountId)]);}
  await audit(db,x.accountId,reviewerUserId,`${x.kind}_verification`,x.recordId,"reviewed",{status:x.status,reasonCode:x.reasonCode});return{saved:true};
}

export async function publishingSnapshot(db: PublishingDB, userId: string, accountId?: string | null) {
  const memberships=(await db.prepare(`SELECT m.*,a.display_name,a.legal_name,a.country_code,a.status account_status,a.identity_status,a.tax_status,a.payout_status,a.terms_accepted_at FROM publishing_account_members m JOIN publishing_accounts a ON a.id=m.account_id WHERE m.user_id=? AND m.status='active' ORDER BY a.created_at`).bind(userId).all<any>()).results;
  const selected=accountId ? memberships.find(m=>m.account_id===accountId) : memberships[0]; if(!selected)return{accounts:memberships,account:null,titles:[],penNames:[],members:[],onboarding:null}; const aid=String(selected.account_id); await requireRole(db,userId,aid,"analyst");
  const [account,addresses,penNames,members,titles,editions,assets,validations,submissions,publications]=await Promise.all([
    db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(aid).first<any>(),db.prepare("SELECT * FROM publishing_addresses WHERE account_id=? ORDER BY address_type").bind(aid).all<any>(),db.prepare("SELECT * FROM publishing_pen_names WHERE account_id=? ORDER BY display_name").bind(aid).all<any>(),db.prepare("SELECT role,status,invited_email,accepted_at,created_at,user_id FROM publishing_account_members WHERE account_id=? ORDER BY created_at").bind(aid).all<any>(),db.prepare("SELECT * FROM publishing_titles WHERE account_id=? ORDER BY updated_at DESC").bind(aid).all<any>(),db.prepare(`SELECT e.* FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY e.updated_at DESC`).bind(aid).all<any>(),db.prepare(`SELECT a.*,v.version_number,v.original_filename,v.mime_type,v.size_bytes,v.sha256,v.quarantine_status,v.validation_summary,v.extracted_metadata_json FROM publishing_assets a JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE t.account_id=? ORDER BY a.updated_at DESC`).bind(aid).all<any>(),db.prepare(`SELECT j.*,v.original_filename,a.kind,a.edition_id FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY j.created_at DESC LIMIT 500`).bind(aid).all<any>(),db.prepare("SELECT id,edition_id,revision,status,snapshot_sha256,submitted_at,decided_at,published_at FROM publishing_submission_snapshots WHERE account_id=? ORDER BY submitted_at DESC").bind(aid).all<any>(),db.prepare("SELECT * FROM publishing_publications WHERE publishing_account_id=? ORDER BY published_at DESC").bind(aid).all<any>()]);
  const latestIdentity=await db.prepare("SELECT id,provider,status,reason_code,initiated_at,decided_at,expires_at FROM publishing_identity_verifications WHERE account_id=? ORDER BY initiated_at DESC LIMIT 1").bind(aid).first<any>(),latestTax=await db.prepare("SELECT id,country_code,tax_classification,form_type,provider,status,withholding_bps,treaty_country_code,validated_at,expires_at FROM publishing_tax_profiles WHERE account_id=? ORDER BY updated_at DESC LIMIT 1").bind(aid).first<any>(),latestPayout=await db.prepare("SELECT id,provider,method,bank_country_code,payout_currency,account_last4,status,payout_threshold_minor,requirements_due_json,verified_at FROM publishing_payout_accounts WHERE account_id=? ORDER BY updated_at DESC LIMIT 1").bind(aid).first<any>();
  const [lifecycles,publicationVersions,activations,moderationCases,appeals]=await Promise.all([
    db.prepare(`SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY l.updated_at DESC`).bind(aid).all<any>(),
    db.prepare(`SELECT pv.id,pv.lifecycle_id,pv.submission_id,pv.version_number,pv.previous_version_id,pv.rollback_of_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pv.created_at DESC`).bind(aid).all<any>(),
    db.prepare(`SELECT pa.* FROM publishing_publication_activations pa JOIN publishing_release_lifecycles l ON l.id=pa.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pa.created_at DESC LIMIT 500`).bind(aid).all<any>(),
    db.prepare(`SELECT c.*,(SELECT ma.id FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_id,(SELECT ma.action_type FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_type,(SELECT ma.rationale FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_rationale,(SELECT ma.reversible FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_reversible FROM moderation_cases c WHERE c.publishing_account_id=? ORDER BY c.updated_at DESC LIMIT 200`).bind(aid).all<any>(),
    db.prepare("SELECT a.*,c.category,c.summary FROM moderation_appeals a JOIN moderation_cases c ON c.id=a.case_id WHERE a.publishing_account_id=? ORDER BY a.submitted_at DESC").bind(aid).all<any>(),
  ]);
  let finance={statements:[] as any[],payouts:[] as any[],royaltyBalances:[] as any[]};
  if(account?.finance_party_id){const [statementRows,payoutRows,balanceRows]=await Promise.all([db.prepare("SELECT id,period_start,period_end,currency,sales_minor,refunds_minor,royalties_minor,withholding_minor,reserve_minor,payable_minor,generated_at FROM finance_statements WHERE party_id=? ORDER BY period_end DESC,generated_at DESC LIMIT 24").bind(account.finance_party_id).all<any>(),db.prepare(`SELECT pi.id,pi.currency,pi.gross_minor,pi.withholding_minor,pi.net_minor,pi.status,pi.external_payout_id,pi.created_at,pb.period_start,pb.period_end,pb.paid_at FROM payout_items pi JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pi.party_id=? ORDER BY pi.created_at DESC LIMIT 50`).bind(account.finance_party_id).all<any>(),db.prepare("SELECT currency,status,SUM(royalty_minor) royalty_minor,SUM(withholding_minor) withholding_minor,SUM(payable_minor) payable_minor,COUNT(*) event_count FROM finance_royalty_allocations WHERE party_id=? GROUP BY currency,status ORDER BY currency,status").bind(account.finance_party_id).all<any>()]);finance={statements:statementRows.results,payouts:payoutRows.results,royaltyBalances:balanceRows.results};}
  const trust=await publisherRightsSnapshot(db,userId,aid);
  return{accounts:memberships,account,addresses:addresses.results,penNames:penNames.results,members:members.results,titles:titles.results,editions:editions.results,assets:assets.results,validations:validations.results,submissions:submissions.results,publications:publications.results,lifecycles:lifecycles.results,publicationVersions:publicationVersions.results,publicationActivations:activations.results,moderationCases:moderationCases.results,appeals:appeals.results,finance,...trust,onboarding:{identity:latestIdentity,tax:latestTax,payout:latestPayout,ready:account?.identity_status==="verified"&&account?.tax_status==="verified"&&account?.payout_status==="verified"&&!!account?.terms_accepted_at}};
}

export async function adminPublishingSnapshot(db: PublishingDB) {
  const [accounts,submissions,jobs,duplicates,auditRows,lifecycles,versions,activations,automated]=await Promise.all([
    db.prepare(`SELECT a.*,(SELECT count(*) FROM publishing_titles t WHERE t.account_id=a.id) title_count,(SELECT COALESCE(SUM(s.strike_points),0) FROM moderation_sanctions s WHERE s.publishing_account_id=a.id AND s.status='active') active_strikes FROM publishing_accounts a ORDER BY a.updated_at DESC LIMIT 500`).all<any>(),
    db.prepare(`SELECT s.id,s.edition_id,s.account_id,s.revision,s.status,s.snapshot_sha256,s.submitted_at,s.decided_at,s.published_at,t.title,e.format,a.display_name publisher_name,ar.outcome automated_outcome,ar.risk_score automated_risk_score,l.state lifecycle_state FROM publishing_submission_snapshots s JOIN publishing_edition_drafts e ON e.id=s.edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=s.account_id LEFT JOIN publishing_automated_reviews ar ON ar.submission_id=s.id LEFT JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id ORDER BY s.submitted_at DESC LIMIT 500`).all<any>(),
    db.prepare("SELECT status,check_type,count(*) count FROM publishing_validation_jobs GROUP BY status,check_type ORDER BY status,check_type").all<any>(),
    db.prepare(`SELECT d.*,v.original_filename,a.kind,t.title FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.disposition IN ('review','fraud_hold') ORDER BY d.created_at DESC LIMIT 500`).all<any>(),
    db.prepare("SELECT * FROM publishing_audit_events ORDER BY created_at DESC LIMIT 300").all<any>(),
    db.prepare(`SELECT l.*,t.title,a.display_name publisher_name,e.format,e.catalog_product_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=t.account_id ORDER BY l.updated_at DESC LIMIT 500`).all<any>(),
    db.prepare(`SELECT pv.id,pv.lifecycle_id,pv.version_number,pv.previous_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id,t.title FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id ORDER BY pv.created_at DESC LIMIT 1000`).all<any>(),
    db.prepare("SELECT * FROM publishing_publication_activations ORDER BY created_at DESC LIMIT 1000").all<any>(),
    db.prepare("SELECT * FROM publishing_automated_reviews ORDER BY created_at DESC LIMIT 500").all<any>(),
  ]);return{accounts:accounts.results,submissions:submissions.results,jobs:jobs.results,duplicates:duplicates.results,audit:auditRows.results,lifecycles:lifecycles.results,versions:versions.results,activations:activations.results,automatedReviews:automated.results};
}

export async function resolveDuplicateMatch(db: PublishingDB, reviewerUserId: string, raw: unknown) {const x=z.object({id:z.string().min(1),disposition:z.enum(["cleared","duplicate","fraud_hold"])}).parse(raw),row=await db.prepare(`SELECT d.*,t.account_id FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.id=?`).bind(x.id).first<any>();if(!row)throw new ApiError(404,"Duplicate review item not found.");await db.prepare("UPDATE publishing_duplicate_matches SET disposition=?,updated_at=? WHERE id=?").bind(x.disposition,now(),x.id).run();await audit(db,row.account_id,reviewerUserId,"duplicate_match",x.id,"resolved",{disposition:x.disposition});return{saved:true};}

export async function catalogPublishingAsset(env: PublishingEnv, assetVersionId: string) {const row=await env.DB.prepare(`SELECT av.object_key,av.mime_type,av.size_bytes,da.kind,p.storefront_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id JOIN editions e ON e.id=da.edition_id JOIN products p ON p.edition_id=e.id WHERE av.id=? AND da.kind='cover' AND p.storefront_status='active' LIMIT 1`).bind(assetVersionId).first<any>();if(!row||!env.BUCKET)throw new ApiError(404,"Catalog asset not found.");const object=await env.BUCKET.get(row.object_key);if(!object)throw new ApiError(404,"Catalog asset not found.");return new Response(object.body,{headers:{"Content-Type":row.mime_type||"application/octet-stream","Content-Length":String(object.size||row.size_bytes||0),"Cache-Control":"public, max-age=86400, stale-while-revalidate=604800","X-Content-Type-Options":"nosniff"}});}
