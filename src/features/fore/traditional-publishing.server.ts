import { z } from "zod";
import JSZip from "jszip";
import type { CatalogDB } from "./catalog-model.server";
import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import { uploadPublishingAsset, publishingUploadLimit } from "./publishing.server";
import { drmSatisfiesRequirement, upsertRightsGrant } from "./rights.server";

export type PartnerEnvironment = "sandbox" | "production";
export type PartnerPrincipal = {
  credentialId: string;
  accountId: string;
  environment: PartnerEnvironment;
  actorUserId: string;
  keyPrefix: string;
  scopes: Set<string>;
};

type PartnerProduct = {
  productKey: string;
  recordReference?: string;
  workReference?: string;
  originalWorkTitle?: string;
  notificationType: "create" | "update" | "delete";
  title?: string;
  subtitle?: string;
  description?: string;
  language?: string;
  format?: "ebook" | "audiobook";
  editionLabel?: string;
  isbn13?: string | null;
  publisherIdentifier?: string;
  publisherName?: string;
  imprintName?: string;
  contributors?: { name: string; role: "author" | "editor" | "translator" | "illustrator" | "narrator" | "other"; position: number }[];
  rightsBasis?: "owned" | "licensed" | "public_domain";
  territories?: { mode: "worldwide" | "expression"; include: string[]; exclude: string[] };
  releaseDate?: string | null;
  preorderDate?: string | null;
  currency?: string;
  priceMinor?: number;
  availability?: "available" | "preorder" | "temporarily_unavailable" | "withdrawn";
  subscriptionPermitted?: boolean;
  libraryPermitted?: boolean;
  downloadable?: boolean;
  drmRequirement?: "none" | "watermark" | "lcp" | "adobe_acs";
  editionType?: "canonical_public_domain" | "annotated" | "new_translation" | "illustrated" | "scholarly" | "commercial_audiobook" | "original";
  differentiationSummary?: string;
  contractReference?: string;
  sourceRevision?: string;
  assetKind?: "epub" | "cover" | "audio" | "sample" | "supplement";
  filename?: string;
  sha256?: string;
  sizeBytes?: number;
  mimeType?: string;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const encoder = new TextEncoder();
const clean = (v: unknown, max = 1000) => String(v ?? "").trim().slice(0, max);

async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function derivedPartnerWebhookSecret(masterSecret: string, accountId: string) {
  if (!masterSecret || masterSecret.length < 32) throw new ApiError(503, "Partner webhook signing is not configured.");
  return `fwhsec_${bytesToBase64Url(await hmacSha256(masterSecret, `fore-partner-webhook-v1:${accountId}`))}`;
}

function randomToken(bytes = 32) {
  const raw = new Uint8Array(bytes); crypto.getRandomValues(raw);
  let binary = ""; for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { const x = typeof value === "string" ? JSON.parse(value) : value; return (x ?? fallback) as T; } catch { return fallback; }
}

function roleAllows(role: string, required: "analyst" | "editor" | "admin" | "owner") {
  const rank: Record<string, number> = { analyst: 1, finance: 1, editor: 2, admin: 3, owner: 4 };
  return (rank[role] || 0) >= (rank[required] || 99);
}

async function requirePartnerRole(db: CatalogDB, userId: string, accountId: string, required: "analyst" | "editor" | "admin" | "owner") {
  const member = await db.prepare("SELECT role,status FROM publishing_account_members WHERE account_id=? AND user_id=?").bind(accountId, userId).first<any>();
  if (!member || member.status !== "active" || !roleAllows(String(member.role), required)) throw new ApiError(403, "You do not have permission to manage this publisher integration.");
  const account = await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(accountId).first<any>();
  if (!account || ["suspended", "closed"].includes(String(account.status))) throw new ApiError(403, "This publishing organization is not active.");
  return account;
}

async function partnerAudit(db: CatalogDB, input: { accountId: string; environment?: string; actorType: string; actorId?: string; eventType: string; subjectType?: string; subjectId?: string; event?: unknown }) {
  await db.prepare("INSERT INTO publisher_partner_audit_events(id,account_id,environment,actor_type,actor_id,event_type,subject_type,subject_id,event_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(id("paudit"), input.accountId, input.environment || "production", input.actorType, input.actorId || "", input.eventType, input.subjectType || "", input.subjectId || "", JSON.stringify(input.event || {}), now()).run();
}

function normalizedCountryList(value: unknown) {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,;]+/g);
  return [...new Set(values.map((x) => clean(x, 2).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x) && !["XX", "ZZ"].includes(x)))].sort();
}

function safePartnerCallbackUrl(value: string) {
  if (!value) return "";
  let u: URL;
  try { u = new URL(value); } catch { throw new ApiError(400, "Partner callback URL is invalid."); }
  if (u.protocol !== "https:") throw new ApiError(400, "Partner callback URLs must use HTTPS.");
  if (u.username || u.password) throw new ApiError(400, "Partner callback URLs may not include embedded credentials.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = h.includes(":");
  const blocked = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
    h === "0.0.0.0" || h === "::" || h === "::1" || h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || (ipv6 && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")));
  if (blocked) throw new ApiError(400, "Partner callback URLs may not target localhost or private network addresses.");
  u.hash = "";
  return u.toString();
}

const profileSchema = z.object({
  accountId: z.string().min(1), partnerCode: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9_-]+$/).transform(v => v.toUpperCase()),
  partnerType: z.enum(["publisher", "distributor", "aggregator", "agent"]).default("publisher"), integrationTier: z.enum(["managed", "api", "sftp", "hybrid"]).default("managed"),
  productionStatus: z.enum(["not_started", "testing", "certification", "active", "paused", "terminated"]).default("testing"), sandboxEnabled: z.boolean().default(true),
  metadataStandard: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"), defaultContractId: z.string().max(180).nullable().optional(),
  operationsEmail: z.string().email().or(z.literal("")).default(""), technicalEmail: z.string().email().or(z.literal("")).default(""), acknowledgementsUrl: z.string().url().or(z.literal("")).default(""), webhookUrl: z.string().url().or(z.literal("")).default(""), notes: z.string().max(5000).default("")
});

export async function savePartnerProfile(db: CatalogDB, userId: string, raw: unknown) {
  const x = profileSchema.parse(raw); await requirePartnerRole(db, userId, x.accountId, "admin"); x.acknowledgementsUrl=safePartnerCallbackUrl(x.acknowledgementsUrl);x.webhookUrl=safePartnerCallbackUrl(x.webhookUrl);
  // Certification is a retailer-side control. Publisher admins may edit integration
  // settings, but cannot promote themselves to production or clear a staff pause.
  const existingProfile = await db.prepare("SELECT production_status FROM publisher_partner_profiles WHERE account_id=?").bind(x.accountId).first<any>();
  const productionStatus = existingProfile ? String(existingProfile.production_status) : "testing";
  if (x.defaultContractId) {
    const assigned = await db.prepare("SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'").bind(x.accountId, x.defaultContractId).first<any>();
    if (!assigned) throw new ApiError(400, "The default contract must be actively assigned to this publishing organization.");
  }
  const at = now();
  await db.prepare(`INSERT INTO publisher_partner_profiles(account_id,partner_code,partner_type,integration_tier,production_status,sandbox_enabled,metadata_standard,default_contract_id,operations_email,technical_email,acknowledgements_url,webhook_url,notes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET partner_code=excluded.partner_code,partner_type=excluded.partner_type,integration_tier=excluded.integration_tier,sandbox_enabled=excluded.sandbox_enabled,metadata_standard=excluded.metadata_standard,default_contract_id=excluded.default_contract_id,operations_email=excluded.operations_email,technical_email=excluded.technical_email,acknowledgements_url=excluded.acknowledgements_url,webhook_url=excluded.webhook_url,notes=excluded.notes,updated_at=excluded.updated_at`)
    .bind(x.accountId, x.partnerCode, x.partnerType, x.integrationTier, productionStatus, x.sandboxEnabled ? 1 : 0, x.metadataStandard, x.defaultContractId || null, x.operationsEmail, x.technicalEmail, x.acknowledgementsUrl, x.webhookUrl, x.notes, at, at).run();
  if (x.acknowledgementsUrl || x.webhookUrl) {
    await db.prepare(`UPDATE publisher_validation_responses SET delivery_status='pending',next_attempt_at=?,last_error='' WHERE delivery_status='not_configured' AND submission_id IN (SELECT id FROM publisher_feed_submissions WHERE account_id=?)`).bind(at,x.accountId).run();
  }
  await partnerAudit(db, { accountId: x.accountId, actorType: "user", actorId: userId, eventType: "partner.profile.saved", subjectType: "partner", subjectId: x.accountId, event: { partnerCode: x.partnerCode, productionStatus } });
  return { accountId: x.accountId, updatedAt: at };
}


export async function certifyPartnerProfile(db: CatalogDB, actorUserId: string, raw: unknown) {
  const x = z.object({
    accountId: z.string().min(1),
    productionStatus: z.enum(["not_started", "testing", "certification", "active", "paused", "terminated"]),
    reason: z.string().trim().min(3).max(2000),
  }).parse(raw);
  const profile = await db.prepare("SELECT account_id,production_status,partner_code FROM publisher_partner_profiles WHERE account_id=?").bind(x.accountId).first<any>();
  if (!profile) throw new ApiError(404, "Partner integration profile not found.");
  const previous = String(profile.production_status);
  if (previous === "terminated" && x.productionStatus !== "terminated") throw new ApiError(409, "A terminated partner must be re-onboarded under a new staff-approved process rather than reactivated in place.");
  if (x.productionStatus === "active") {
    const [assignment, activeVersion] = await Promise.all([
      db.prepare("SELECT contract_id FROM publisher_contract_assignments WHERE account_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1").bind(x.accountId, now(), now()).first<any>(),
      db.prepare(`SELECT rcv.id FROM publisher_contract_assignments a JOIN rights_contract_versions rcv ON rcv.contract_id=a.contract_id WHERE a.account_id=? AND a.status='active' AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) LIMIT 1`).bind(x.accountId, now(), now()).first<any>(),
    ]);
    if (!assignment || !activeVersion) throw new ApiError(409, "Production activation requires an active assigned distribution contract with an effective approved contract version.");
  }
  const at = now();
  await db.prepare("UPDATE publisher_partner_profiles SET production_status=?,updated_at=? WHERE account_id=?").bind(x.productionStatus, at, x.accountId).run();
  if (["paused","terminated"].includes(x.productionStatus)) await db.prepare("UPDATE publisher_partner_credentials SET status='revoked',revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND environment='production' AND status='active'").bind(at,x.accountId).run();
  await partnerAudit(db,{accountId:x.accountId,environment:"production",actorType:"user",actorId:actorUserId,eventType:"partner.certification.changed",subjectType:"partner",subjectId:x.accountId,event:{from:previous,to:x.productionStatus,reason:x.reason}});
  return {accountId:x.accountId,from:previous,to:x.productionStatus,updatedAt:at};
}

const channelSchema = z.object({
  id: z.string().max(180).optional(), accountId: z.string().min(1), environment: z.enum(["sandbox", "production"]), channelType: z.enum(["api", "sftp", "object_drop"]), label: z.string().trim().min(1).max(120),
  status: z.enum(["active", "paused", "disabled"]).default("active"), metadataFormat: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"),
  config: z.record(z.string(), z.unknown()).default({}), secretReference: z.string().max(500).default("")
});
export async function savePartnerChannel(db: CatalogDB, userId: string, raw: unknown) {
  const x = channelSchema.parse(raw); await requirePartnerRole(db, userId, x.accountId, "admin");
  if (x.channelType === "sftp" && !x.secretReference) throw new ApiError(400, "SFTP channels must point to a secret-manager credential reference. Raw passwords/private keys are not stored in Cove.");
  const disallowed = ["password", "privateKey", "secret", "token"].filter(k => Object.keys(x.config).some(v => v.toLowerCase().includes(k.toLowerCase())));
  if (disallowed.length) throw new ApiError(400, "Channel config may contain only non-secret transport settings. Store credentials in your secret manager and provide secretReference.");
  const channelId = x.id || id("pchannel"), at = now();
  await db.prepare(`INSERT INTO publisher_ingestion_channels(id,account_id,environment,channel_type,label,status,metadata_format,config_json,secret_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET environment=excluded.environment,channel_type=excluded.channel_type,label=excluded.label,status=excluded.status,metadata_format=excluded.metadata_format,config_json=excluded.config_json,secret_reference=excluded.secret_reference,updated_at=excluded.updated_at`)
    .bind(channelId, x.accountId, x.environment, x.channelType, x.label, x.status, x.metadataFormat, JSON.stringify(x.config), x.secretReference, at, at).run();
  await partnerAudit(db, { accountId: x.accountId, environment: x.environment, actorType: "user", actorId: userId, eventType: "partner.channel.saved", subjectType: "channel", subjectId: channelId, event: { channelType: x.channelType, label: x.label } });
  return { id: channelId };
}

const credentialSchema = z.object({ accountId: z.string().min(1), environment: z.enum(["sandbox", "production"]), label: z.string().trim().min(1).max(120), scopes: z.array(z.enum(["feeds:write", "feeds:read", "assets:write", "catalog:read"])).min(1).max(4).default(["feeds:write", "feeds:read"]), ipAllowlist: z.array(z.string().trim().min(3).max(80)).max(100).default([]), expiresAt: z.string().datetime().nullable().optional() });
export async function issuePartnerCredential(db: CatalogDB, userId: string, raw: unknown) {
  const x = credentialSchema.parse(raw); await requirePartnerRole(db, userId, x.accountId, "admin");
  const profile = await db.prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?").bind(x.accountId).first<any>();
  if (!profile) throw new ApiError(409, "Configure the traditional-publisher partner profile before issuing credentials.");
  if (x.environment === "production" && String(profile.production_status) !== "active") throw new ApiError(409, "Production credentials are issued only after partner certification is active.");
  if (x.environment === "sandbox" && !Number(profile.sandbox_enabled)) throw new ApiError(409, "Sandbox access is disabled for this partner.");
  const prefix = `fore_${x.environment === "production" ? "live" : "test"}_${randomToken(8)}`, secret = randomToken(32), presented = `${prefix}.${secret}`, hash = await sha256(presented), credentialId = id("pcred"), at = now();
  await db.prepare("INSERT INTO publisher_partner_credentials(id,account_id,environment,label,key_prefix,secret_hash,scopes_json,ip_allowlist_json,actor_user_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)")
    .bind(credentialId, x.accountId, x.environment, x.label, prefix, hash, JSON.stringify(x.scopes), JSON.stringify(x.ipAllowlist), userId, x.expiresAt || null, at).run();
  await partnerAudit(db, { accountId: x.accountId, environment: x.environment, actorType: "user", actorId: userId, eventType: "partner.credential.issued", subjectType: "credential", subjectId: credentialId, event: { label: x.label, scopes: x.scopes, keyPrefix: prefix } });
  return { id: credentialId, environment: x.environment, keyPrefix: prefix, secret: presented, scopes: x.scopes, expiresAt: x.expiresAt || null, warning: "Copy this credential now. Cove stores only its cryptographic digest and cannot show the secret again." };
}

export async function revokePartnerCredential(db: CatalogDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), credentialId: z.string().min(1) }).parse(raw); await requirePartnerRole(db, userId, x.accountId, "admin");
  const row = await db.prepare("SELECT id,environment FROM publisher_partner_credentials WHERE id=? AND account_id=?").bind(x.credentialId, x.accountId).first<any>(); if (!row) throw new ApiError(404, "Partner credential not found.");
  const at = now(); await db.prepare("UPDATE publisher_partner_credentials SET status='revoked',revoked_at=? WHERE id=?").bind(at, x.credentialId).run();
  await partnerAudit(db, { accountId: x.accountId, environment: row.environment, actorType: "user", actorId: userId, eventType: "partner.credential.revoked", subjectType: "credential", subjectId: x.credentialId }); return { revoked: true, revokedAt: at };
}

function ipMatchesRule(ip: string, rule: string) {
  if (!rule) return false; if (ip === rule) return true;
  // Conservative CIDR support for IPv4. IPv6 allowlists should use exact addresses until a dedicated parser is deployed.
  const m = rule.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/); const p = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); if (!m || !p) return false;
  const bits = Number(m[5]); if (bits < 0 || bits > 32) return false; const toN = (a: RegExpMatchArray) => (((Number(a[1]) << 24) >>> 0) + (Number(a[2]) << 16) + (Number(a[3]) << 8) + Number(a[4])) >>> 0; const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return (toN(m) & mask) === (toN(p) & mask);
}

export async function authenticatePartnerRequest(db: CatalogDB, request: Request, requiredScope: string): Promise<PartnerPrincipal> {
  const supplied = clean(request.headers.get("x-fore-partner-key") || request.headers.get("authorization")?.replace(/^CovePartner\s+/i, ""), 500);
  const dot = supplied.indexOf("."); if (dot < 10) throw new ApiError(401, "A valid Cove partner credential is required."); const prefix = supplied.slice(0, dot);
  const row = await db.prepare("SELECT * FROM publisher_partner_credentials WHERE key_prefix=?").bind(prefix).first<any>();
  if (!row || row.status !== "active" || (row.expires_at && String(row.expires_at) <= now())) throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const hash = await sha256(supplied); let diff = hash.length ^ String(row.secret_hash).length; for (let i = 0; i < Math.max(hash.length, String(row.secret_hash).length); i++) diff |= (hash.charCodeAt(i) || 0) ^ (String(row.secret_hash).charCodeAt(i) || 0); if (diff !== 0) throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const scopes = new Set(parseJson<string[]>(row.scopes_json, [])); if (!scopes.has(requiredScope)) throw new ApiError(403, `Partner credential lacks ${requiredScope}.`);
  const allowlist = parseJson<string[]>(row.ip_allowlist_json, []); const ip = clean(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0], 100); if (allowlist.length && !allowlist.some(r => ipMatchesRule(ip, r))) throw new ApiError(403, "This client address is not allowed for the partner credential.");
  const profile = await db.prepare("SELECT production_status,sandbox_enabled FROM publisher_partner_profiles WHERE account_id=?").bind(row.account_id).first<any>(); if (!profile) throw new ApiError(403, "Partner integration is not configured.");
  if (row.environment === "production" && String(profile.production_status) !== "active") throw new ApiError(403, "Production partner ingestion is not active."); if (row.environment === "sandbox" && !Number(profile.sandbox_enabled)) throw new ApiError(403, "Partner sandbox access is disabled.");
  await db.prepare("UPDATE publisher_partner_credentials SET last_used_at=? WHERE id=?").bind(now(), row.id).run();
  return { credentialId: String(row.id), accountId: String(row.account_id), environment: row.environment, actorUserId: String(row.actor_user_id), keyPrefix: prefix, scopes };
}

function xmlDecode(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tagText(xml: string, tags: string[]) {
  for (const tag of tags) { const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const m = xml.match(new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`, "i")); if (m) return xmlDecode(m[1]); }
  return "";
}
function tagBlocks(xml: string, tag: string) { const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return [...xml.matchAll(new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`, "gi"))].map(m => m[1]); }
function onixDate(value: string) { const v = value.replace(/\D/g, ""); if (v.length >= 8) return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T00:00:00.000Z`; if (v.length >= 6) return `${v.slice(0,4)}-${v.slice(4,6)}-01T00:00:00.000Z`; if (v.length >= 4) return `${v.slice(0,4)}-01-01T00:00:00.000Z`; return null; }
function onixRole(code: string): "author" | "editor" | "translator" | "illustrator" | "narrator" | "other" {
  const c = code.toUpperCase();
  if (["B06", "B10"].includes(c)) return "translator";
  if (["A12", "A13"].includes(c)) return "illustrator";
  if (c === "E07") return "narrator";
  if (["A01","A02","A03","A04","A05","A06","A07","A08","A09","A10","A11"].includes(c)) return "author";
  if (/^B\d{2}$/.test(c)) return "editor";
  return "other";
}
function onixAvailability(code: string): PartnerProduct["availability"] { if (["20","21","22","23","30","31","32","33","40"].includes(code)) return "available"; if (["10","11","12","13","14","15","16","17"].includes(code)) return "preorder"; if (["41","42","43","44","45","46","47","48"].includes(code)) return "temporarily_unavailable"; if (["01","02","03","04","05","06","07","08","09","50","51","52","53","54","55","56","57","58","59","60","61","62","63","64","65","66","67","68","69","70","71","72","73","74","75","76","77","78","79","80","81","82","83","84","85","86","87","88","89","90","91","92","93","94","95","96","97","98","99"].includes(code)) return "withdrawn"; return "available"; }

function parseOnix(xml: string): { products: PartnerProduct[]; warnings: string[]; version: string } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ApiError(400, "ONIX feeds containing DTD/entity declarations are rejected. Submit self-contained ONIX XML without external entities.");
  if (/<(?:a001|b221|b244|j151|j152)\b/i.test(xml) && !/<(?:Product|RecordReference|ProductIdentifier)\b/i.test(xml)) throw new ApiError(400, "ONIX short-tag-only feeds are not accepted by Cove's in-process parser. Configure the partner channel to send ONIX reference tags; the ingestion acknowledgement fails closed rather than guessing short-tag semantics.");
  const version = /release\s*=\s*["']3/i.test(xml) ? "onix_3" : "onix_2_1", blocks = tagBlocks(xml, "Product"); if (!blocks.length) throw new ApiError(400, "No ONIX Product records were found.");
  const warnings: string[] = [], products: PartnerProduct[] = [];
  blocks.forEach((block, ordinal) => {
    const recordReference = tagText(block, ["RecordReference"]); const notificationCode = tagText(block, ["NotificationType"]); const notificationType: PartnerProduct["notificationType"] = notificationCode === "05" ? "delete" : ["01","02","03"].includes(notificationCode) ? "create" : "update";
    const identifiers = tagBlocks(block, "ProductIdentifier").map(b => ({ type: tagText(b,["ProductIDType"]), value: tagText(b,["IDValue"]) })); const isbn = identifiers.find(x => x.type === "15" && /^\d{13}$/.test(x.value))?.value || null; const proprietary = identifiers.find(x => x.type === "01")?.value || ""; const productKey = recordReference || isbn || proprietary;
    if (!productKey) { warnings.push(`Product ${ordinal + 1} has no RecordReference/ISBN/proprietary identifier.`); return; }
    const titleDetail = tagBlocks(block, "TitleDetail")[0] || tagBlocks(block, "Title")[0] || block; const title = tagText(titleDetail, ["TitleText", "TitleWithoutPrefix"]); const subtitle = tagText(titleDetail, ["Subtitle"]); const description = tagBlocks(block, "TextContent").map(t => tagText(t,["Text"])).find(Boolean) || tagText(block,["Annotation","OtherText"]);
    const contributors = tagBlocks(block, "Contributor").map((c, i) => ({ name: tagText(c,["PersonName","PersonNameInverted","CorporateName"]), role: onixRole(tagText(c,["ContributorRole"])), position: Number(tagText(c,["SequenceNumber"]) || i) })).filter(c => c.name).slice(0,50);
    const languageBlock = tagBlocks(block, "Language").find(l => ["01",""].includes(tagText(l,["LanguageRole"]))) || tagBlocks(block,"Language")[0] || ""; const language = (tagText(languageBlock,["LanguageCode"]) || "en").toLowerCase();
    const publisherBlock = tagBlocks(block,"Publisher")[0] || ""; const publisherName = tagText(publisherBlock,["PublisherName"]); const imprintName = tagText(tagBlocks(block,"Imprint")[0] || "",["ImprintName"]);
    const pubDates = tagBlocks(block,"PublishingDate"); const releaseDate = onixDate(tagText(pubDates.find(d => ["01","11"].includes(tagText(d,["PublishingDateRole"]))) || pubDates[0] || "",["Date"]));
    const supply = tagBlocks(block,"SupplyDetail")[0] || block; const availability = onixAvailability(tagText(supply,["ProductAvailability","ProductAvailabilityCode"])); const prices = tagBlocks(supply,"Price"); const retailPrice = prices.find(p => ["01","02","04","41","42"].includes(tagText(p,["PriceType","PriceTypeCode"]))) || prices[0] || ""; const amountRaw = tagText(retailPrice,["PriceAmount"]); const currency = (tagText(retailPrice,["CurrencyCode"]) || "USD").toUpperCase(); const priceMinor = amountRaw && !Number.isNaN(Number(amountRaw)) ? Math.round(Number(amountRaw) * 100) : undefined;
    const territoryBlocks = [...tagBlocks(block,"Territory"), ...tagBlocks(retailPrice,"Territory")]; const included = normalizedCountryList(territoryBlocks.flatMap(t => tagText(t,["CountriesIncluded"]).split(/\s+/g))); const excluded = normalizedCountryList(territoryBlocks.flatMap(t => tagText(t,["CountriesExcluded"]).split(/\s+/g)));
    const form = tagText(block,["ProductForm","ProductFormDetail"]); const format: "ebook" | "audiobook" = /audio|spoken|EC|ED|EA/i.test(form) ? "audiobook" : "ebook";
    const relatedWork=tagBlocks(block,"RelatedWork")[0]||"",workIdentifier=tagBlocks(relatedWork,"WorkIdentifier")[0]||"",workIdType=tagText(workIdentifier,["WorkIDType"]),workIdValue=tagText(workIdentifier,["IDValue"]),workReference=workIdValue?`${workIdType||"01"}:${workIdValue}`:"";
    products.push({ productKey, recordReference, workReference:workReference||undefined, notificationType, title: title || undefined, subtitle, description, language, format, editionLabel: tagText(block,["EditionStatement"]), isbn13: isbn, publisherIdentifier: proprietary || recordReference, publisherName, imprintName, contributors, rightsBasis: "licensed", territories: { mode: included.length ? "expression" : "worldwide", include: included, exclude: excluded }, releaseDate, currency, priceMinor, availability, editionType: format === "audiobook" ? "commercial_audiobook" : "original" });
  });
  return { products, warnings, version };
}

const partnerProductSchema = z.object({
  productKey: z.string().trim().min(1).max(300), recordReference: z.string().max(300).optional(), workReference:z.string().max(500).optional(), originalWorkTitle:z.string().max(500).optional(), notificationType: z.enum(["create","update","delete"]).default("update"), title: z.string().trim().max(500).optional(), subtitle: z.string().max(500).default(""), description: z.string().max(30000).default(""), language: z.string().min(2).max(35).default("en"), format: z.enum(["ebook","audiobook"]).default("ebook"), editionLabel: z.string().max(180).default(""), isbn13: z.string().regex(/^\d{13}$/).nullable().optional(), publisherIdentifier: z.string().max(300).default(""), publisherName: z.string().max(300).default(""), imprintName: z.string().max(300).default(""), contributors: z.array(z.object({ name:z.string().trim().min(1).max(300), role:z.enum(["author","editor","translator","illustrator","narrator","other"]), position:z.number().int().min(0).max(1000).default(0) })).max(100).default([]), rightsBasis: z.enum(["owned","licensed","public_domain"]).default("licensed"), territories: z.object({ mode:z.enum(["worldwide","expression"]).default("worldwide"), include:z.array(z.string()).default([]), exclude:z.array(z.string()).default([]) }).optional(), releaseDate:z.string().datetime().nullable().optional(), preorderDate:z.string().datetime().nullable().optional(), currency:z.string().regex(/^[A-Za-z]{3}$/).transform(v=>v.toUpperCase()).default("USD"), priceMinor:z.number().int().min(0).max(100000000).optional(), availability:z.enum(["available","preorder","temporarily_unavailable","withdrawn"]).optional(), subscriptionPermitted:z.boolean().default(false), libraryPermitted:z.boolean().default(false), downloadable:z.boolean().default(true), drmRequirement:z.enum(["none","watermark","lcp","adobe_acs"]).default("none"), editionType:z.enum(["canonical_public_domain","annotated","new_translation","illustrated","scholarly","commercial_audiobook","original"]).default("original"), differentiationSummary:z.string().max(5000).default(""), contractReference:z.string().max(300).default(""), sourceRevision:z.string().max(300).default(""), assetKind:z.enum(["epub","cover","audio","sample","supplement"]).optional(), filename:z.string().trim().min(1).max(240).optional(), sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(v=>v.toLowerCase()).optional(), sizeBytes:z.number().int().min(0).max(2_000_000_000).optional(), mimeType:z.string().max(120).optional()
});

function validatePartnerProduct(product: PartnerProduct, feedType: string) {
  const issues: { severity: "warning" | "error"; code: string; message: string }[] = [];
  if (feedType === "metadata" && product.notificationType !== "delete") {
    if (!product.title?.trim()) issues.push({ severity:"error", code:"TITLE_REQUIRED", message:"Metadata records require a title." });
    if (product.priceMinor == null) issues.push({ severity:"error", code:"INITIAL_PRICE_REQUIRED", message:"Metadata records require an explicit initial priceMinor, including an intentional zero price. Subsequent changes may use the dedicated price feed." });
    if (!product.territories) issues.push({ severity:"error", code:"INITIAL_TERRITORY_REQUIRED", message:"Metadata records require an explicit initial territory scope. Subsequent changes may use the dedicated territory feed." });
    if (!product.contributors?.some(c => c.role === "author") && product.format !== "audiobook") issues.push({ severity:"warning", code:"AUTHOR_MISSING", message:"No author contributor was supplied." });
    if (product.rightsBasis === "public_domain") {
      if (["original","canonical_public_domain"].includes(String(product.editionType))) issues.push({ severity:"error", code:"PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED", message:"Commercial public-domain submissions must declare a differentiated edition (annotated, new translation, illustrated, scholarly, or commercial audiobook). Cove reserves canonical_public_domain for canonical free-source ingestion." });
      if (!product.differentiationSummary?.trim()) issues.push({ severity:"error", code:"DIFFERENTIATION_SUMMARY_REQUIRED", message:"Explain the substantive differentiation from the canonical public-domain text." });
      if (product.editionType === "new_translation" && !product.contributors?.some(c => c.role === "translator")) issues.push({ severity:"error", code:"TRANSLATOR_REQUIRED", message:"A new translation must identify at least one translator." });
    }
    if (product.editionType === "commercial_audiobook" && product.format !== "audiobook") issues.push({ severity:"error", code:"EDITION_FORMAT_MISMATCH", message:"commercial_audiobook classification requires audiobook format." });
  }
  if (["price","availability","territory"].includes(feedType) && !product.productKey) issues.push({ severity:"error", code:"PRODUCT_KEY_REQUIRED", message:"Delta records require partnerProductKey." });
  if(feedType==="price" && product.priceMinor==null) issues.push({severity:"error",code:"PRICE_REQUIRED",message:"Price feed records require priceMinor."});
  if(feedType==="availability" && !product.availability) issues.push({severity:"error",code:"AVAILABILITY_REQUIRED",message:"Availability feed records require availability."});
  if(feedType==="territory" && !product.territories) issues.push({severity:"error",code:"TERRITORY_SCOPE_REQUIRED",message:"Territory feed records require an explicit territory scope."});
  if(feedType==="assets_manifest") {
    if(!product.assetKind) issues.push({severity:"error",code:"ASSET_KIND_REQUIRED",message:"Asset manifest records require assetKind."});
    if(!product.filename) issues.push({severity:"error",code:"ASSET_FILENAME_REQUIRED",message:"Asset manifest records require filename."});
    if(!product.sha256) issues.push({severity:"error",code:"ASSET_SHA256_REQUIRED",message:"Asset manifest records require sha256."});
    if(product.sizeBytes==null) issues.push({severity:"error",code:"ASSET_SIZE_REQUIRED",message:"Asset manifest records require sizeBytes."});
  }
  if (product.territories) { product.territories.include = normalizedCountryList(product.territories.include); product.territories.exclude = normalizedCountryList(product.territories.exclude); }
  return issues;
}

async function readBounded(request: Request, limit: number) { const len = Number(request.headers.get("content-length") || 0); if (len > limit) throw new ApiError(413, "Partner feed exceeds the configured upload limit."); const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > limit) throw new ApiError(413, "Partner feed exceeds the configured upload limit."); return bytes; }

export async function submitPartnerFeed(env: CoveEnv, request: Request, principal: PartnerPrincipal) {
  const bytes = await readBounded(request, 25 * 1024 * 1024), text = new TextDecoder().decode(bytes), contentType = (request.headers.get("content-type") || "").toLowerCase();
  const declaredFormat = clean(request.headers.get("x-fore-feed-format"), 30) || (contentType.includes("xml") ? "onix_3" : "fore_json"); const feedType = z.enum(["metadata","price","availability","territory","assets_manifest"]).parse(clean(request.headers.get("x-fore-feed-type"), 40) || "metadata"); const mode = z.enum(["full","delta"]).parse(clean(request.headers.get("x-fore-feed-mode"), 20) || "delta"); const replaceMissing = mode==="full"&&feedType==="metadata"&&["1","true","yes"].includes(clean(request.headers.get("x-fore-full-feed-delete-missing"),10).toLowerCase()); const externalFeedId = clean(request.headers.get("x-fore-feed-id"), 200) || `auto_${await sha256(bytes)}`; const sequenceRaw = clean(request.headers.get("x-fore-feed-sequence"), 30); const sequenceNumber = sequenceRaw ? z.coerce.number().int().min(0).parse(sequenceRaw) : null; const filename = clean(request.headers.get("x-fore-filename"), 240); const channelId = clean(request.headers.get("x-fore-channel-id"), 180) || null;
  const format = z.enum(["onix_3","onix_2_1","fore_json"]).parse(declaredFormat); const digest = await sha256(bytes), db = env.DB;
  if (channelId) {
    const channel = await db.prepare("SELECT id,channel_type,metadata_format FROM publisher_ingestion_channels WHERE id=? AND account_id=? AND environment=? AND status='active'").bind(channelId, principal.accountId, principal.environment).first<any>();
    if (!channel) throw new ApiError(409, "The declared ingestion channel is not active for this partner/environment.");
    if (feedType !== "assets_manifest" && String(channel.metadata_format) !== format) throw new ApiError(409, `Feed format ${format} does not match ingestion channel ${channelId} (${channel.metadata_format}).`);
  }
  const existing = await db.prepare("SELECT id,status,item_count,accepted_count,warning_count,rejected_count,applied_count FROM publisher_feed_submissions WHERE account_id=? AND environment=? AND feed_type=? AND (external_feed_id=? OR source_sha256=?) ORDER BY received_at DESC LIMIT 1").bind(principal.accountId, principal.environment, feedType, externalFeedId, digest).first<any>(); if (existing) return { ...existing, idempotentReplay: true };
  const cursor = await db.prepare("SELECT last_sequence_number FROM publisher_feed_cursors WHERE account_id=? AND environment=? AND feed_type=?").bind(principal.accountId, principal.environment, feedType).first<any>(); if (sequenceNumber != null && cursor?.last_sequence_number != null && Number(sequenceNumber) <= Number(cursor.last_sequence_number)) throw new ApiError(409, `Feed sequence ${sequenceNumber} is not newer than the last accepted sequence ${cursor.last_sequence_number}.`);
  let rawProducts: unknown[] = [], parserWarnings: string[] = [], detectedFormat = format;
  if (format === "fore_json") {
    let doc: any; try { doc = JSON.parse(text); } catch { throw new ApiError(400, "Partner JSON feed is not valid JSON."); }
    rawProducts = Array.isArray(doc) ? doc : feedType === "assets_manifest" && Array.isArray(doc.assets) ? doc.assets : Array.isArray(doc.products) ? doc.products : [];
    if (!rawProducts.length) throw new ApiError(400, feedType === "assets_manifest" ? "Asset manifest feeds must contain a non-empty assets array." : "Partner JSON feed must contain a non-empty products array.");
  } else {
    if (feedType === "assets_manifest") throw new ApiError(400, "Asset manifests use Cove JSON; ONIX is reserved for bibliographic metadata.");
    const parsed = parseOnix(text); rawProducts = parsed.products; parserWarnings = parsed.warnings; detectedFormat = parsed.version as typeof format;
  }
  const parsedProducts: PartnerProduct[] = []; const staged: { product: PartnerProduct; issues: any[]; fragmentSha: string }[] = [];
  for (const raw of rawProducts.slice(0, 100000)) {
    let product: PartnerProduct; try { product = partnerProductSchema.parse(raw) as PartnerProduct; } catch (e) { const issue = { severity:"error", code:"SCHEMA_INVALID", message:e instanceof Error ? e.message.slice(0,1500) : "Invalid product record." }; staged.push({ product:{productKey: clean((raw as any)?.productKey || (raw as any)?.recordReference || `invalid_${staged.length+1}`),notificationType:"update"}, issues:[issue], fragmentSha:await sha256(JSON.stringify(raw)) }); continue; }
    const issues = validatePartnerProduct(product, feedType); parsedProducts.push(product); staged.push({ product, issues, fragmentSha: await sha256(JSON.stringify(product)) });
  }
  if (rawProducts.length > 100000) throw new ApiError(413, "A single feed may contain at most 100,000 product records. Split larger catalogs into sequenced feed parts.");
  const rejected = staged.filter(s => s.issues.some(i => i.severity === "error")).length, warningItems = staged.filter(s => !s.issues.some(i=>i.severity==="error") && s.issues.some(i=>i.severity === "warning")).length, accepted = staged.length - rejected;
  const submissionId = id("pfeed"), at = now(), status = rejected === staged.length ? "rejected" : rejected > 0 || warningItems > 0 || parserWarnings.length ? "accepted_with_warnings" : "accepted"; let rawObjectKey: string | null = null;
  if (env.BUCKET) { rawObjectKey = `partner-ingest/${principal.environment}/${principal.accountId}/${submissionId}/source.${format === "fore_json" ? "json" : "xml"}`; await env.BUCKET.put(rawObjectKey, bytes, { httpMetadata:{contentType:contentType || (format === "fore_json" ? "application/json" : "application/xml")}, customMetadata:{sha256:digest,accountId:principal.accountId,feedType,environment:principal.environment} }); }
  const statements: any[] = [db.prepare(`INSERT INTO publisher_feed_submissions(id,account_id,credential_id,channel_id,environment,feed_type,feed_format,mode,replace_missing,external_feed_id,sequence_number,source_filename,source_sha256,raw_object_key,status,item_count,accepted_count,warning_count,rejected_count,error_summary,received_at,validated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(submissionId, principal.accountId, principal.credentialId, channelId, principal.environment, feedType, detectedFormat, mode, replaceMissing?1:0, externalFeedId, sequenceNumber, filename, digest, rawObjectKey, status, staged.length, accepted, warningItems + parserWarnings.length, rejected, rejected ? `${rejected} item(s) rejected.` : "", at, at)];
  staged.forEach((s, ordinal) => statements.push(db.prepare("INSERT INTO publisher_feed_items(id,submission_id,ordinal,partner_product_key,notification_type,normalized_json,source_fragment_sha256,status,validation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(id("pfitem"), submissionId, ordinal + 1, s.product.productKey, s.product.notificationType, JSON.stringify(s.product), s.fragmentSha, s.issues.some(i=>i.severity==="error") ? "rejected" : s.issues.length ? "warning" : "valid", JSON.stringify(s.issues), at, at)));
  statements.push(db.prepare("INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id("pack"), submissionId, "receipt", "received", "FEED_RECEIVED", "Feed received and validated by Cove.", JSON.stringify({submissionId,itemCount:staged.length,acceptedCount:accepted,rejectedCount:rejected,warningCount:warningItems + parserWarnings.length,parserWarnings}), "pending", at));
  statements.push(db.prepare("INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id("pack"), submissionId, "validation", status, status==="rejected"?"FEED_REJECTED":status==="accepted_with_warnings"?"FEED_VALID_WITH_WARNINGS":"FEED_VALID", status==="rejected"?"Feed validation rejected all records.":status==="accepted_with_warnings"?"Feed validation completed with warnings or rejected records.":"Feed validation passed.", JSON.stringify({submissionId,status,itemCount:staged.length,acceptedCount:accepted,rejectedCount:rejected,warningCount:warningItems + parserWarnings.length}), "pending", at));
  if (accepted > 0) statements.push(db.prepare("INSERT INTO publisher_feed_cursors(account_id,environment,feed_type,last_sequence_number,last_external_feed_id,last_source_sha256,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,environment,feed_type) DO UPDATE SET last_sequence_number=COALESCE(excluded.last_sequence_number,publisher_feed_cursors.last_sequence_number),last_external_feed_id=excluded.last_external_feed_id,last_source_sha256=excluded.last_source_sha256,updated_at=excluded.updated_at").bind(principal.accountId, principal.environment, feedType, sequenceNumber, externalFeedId, digest, at));
  await db.batch(statements); await partnerAudit(db,{accountId:principal.accountId,environment:principal.environment,actorType:"credential",actorId:principal.credentialId,eventType:"partner.feed.received",subjectType:"feed",subjectId:submissionId,event:{feedType,format:detectedFormat,mode,channelId,itemCount:staged.length,accepted,rejected,warnings:warningItems+parserWarnings.length}});
  return { id:submissionId,status,environment:principal.environment,feedType,feedFormat:detectedFormat,mode,itemCount:staged.length,acceptedCount:accepted,warningCount:warningItems+parserWarnings.length,rejectedCount:rejected,parserWarnings,acknowledgementPath:`/api/fore/partner/v1/feeds/${submissionId}/ack` };
}

async function candidateWorkIdentityKeys(p: PartnerProduct) {
  const norm=(v:string)=>clean(v).toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu," ").trim(),author=norm(p.contributors?.find(c=>c.role==="author")?.name||"");const keys:{key:string;scheme:string}[]=[];
  if(p.workReference) keys.push({key:`wref_${await sha256(clean(p.workReference,500).toLowerCase())}`,scheme:"external_work_reference"});
  const sourceTitle=norm(p.originalWorkTitle||p.title||"");if(sourceTitle&&author) keys.push({key:`wkeyta_${await sha256(`${sourceTitle}|${author}`)}`,scheme:"title_author"});
  if(sourceTitle) keys.push({key:`wkey_${await sha256(`${sourceTitle}|${author}|${clean(p.language||"en").toLowerCase()}`)}`,scheme:"title_author_language"});
  return keys;
}

async function activeContractVersion(db: CatalogDB, accountId: string, contractReference?: string) {
  let contract: any = null;
  const at = now();
  if (contractReference) contract = await db.prepare(`SELECT rc.* FROM rights_contracts rc JOIN publisher_contract_assignments a ON a.contract_id=rc.id WHERE a.account_id=? AND a.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?) AND (rc.reference_code=? OR rc.id=?) AND rc.status='active' LIMIT 1`).bind(accountId,at,at,contractReference,contractReference).first<any>();
  if (!contract) contract = await db.prepare(`SELECT rc.* FROM publisher_partner_profiles p JOIN rights_contracts rc ON rc.id=p.default_contract_id JOIN publisher_contract_assignments a ON a.contract_id=rc.id AND a.account_id=p.account_id WHERE p.account_id=? AND a.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?) AND rc.status='active' LIMIT 1`).bind(accountId,at,at).first<any>();
  if (!contract) return null;
  const version = await db.prepare("SELECT * FROM rights_contract_versions WHERE contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY version_number DESC LIMIT 1").bind(contract.id,now(),now()).first<any>();
  return version ? { contract, version } : null;
}

async function assertPartnerProductWithinContract(db: CatalogDB, contractVersionId: string, p: PartnerProduct) {
  const [territoryRows,formatRow,channelRows,allTerritories]=await Promise.all([
    db.prepare("SELECT territory_code,decision FROM rights_contract_version_territories WHERE contract_version_id=?").bind(contractVersionId).all<any>(),
    db.prepare("SELECT decision,drm_requirement FROM rights_contract_version_formats WHERE contract_version_id=? AND lower(format)=lower(?)").bind(contractVersionId,p.format||"ebook").first<any>(),
    db.prepare("SELECT sales_channel,permitted FROM rights_contract_version_channels WHERE contract_version_id=?").bind(contractVersionId).all<any>(),
    db.prepare("SELECT code FROM territories WHERE is_sellable=1").all<any>(),
  ]);
  if(!formatRow||String(formatRow.decision)!=="allow") throw new ApiError(409,`Contract does not permit ${p.format||"ebook"} distribution.`);
  if(!drmSatisfiesRequirement(String(formatRow.drm_requirement||"none"),String(p.drmRequirement||"none"))) throw new ApiError(409,"Feed DRM policy is weaker than the assigned contract requires.");
  const requestedChannels=["retail",...(p.subscriptionPermitted?["subscription"]:[]),...(p.libraryPermitted?["library"]:[])];
  if(channelRows.results.length){const permitted=new Set(channelRows.results.filter((r:any)=>Number(r.permitted)).map((r:any)=>String(r.sales_channel)));for(const channel of requestedChannels)if(!permitted.has(channel))throw new ApiError(409,`Contract does not permit ${channel} distribution.`);}
  if(territoryRows.results.length&&p.territories){const allow=new Set(territoryRows.results.filter((r:any)=>r.decision==="allow").map((r:any)=>String(r.territory_code))),deny=new Set(territoryRows.results.filter((r:any)=>r.decision==="deny").map((r:any)=>String(r.territory_code)));let requested:string[];if(p.territories.mode==="worldwide"){const excluded=new Set(normalizedCountryList(p.territories.exclude||[]));requested=allTerritories.results.map((r:any)=>String(r.code)).filter((c:string)=>!excluded.has(c));}else requested=normalizedCountryList(p.territories.include||[]).filter(c=>!new Set(normalizedCountryList(p.territories?.exclude||[])).has(c));if(requested.some((c:string)=>deny.has(c)||!allow.has(c)))throw new ApiError(409,"Feed territory scope exceeds the assigned contract version.");}
}

async function applyMetadataItem(db: CatalogDB, submission: any, item: any, p: PartnerProduct) {
  const at = now(), mapping = await db.prepare("SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(submission.account_id,p.productKey).first<any>();
  if (p.notificationType === "delete") {
    if (!mapping) return { type:"mapping", id:"", skipped:true, message:"No mapped title existed for delete notice." };
    const statements:any[]=[db.prepare("UPDATE publisher_catalog_mappings SET status='withdrawn',updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(at,submission.account_id,p.productKey)];
    if(mapping.publishing_edition_id)statements.push(db.prepare("UPDATE publishing_edition_drafts SET status='withdrawn',updated_at=? WHERE id=? AND status NOT IN ('published')").bind(at,mapping.publishing_edition_id));
    if(mapping.catalog_product_id)statements.push(db.prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?").bind(at,mapping.catalog_product_id));
    await db.batch(statements); return {type:"mapping",id:String(mapping.publishing_edition_id||mapping.catalog_product_id||""),message:"Partner product withdrawn."};
  }
  const contract = await activeContractVersion(db,String(submission.account_id),p.contractReference); if (!contract) throw new ApiError(409, `No active versioned retailer contract covers partner product ${p.productKey}.`); await assertPartnerProductWithinContract(db,String(contract.version.id),p);
  let titleId = mapping?.publishing_title_id ? String(mapping.publishing_title_id) : id("pubtitle"), editionId = mapping?.publishing_edition_id ? String(mapping.publishing_edition_id) : id("pubed");
  const identityKeys=await candidateWorkIdentityKeys(p);let existingIdentity:any=null;for(const candidate of identityKeys){existingIdentity=await db.prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?").bind(candidate.key).first<any>();if(existingIdentity)break;} const catalogWorkId = existingIdentity?.work_id || mapping?.catalog_work_id || null;
  const profile = await db.prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?").bind(submission.account_id).first<any>();
  const existingTitle = await db.prepare("SELECT id FROM publishing_titles WHERE id=?").bind(titleId).first<any>();
  if (!existingTitle) await db.prepare("INSERT INTO publishing_titles(id,account_id,title,subtitle,description,language,audience,publisher_name,imprint_name,series_name,series_relationship,categories_json,keywords_json,status,catalog_work_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'general',?,?,?,'main','[]','[]','draft',?,?,?)")
      .bind(titleId,submission.account_id,p.title||"Untitled",p.subtitle||"",p.description||"",p.language||"en",p.publisherName||profile?.partner_code||"",p.imprintName||"","",catalogWorkId,at,at).run();
  else await db.prepare("UPDATE publishing_titles SET title=?,subtitle=?,description=?,language=?,publisher_name=?,imprint_name=?,catalog_work_id=COALESCE(catalog_work_id,?),updated_at=? WHERE id=?")
      .bind(p.title||"Untitled",p.subtitle||"",p.description||"",p.language||"en",p.publisherName||"",p.imprintName||"",catalogWorkId,at,titleId).run();
  const territoryScope = { mode:p.territories?.mode||"worldwide", include:normalizedCountryList(p.territories?.include||[]), exclude:normalizedCountryList(p.territories?.exclude||[]), includeSetIds:[], excludeSetIds:[] };
  const existingEdition = await db.prepare("SELECT id,status,revision FROM publishing_edition_drafts WHERE id=?").bind(editionId).first<any>(); const editableStatus = existingEdition && ["submitted","approved","published"].includes(String(existingEdition.status)) ? "changes_requested" : (existingEdition?.status || "draft"); const revision = Number(existingEdition?.revision || 1) + (editableStatus === "changes_requested" ? 1 : 0);
  await db.prepare(`INSERT INTO publishing_edition_drafts(id,title_id,format,edition_label,language,isbn13,publisher_identifier,rights_basis,territory_scope_json,release_date,preorder_date,list_currency,list_price_minor,drm_requirement,downloadable,subscription_permitted,library_permitted,sales_channels_json,status,revision,edition_type,differentiation_summary,contract_id,contract_version_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET format=excluded.format,edition_label=excluded.edition_label,language=excluded.language,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,rights_basis=excluded.rights_basis,territory_scope_json=excluded.territory_scope_json,release_date=excluded.release_date,preorder_date=excluded.preorder_date,list_currency=excluded.list_currency,list_price_minor=excluded.list_price_minor,drm_requirement=excluded.drm_requirement,downloadable=excluded.downloadable,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,sales_channels_json=excluded.sales_channels_json,status=excluded.status,revision=excluded.revision,edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,updated_at=excluded.updated_at`)
    .bind(editionId,titleId,p.format||"ebook",p.editionLabel||"",p.language||"en",p.isbn13||null,p.publisherIdentifier||p.productKey,p.rightsBasis||"licensed",JSON.stringify(territoryScope),p.releaseDate||null,p.preorderDate||null,p.currency||"USD",p.priceMinor||0,p.drmRequirement||"none",p.downloadable===false?0:1,p.subscriptionPermitted?1:0,p.libraryPermitted?1:0,JSON.stringify(["retail",...(p.subscriptionPermitted?["subscription"]:[]),...(p.libraryPermitted?["library"]:[])]),editableStatus,revision,p.editionType||"original",p.differentiationSummary||"",contract?.contract.id||null,contract?.version.id||null,at,at).run();
  await db.prepare("DELETE FROM publishing_edition_contributors WHERE edition_id=?").bind(editionId).run(); for(const c of p.contributors||[]) await db.prepare("INSERT INTO publishing_edition_contributors(edition_id,display_name,role,position) VALUES(?,?,?,?)").bind(editionId,c.name,c.role,c.position).run();
  await db.prepare(`INSERT INTO publisher_catalog_mappings(account_id,environment,partner_product_key,publishing_title_id,publishing_edition_id,catalog_work_id,partner_record_reference,work_reference,original_work_title,status,source_revision,updated_at) VALUES(?,'production',?,?,?,?,?,?,?,'active',?,?)
    ON CONFLICT(account_id,environment,partner_product_key) DO UPDATE SET publishing_title_id=excluded.publishing_title_id,publishing_edition_id=excluded.publishing_edition_id,catalog_work_id=COALESCE(excluded.catalog_work_id,publisher_catalog_mappings.catalog_work_id),partner_record_reference=excluded.partner_record_reference,work_reference=excluded.work_reference,original_work_title=excluded.original_work_title,status='active',source_revision=excluded.source_revision,updated_at=excluded.updated_at`)
    .bind(submission.account_id,p.productKey,titleId,editionId,catalogWorkId,p.recordReference||"",p.workReference||"",p.originalWorkTitle||"",p.sourceRevision||"",at).run();
  if(catalogWorkId)for(const candidate of identityKeys)await db.prepare("INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(candidate.key,catalogWorkId,candidate.scheme,candidate.scheme==="external_work_reference"?1:0.82,`partner:${submission.account_id}`,at,at).run();
  return {type:"publishing_edition",id:editionId,titleId,catalogWorkId,contractId:contract?.contract.id||null,contractVersionId:contract?.version.id||null};
}


async function matchAssetExpectations(db:CatalogDB,input:{accountId:string;environment:string;productKey:string;assetKind:string;filename:string;sha256:string;sizeBytes:number;mimeType:string;assetId:string}){
  const rows=(await db.prepare("SELECT * FROM publisher_asset_expectations WHERE account_id=? AND environment=? AND partner_product_key=? AND asset_kind=? AND status IN ('waiting','mismatch') ORDER BY created_at").bind(input.accountId,input.environment,input.productKey,input.assetKind).all<any>()).results;let matched=0,mismatched=0;const at=now();
  for(const row of rows){const checksum=String(row.expected_sha256).toLowerCase()===input.sha256.toLowerCase(),size=row.expected_size_bytes==null||Number(row.expected_size_bytes)===input.sizeBytes,mime=!row.expected_mime_type||String(row.expected_mime_type).toLowerCase()===input.mimeType.toLowerCase();if(checksum&&size&&mime){await db.prepare("UPDATE publisher_asset_expectations SET status='matched',matched_asset_id=?,validation_json='[]',matched_at=? WHERE id=?").bind(input.assetId,at,row.id).run();matched++;}else if(String(row.source_filename)===input.filename||checksum){await db.prepare("UPDATE publisher_asset_expectations SET status='mismatch',matched_asset_id=?,validation_json=? WHERE id=?").bind(input.assetId,JSON.stringify([{severity:"error",code:"ASSET_BINARY_MISMATCH",message:!checksum?"Uploaded asset checksum does not match the manifest.":!size?"Uploaded asset size does not match the manifest.":"Uploaded asset MIME type does not match the manifest."}]),row.id).run();mismatched++;}}
  if(matched)await db.prepare("UPDATE publisher_feed_assets SET status='accepted',updated_at=? WHERE id=?").bind(at,input.assetId).run();
  return{matched,mismatched};
}

async function applyAssetManifestItem(db: CatalogDB, submission: any, p: PartnerProduct) {
  if (!p.assetKind || !p.filename || !p.sha256 || p.sizeBytes == null) throw new ApiError(400, "Asset manifest item is incomplete.");
  if (submission.environment === "production") {
    const mapping = await db.prepare("SELECT publishing_edition_id FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=? AND status='active'").bind(submission.account_id,p.productKey).first<any>();
    if (!mapping?.publishing_edition_id) throw new ApiError(409, `No production catalog mapping exists for ${p.productKey}. Submit metadata before the asset manifest.`);
  }
  const at = now();
  const existing = await db.prepare(`SELECT * FROM publisher_feed_assets WHERE account_id=? AND environment=? AND partner_product_key=? AND asset_kind=? AND (lower(sha256)=lower(?) OR source_filename=?) ORDER BY CASE WHEN lower(sha256)=lower(?) THEN 0 ELSE 1 END, created_at DESC LIMIT 1`)
    .bind(submission.account_id,submission.environment,p.productKey,p.assetKind,p.sha256,p.filename,p.sha256).first<any>();
  let status = "waiting", matchedAssetId: string | null = null, matchedAt: string | null = null, validation: any[] = [];
  if (existing) {
    const checksum = String(existing.sha256||"").toLowerCase() === p.sha256.toLowerCase();
    const size = Number(existing.size_bytes) === Number(p.sizeBytes);
    const mime = !p.mimeType || !existing.mime_type || String(existing.mime_type).toLowerCase() === String(p.mimeType).toLowerCase();
    matchedAssetId = String(existing.id);
    if (checksum && size && mime) { status = "matched"; matchedAt = at; await db.prepare("UPDATE publisher_feed_assets SET status='accepted',updated_at=? WHERE id=?").bind(at,existing.id).run(); }
    else { status = "mismatch"; validation = [{severity:"error",code:"ASSET_BINARY_MISMATCH",message:!checksum?"Existing asset checksum does not match the manifest.":!size?"Existing asset size does not match the manifest.":"Existing asset MIME type does not match the manifest."}]; }
  }
  const expectationId = id("pasexp");
  await db.prepare(`INSERT INTO publisher_asset_expectations(id,submission_id,account_id,environment,partner_product_key,asset_kind,source_filename,expected_mime_type,expected_size_bytes,expected_sha256,status,matched_asset_id,validation_json,created_at,matched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(expectationId,submission.id,submission.account_id,submission.environment,p.productKey,p.assetKind,p.filename,p.mimeType||"",p.sizeBytes,p.sha256,status,matchedAssetId,JSON.stringify(validation),at,matchedAt).run();
  return { type:"asset_expectation", id:expectationId, status, matchedAssetId };
}

async function applyDeltaItem(db: CatalogDB, submission: any, p: PartnerProduct) {
  const mapping=await db.prepare("SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(submission.account_id,p.productKey).first<any>(); if(!mapping?.publishing_edition_id)throw new ApiError(409,`No production catalog mapping exists for ${p.productKey}. Submit metadata before ${submission.feed_type} deltas.`);
  const editionId=String(mapping.publishing_edition_id),at=now(),draft=await db.prepare("SELECT * FROM publishing_edition_drafts WHERE id=?").bind(editionId).first<any>();if(!draft)throw new ApiError(409,"Mapped publishing edition no longer exists.");
  if(submission.feed_type==="price"){
    if(p.priceMinor==null)throw new ApiError(400,"Price delta is missing priceMinor.");
    await db.prepare("UPDATE publishing_edition_drafts SET list_currency=?,list_price_minor=?,updated_at=? WHERE id=?").bind(p.currency||draft.list_currency||"USD",p.priceMinor,at,editionId).run();
    if(mapping.catalog_product_id){const prior=await db.prepare("SELECT id FROM offers WHERE product_id=? AND offer_type='purchase' AND active=1 ORDER BY created_at DESC LIMIT 1").bind(mapping.catalog_product_id).first<any>();const offerId=id("offer");const statements:any[]=[];if(prior)statements.push(db.prepare("UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE id=?").bind(at,at,prior.id));statements.push(db.prepare("INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'purchase',?,?,1,?,NULL,?,?)").bind(offerId,mapping.catalog_product_id,p.currency||draft.list_currency||"USD",p.priceMinor,at,at,at));await db.batch(statements);return{type:"price_offer",id:offerId};}
  } else if(submission.feed_type==="territory"){
    if(!p.territories)throw new ApiError(400,"Territory delta is missing territory scope.");
    const contract=await activeContractVersion(db,String(submission.account_id),p.contractReference||draft.contract_id||"");if(draft.rights_basis!=="public_domain"&&!contract)throw new ApiError(409,"No effective assigned contract version is available for this territory update.");
    if(contract)await assertPartnerProductWithinContract(db,String(contract.version.id),{...p,format:draft.format,drmRequirement:draft.drm_requirement,subscriptionPermitted:!!draft.subscription_permitted,libraryPermitted:!!draft.library_permitted});
    const scope={mode:p.territories.mode||"worldwide",include:normalizedCountryList(p.territories.include||[]),exclude:normalizedCountryList(p.territories.exclude||[]),includeSetIds:[],excludeSetIds:[]};await db.prepare("UPDATE publishing_edition_drafts SET territory_scope_json=?,contract_id=COALESCE(?,contract_id),contract_version_id=COALESCE(?,contract_version_id),updated_at=? WHERE id=?").bind(JSON.stringify(scope),contract?.contract.id||null,contract?.version.id||null,at,editionId).run();
    if(mapping.catalog_edition_id){const grants=(await db.prepare("SELECT * FROM rights_grants WHERE edition_id=? AND status='active'").bind(mapping.catalog_edition_id).all<any>()).results;for(const grant of grants){await upsertRightsGrant(db as any,{id:String(grant.id),editionId:String(mapping.catalog_edition_id),rightsholderId:grant.rightsholder_id||null,rightsholderPartyId:grant.rightsholder_party_id||null,scopeMode:scope.mode==="worldwide"?"worldwide":"expression",includeTerritories:scope.include,excludeTerritories:scope.exclude,format:String(grant.format),salesChannel:String(grant.sales_channel) as any,startsAt:grant.starts_at||null,endsAt:grant.ends_at||null,licenseType:String(grant.license_type),contractId:contract?.contract.id||grant.contract_id||null,contractVersionId:contract?.version.id||grant.contract_version_id||null,exclusivity:(grant.exclusivity||"nonexclusive") as any,drmRequirement:String(grant.drm_requirement||"none"),subscriptionPermitted:!!grant.subscription_permitted,libraryPermitted:!!grant.library_permitted,decision:"allow",status:"active",promotionRestrictions:parseJson(grant.promotion_restrictions_json,{}),contractReference:String(grant.contract_reference||""),source:"publisher-territory-feed",notes:`Updated by partner feed ${submission.id}`});}}
    return{type:"territory_rights",id:editionId};
  } else if(submission.feed_type==="availability") {
    if(!p.availability)throw new ApiError(400,"Availability delta is missing availability.");
    if(p.availability==="withdrawn")await db.prepare("UPDATE publishing_edition_drafts SET status='withdrawn',updated_at=? WHERE id=?").bind(at,editionId).run();
    if(mapping.catalog_product_id){const storefront=p.availability==="available"||p.availability==="preorder"?"active":"inactive";await db.prepare("UPDATE products SET storefront_status=?,updated_at=? WHERE id=?").bind(storefront,at,mapping.catalog_product_id).run();if(p.availability==="withdrawn")await db.prepare("UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE product_id=? AND active=1").bind(at,at,mapping.catalog_product_id).run();else if(storefront==="active")await db.prepare("UPDATE offers SET active=1,updated_at=? WHERE id=(SELECT id FROM offers WHERE product_id=? AND offer_type='purchase' ORDER BY created_at DESC LIMIT 1)").bind(at,mapping.catalog_product_id).run();}
    await db.prepare("UPDATE publisher_catalog_mappings SET status=?,updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(p.availability==="withdrawn"?"withdrawn":"active",at,submission.account_id,p.productKey).run();
    return{type:"availability",id:editionId};
  }
  throw new ApiError(400,`Unsupported delta feed type ${submission.feed_type}.`);
}

async function reconcileFullPartnerSnapshot(db: CatalogDB, submission: any) {
  if(submission.environment!=="production"||submission.feed_type!=="metadata"||submission.mode!=="full"||!Number(submission.replace_missing)) return 0;
  const missing=(await db.prepare(`SELECT m.partner_product_key,m.catalog_product_id FROM publisher_catalog_mappings m WHERE m.account_id=? AND m.environment='production' AND m.status='active' AND NOT EXISTS(SELECT 1 FROM publisher_feed_items i WHERE i.submission_id=? AND i.partner_product_key=m.partner_product_key AND i.status IN ('applied','warning','valid'))`).bind(submission.account_id,submission.id).all<any>()).results;
  const at=now();
  for(const row of missing){const statements:any[]=[db.prepare("UPDATE publisher_catalog_mappings SET status='withdrawn',updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(at,submission.account_id,row.partner_product_key)];if(row.catalog_product_id){statements.push(db.prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?").bind(at,row.catalog_product_id));statements.push(db.prepare("UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE product_id=? AND active=1").bind(at,at,row.catalog_product_id));}await db.batch(statements);}
  return missing.length;
}

export async function processPartnerFeedQueue(db: CatalogDB, limit = 25) {
  const rows=(await db.prepare("SELECT * FROM publisher_feed_submissions WHERE status IN ('accepted','accepted_with_warnings') ORDER BY received_at LIMIT ?").bind(Math.max(1,Math.min(100,limit))).all<any>()).results; let applied=0,failed=0,sandbox=0;
  for(const submission of rows){
    await db.prepare("UPDATE publisher_feed_submissions SET status='applying' WHERE id=? AND status IN ('accepted','accepted_with_warnings')").bind(submission.id).run(); const items=(await db.prepare("SELECT * FROM publisher_feed_items WHERE submission_id=? AND status IN ('valid','warning') ORDER BY ordinal").bind(submission.id).all<any>()).results; let ok=0,bad=0;
    if(submission.environment==="sandbox" && submission.feed_type!=="assets_manifest"){
      for(const item of items)await db.prepare("UPDATE publisher_feed_items SET status='applied',applied_entity_type='sandbox_preview',applied_entity_id=?,updated_at=? WHERE id=?").bind(item.partner_product_key,now(),item.id).run(); ok=items.length;sandbox++;
    } else {
      for(const item of items){
        const p=parseJson<PartnerProduct>(item.normalized_json,{productKey:item.partner_product_key,notificationType:"update"});
        try{const result=submission.feed_type==="metadata"?await applyMetadataItem(db,submission,item,p):submission.feed_type==="assets_manifest"?await applyAssetManifestItem(db,submission,p):await applyDeltaItem(db,submission,p);await db.prepare("UPDATE publisher_feed_items SET status=?,applied_entity_type=?,applied_entity_id=?,updated_at=? WHERE id=?").bind(result.skipped?"skipped":"applied",result.type,result.id||"",now(),item.id).run();ok++;}
        catch(e){bad++;await db.prepare("UPDATE publisher_feed_items SET status='rejected',validation_json=?,updated_at=? WHERE id=?").bind(JSON.stringify([{severity:"error",code:"APPLICATION_FAILED",message:e instanceof Error?e.message:"Application failed."}]),now(),item.id).run();}
      }
    }
    const withdrawnMissing=bad===0?await reconcileFullPartnerSnapshot(db,submission):0;const finalStatus=bad===0?"applied":ok>0?"partially_applied":"failed",at=now();await db.prepare("UPDATE publisher_feed_submissions SET status=?,applied_count=?,rejected_count=rejected_count+?,error_summary=?,applied_at=? WHERE id=?").bind(finalStatus,ok,bad,bad?`${bad} item(s) failed during application.`:"",at,submission.id).run();await db.prepare("INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id("pack"),submission.id,"application",finalStatus,finalStatus==="applied"?"FEED_APPLIED":"FEED_PARTIAL_OR_FAILED",finalStatus==="applied"?"Feed applied successfully.":"Feed application completed with item failures.",JSON.stringify({appliedCount:ok,failedCount:bad,withdrawnMissing,environment:submission.environment}),"pending",at).run();await partnerAudit(db,{accountId:submission.account_id,environment:submission.environment,actorType:"worker",actorId:"partner-ingest",eventType:"partner.feed.applied",subjectType:"feed",subjectId:submission.id,event:{status:finalStatus,appliedCount:ok,failedCount:bad,withdrawnMissing}});if(bad)failed++;else applied++;
  }
  return{leased:rows.length,applied,failed,sandbox};
}

export async function revealPartnerWebhookSecret(env: CoveEnv, userId: string, accountId: string) {
  await requirePartnerRole(env.DB as CatalogDB, userId, accountId, "admin");
  const profile = await env.DB.prepare("SELECT partner_code FROM publisher_partner_profiles WHERE account_id=?").bind(accountId).first<any>();
  if (!profile) throw new ApiError(404, "Partner integration profile not found.");
  const secret = await derivedPartnerWebhookSecret(env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "", accountId);
  await partnerAudit(env.DB as CatalogDB, { accountId, actorType: "user", actorId: userId, eventType: "partner.webhook_secret.revealed", subjectType: "partner", subjectId: accountId, event: { partnerCode: profile.partner_code || "" } });
  return { accountId, partnerCode: profile.partner_code || "", algorithm: "HMAC-SHA256", secret, signatureHeader: "X-Cove-Signature", timestampHeader: "X-Cove-Timestamp" };
}

function callbackRetryAt(attempts: number) {
  const minutes = Math.min(360, Math.max(1, 2 ** Math.min(8, attempts)) * 2);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function postPartnerAcknowledgement(url: string, payload: string, input: { secret: string; responseId: string }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = bytesToBase64Url(await hmacSha256(input.secret, `${timestamp}.${payload}`));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Cove-Partner-Acknowledgements/1.0",
        "X-Cove-Signature": `v1=${signature}`,
        "X-Cove-Timestamp": timestamp,
        "X-Cove-Event-Id": input.responseId,
        "Idempotency-Key": input.responseId,
      },
      body: payload,
    });
    if (!response.ok) throw new Error(`Partner callback returned HTTP ${response.status}.`);
    return { status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverPartnerValidationResponses(env: CoveEnv, limit = 50) {
  const db = env.DB as CatalogDB;
  const at = now();
  const rows = (await db.prepare(`SELECT r.*,s.account_id,s.environment,s.external_feed_id,s.feed_type,s.mode,s.status submission_status,s.source_sha256,
      p.partner_code,p.acknowledgements_url,p.webhook_url
    FROM publisher_validation_responses r
    JOIN publisher_feed_submissions s ON s.id=r.submission_id
    LEFT JOIN publisher_partner_profiles p ON p.account_id=s.account_id
    WHERE r.delivery_status IN ('pending','failed') AND r.attempts<8 AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?)
    ORDER BY r.created_at,r.id LIMIT ?`).bind(at, Math.max(1, Math.min(200, limit))).all<any>()).results;
  let delivered = 0, failed = 0, notConfigured = 0;
  for (const row of rows) {
    let destination = clean(row.destination_url || row.acknowledgements_url || row.webhook_url, 2000);
    const attempts = Number(row.attempts || 0) + 1;
    if (!destination) {
      await db.prepare("UPDATE publisher_validation_responses SET delivery_status='not_configured',attempts=?,last_attempt_at=?,last_error='No acknowledgement callback URL is configured.',next_attempt_at=NULL WHERE id=?")
        .bind(attempts, at, row.id).run();
      notConfigured++;
      continue;
    }
    try {
      destination = safePartnerCallbackUrl(destination);
      const secret = await derivedPartnerWebhookSecret(env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "", String(row.account_id));
      const payloadObject = {
        schemaVersion: "fore.partner.ack.v1",
        eventId: String(row.id),
        eventType: `partner.feed.${String(row.response_type)}`,
        createdAt: String(row.created_at),
        partner: { accountId: String(row.account_id), partnerCode: String(row.partner_code || ""), environment: String(row.environment) },
        submission: {
          id: String(row.submission_id), externalFeedId: String(row.external_feed_id || ""), feedType: String(row.feed_type), mode: String(row.mode),
          status: String(row.submission_status), sourceSha256: String(row.source_sha256 || ""),
        },
        response: { type: String(row.response_type), status: String(row.status), code: String(row.machine_code), message: String(row.message), payload: parseJson(row.payload_json, {}) },
      };
      const payload = JSON.stringify(payloadObject);
      const payloadSha = await sha256(payload);
      await db.prepare("UPDATE publisher_validation_responses SET destination_url=?,payload_sha256=?,attempts=?,last_attempt_at=?,last_error='',next_attempt_at=NULL WHERE id=?")
        .bind(destination, payloadSha, attempts, at, row.id).run();
      const result = await postPartnerAcknowledgement(destination, payload, { secret, responseId: String(row.id) });
      const deliveredAt = now();
      await db.prepare("UPDATE publisher_validation_responses SET delivery_status='delivered',delivered_at=?,last_error='',next_attempt_at=NULL WHERE id=?")
        .bind(deliveredAt, row.id).run();
      await partnerAudit(db, { accountId: String(row.account_id), environment: String(row.environment), actorType: "worker", actorId: "partner-ack", eventType: "partner.ack.delivered", subjectType: "validation_response", subjectId: String(row.id), event: { destination, httpStatus: result.status, attempts, payloadSha256: payloadSha } });
      delivered++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Partner acknowledgement delivery failed.").slice(0, 2000);
      const terminal = attempts >= 8;
      await db.prepare("UPDATE publisher_validation_responses SET delivery_status='failed',attempts=?,last_attempt_at=?,last_error=?,next_attempt_at=? WHERE id=?")
        .bind(attempts, at, message, terminal ? null : callbackRetryAt(attempts), row.id).run();
      await partnerAudit(db, { accountId: String(row.account_id), environment: String(row.environment), actorType: "worker", actorId: "partner-ack", eventType: "partner.ack.failed", subjectType: "validation_response", subjectId: String(row.id), event: { destination, attempts, terminal, error: message } });
      failed++;
    }
  }
  return { leased: rows.length, delivered, failed, notConfigured };
}

export async function partnerFeedAcknowledgement(db: CatalogDB, principal: PartnerPrincipal, submissionId: string) {
  const submission=await db.prepare("SELECT * FROM publisher_feed_submissions WHERE id=? AND account_id=? AND environment=?").bind(submissionId,principal.accountId,principal.environment).first<any>();if(!submission)throw new ApiError(404,"Feed submission not found."); const items=(await db.prepare("SELECT ordinal,partner_product_key,notification_type,status,validation_json,applied_entity_type,applied_entity_id FROM publisher_feed_items WHERE submission_id=? ORDER BY ordinal LIMIT 10000").bind(submissionId).all<any>()).results;const responses=(await db.prepare("SELECT id,response_type,status,machine_code,message,payload_json,delivery_status,attempts,destination_url,payload_sha256,last_attempt_at,next_attempt_at,last_error,created_at,delivered_at FROM publisher_validation_responses WHERE submission_id=? ORDER BY created_at").bind(submissionId).all<any>()).results;return{submission,items:items.map(i=>({...i,validation:parseJson(i.validation_json,[])})),responses:responses.map(r=>({...r,payload:parseJson(r.payload_json,{})}))};
}

export async function uploadPartnerAsset(env: CoveEnv, request: Request, principal: PartnerPrincipal) {
  const productKey=clean(request.headers.get("x-fore-product-key"),300);
  const assetKind=z.enum(["epub","cover","audio","sample","supplement"]).parse(clean(request.headers.get("x-fore-asset-kind"),30));
  const filename=clean(request.headers.get("x-fore-filename"),240)||`asset.${assetKind==="epub"?"epub":assetKind==="cover"?"jpg":"bin"}`;
  const mime=clean(request.headers.get("content-type"),120)||"application/octet-stream";
  if(!productKey)throw new ApiError(400,"X-Cove-Product-Key is required.");
  const uploadLimit=assetKind==="audio"?750*1024*1024:assetKind==="epub"?150*1024*1024:25*1024*1024;
  const bytes=await readBounded(request,uploadLimit),digest=await sha256(bytes),assetId=id("pfasset"),at=now();

  if(principal.environment==="sandbox"){
    const known=await env.DB.prepare(`SELECT 1 ok FROM publisher_feed_items i JOIN publisher_feed_submissions s ON s.id=i.submission_id WHERE s.account_id=? AND s.environment='sandbox' AND s.feed_type='metadata' AND i.partner_product_key=? AND i.status IN ('valid','warning','applied') LIMIT 1`).bind(principal.accountId,productKey).first<any>();
    if(!known)throw new ApiError(409,"Submit sandbox metadata before uploading assets for this product key.");
    if(!env.BUCKET)throw new ApiError(503,"Partner sandbox asset storage is not configured.");
    const objectKey=`partner-ingest/sandbox/${principal.accountId}/assets/${assetId}/${filename.replace(/[^A-Za-z0-9._-]/g,"_")}`;
    await env.BUCKET.put(objectKey,bytes,{httpMetadata:{contentType:mime},customMetadata:{sha256:digest,environment:"sandbox",productKey}});
    await env.DB.prepare("INSERT INTO publisher_feed_assets(id,account_id,environment,partner_product_key,asset_kind,source_filename,mime_type,object_key,size_bytes,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'quarantined',?,?)").bind(assetId,principal.accountId,principal.environment,productKey,assetKind,filename,mime,objectKey,bytes.byteLength,digest,at,at).run();
    const expectationMatch=await matchAssetExpectations(env.DB,{accountId:principal.accountId,environment:principal.environment,productKey,assetKind,filename,sha256:digest,sizeBytes:bytes.byteLength,mimeType:mime,assetId});
    await partnerAudit(env.DB,{accountId:principal.accountId,environment:principal.environment,actorType:"credential",actorId:principal.credentialId,eventType:"partner.asset.uploaded",subjectType:"asset",subjectId:assetId,event:{productKey,assetKind,sha256:digest,sizeBytes:bytes.byteLength,expectationMatch}});
    return{id:assetId,environment:"sandbox",sha256:digest,sizeBytes:bytes.byteLength,status:expectationMatch.matched?"accepted":"quarantined",expectationMatch};
  }

  const mapping=await env.DB.prepare("SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?").bind(principal.accountId,productKey).first<any>();
  if(!mapping?.publishing_edition_id)throw new ApiError(409,"Submit and apply partner metadata before uploading assets for this product key.");
  const kind=assetKind==="epub"?"manuscript":assetKind,limit=publishingUploadLimit(kind);
  if(bytes.byteLength>limit)throw new ApiError(413,`${assetKind} exceeds the publishing upload limit.`);
  const result=await uploadPublishingAsset(env,principal.actorUserId,{editionId:String(mapping.publishing_edition_id),kind,filename,mimeType:mime,bytes});
  const row=await env.DB.prepare("SELECT object_key,size_bytes FROM publishing_asset_versions WHERE id=?").bind(result.versionId).first<any>();
  await env.DB.prepare("INSERT INTO publisher_feed_assets(id,account_id,environment,partner_product_key,asset_kind,source_filename,mime_type,object_key,size_bytes,sha256,status,linked_publishing_asset_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'linked',?,?,?)").bind(assetId,principal.accountId,principal.environment,productKey,assetKind,filename,mime,row?.object_key||"",Number(row?.size_bytes||bytes.byteLength),result.sha256,result.versionId,at,at).run();
  const expectationMatch=await matchAssetExpectations(env.DB,{accountId:principal.accountId,environment:principal.environment,productKey,assetKind,filename,sha256:result.sha256,sizeBytes:Number(row?.size_bytes||bytes.byteLength),mimeType:mime,assetId});
  await partnerAudit(env.DB,{accountId:principal.accountId,environment:principal.environment,actorType:"credential",actorId:principal.credentialId,eventType:"partner.asset.uploaded",subjectType:"asset",subjectId:assetId,event:{productKey,assetKind,sha256:result.sha256,versionId:result.versionId,expectationMatch}});
  return{id:assetId,environment:"production",...result,expectationMatch};
}

export async function uploadPartnerAssetBatch(env: CoveEnv, request: Request, principal: PartnerPrincipal) {
  const bytes=await readBounded(request,250*1024*1024),zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
  const manifestEntry=zip.file("manifest.json");
  if(!manifestEntry)throw new ApiError(400,"Bulk asset archives require manifest.json at the archive root.");
  let manifest:any;try{manifest=JSON.parse(await manifestEntry.async("text"));}catch{throw new ApiError(400,"Bulk asset manifest.json is not valid JSON.");}
  const entries=z.array(z.object({productKey:z.string().trim().min(1).max(300),kind:z.enum(["epub","cover"]),path:z.string().min(1).max(500),filename:z.string().max(240).optional(),mimeType:z.string().max(120).optional(),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).optional()})).min(1).max(500).parse(manifest?.assets);
  if(Object.keys(zip.files).length>1001)throw new ApiError(413,"Bulk asset archive contains too many files.");
  const duplicateKeys=new Set<string>(),duplicatePaths=new Set<string>();
  for(const entry of entries){const key=`${entry.productKey}\0${entry.kind}`;if(duplicateKeys.has(key))throw new ApiError(400,`Bulk manifest contains duplicate ${entry.kind} entries for ${entry.productKey}.`);duplicateKeys.add(key);if(duplicatePaths.has(entry.path))throw new ApiError(400,`Bulk manifest reuses archive path ${entry.path}.`);duplicatePaths.add(entry.path);}
  const results:any[]=[];let accepted=0,rejected=0,totalExtracted=0;
  for(const entry of entries){
    try{
      if(entry.path.startsWith("/")||entry.path.includes("\\")||entry.path.split("/").includes(".."))throw new ApiError(400,"Asset paths may not escape the archive root.");
      const file=zip.file(entry.path);if(!file||file.dir)throw new ApiError(400,`Archive asset ${entry.path} was not found.`);
      const assetBytes=await file.async("uint8array");totalExtracted+=assetBytes.byteLength;if(totalExtracted>300*1024*1024)throw new ApiError(413,"Bulk asset archive expands beyond Cove's 300 MiB safety limit.");
      const max=publishingUploadLimit(entry.kind==="epub"?"manuscript":"cover");if(assetBytes.byteLength>max)throw new ApiError(413,`${entry.path} exceeds the ${entry.kind} upload limit.`);
      if(entry.sha256&&await sha256(assetBytes)!==entry.sha256.toLowerCase())throw new ApiError(409,`${entry.path} checksum does not match manifest.json.`);
      const mime=entry.mimeType||(entry.kind==="epub"?"application/epub+zip":/\.png$/i.test(entry.path)?"image/png":"image/jpeg"),filename=entry.filename||entry.path.split("/").pop()||`asset.${entry.kind==="epub"?"epub":"jpg"}`;
      const internal=new Request("https://fore.internal/partner-asset",{method:"POST",headers:{"x-fore-product-key":entry.productKey,"x-fore-asset-kind":entry.kind,"x-fore-filename":filename,"content-type":mime},body:assetBytes});
      const out=await uploadPartnerAsset(env,internal,principal);results.push({productKey:entry.productKey,path:entry.path,status:"accepted",asset:out});accepted++;
    }catch(e){results.push({productKey:entry.productKey,path:entry.path,status:"rejected",error:e instanceof Error?e.message:"Asset ingestion failed."});rejected++;}
  }
  await partnerAudit(env.DB,{accountId:principal.accountId,environment:principal.environment,actorType:"credential",actorId:principal.credentialId,eventType:"partner.assets.batch",subjectType:"asset_batch",subjectId:id("assetbatch"),event:{accepted,rejected,itemCount:entries.length,totalExtracted}});
  return{environment:principal.environment,itemCount:entries.length,acceptedCount:accepted,rejectedCount:rejected,results};
}

export async function partnerDashboard(db: CatalogDB, userId: string, accountId: string) {
  await requirePartnerRole(db,userId,accountId,"analyst"); const [profile,credentials,channels,feeds,mappings,assets,expectations,responses,contracts,audit]=await Promise.all([
    db.prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?").bind(accountId).first<any>(),
    db.prepare("SELECT id,account_id,environment,label,key_prefix,scopes_json,ip_allowlist_json,status,last_used_at,expires_at,created_at,revoked_at FROM publisher_partner_credentials WHERE account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId).all<any>(),
    db.prepare("SELECT * FROM publisher_ingestion_channels WHERE account_id=? ORDER BY environment,label").bind(accountId).all<any>(),
    db.prepare("SELECT * FROM publisher_feed_submissions WHERE account_id=? ORDER BY received_at DESC LIMIT 100").bind(accountId).all<any>(),
    db.prepare("SELECT * FROM publisher_catalog_mappings WHERE account_id=? ORDER BY updated_at DESC LIMIT 200").bind(accountId).all<any>(),
    db.prepare("SELECT id,environment,partner_product_key,asset_kind,source_filename,mime_type,size_bytes,sha256,status,linked_publishing_asset_version_id,created_at,updated_at FROM publisher_feed_assets WHERE account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId).all<any>(),
    db.prepare("SELECT id,submission_id,environment,partner_product_key,asset_kind,source_filename,expected_mime_type,expected_size_bytes,expected_sha256,status,matched_asset_id,validation_json,created_at,matched_at FROM publisher_asset_expectations WHERE account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId).all<any>(),
    db.prepare(`SELECT r.id,r.submission_id,r.response_type,r.status,r.machine_code,r.message,r.delivery_status,r.attempts,r.destination_url,r.payload_sha256,r.last_attempt_at,r.next_attempt_at,r.last_error,r.created_at,r.delivered_at FROM publisher_validation_responses r JOIN publisher_feed_submissions s ON s.id=r.submission_id WHERE s.account_id=? ORDER BY r.created_at DESC LIMIT 200`).bind(accountId).all<any>(),
    db.prepare(`SELECT a.*,rc.reference_code,rc.name,rc.status contract_status,rcv.id active_version_id,rcv.version_number,rcv.effective_from,rcv.effective_to,rcv.retailer_commission_bps,rcv.post_termination_access_policy FROM publisher_contract_assignments a JOIN rights_contracts rc ON rc.id=a.contract_id LEFT JOIN rights_contract_versions rcv ON rcv.contract_id=rc.id AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) WHERE a.account_id=? ORDER BY rc.reference_code`).bind(now(),now(),accountId).all<any>(),
    db.prepare("SELECT * FROM publisher_partner_audit_events WHERE account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId).all<any>(),
  ]);return{profile:profile||null,credentials:credentials.results.map((r:any)=>({...r,scopes:parseJson(r.scopes_json,[]),ipAllowlist:parseJson(r.ip_allowlist_json,[])})),channels:channels.results.map((r:any)=>({...r,config:parseJson(r.config_json,{})})),feeds:feeds.results,mappings:mappings.results,assets:assets.results,expectations:expectations.results.map((r:any)=>({...r,validation:parseJson(r.validation_json,[])})),responses:responses.results,contracts:contracts.results,audit:audit.results};
}

const contractVersionSchema=z.object({contractId:z.string().min(1),versionNumber:z.number().int().min(1),status:z.enum(["draft","active","superseded","terminated"]).default("draft"),effectiveFrom:z.string().datetime(),effectiveTo:z.string().datetime().nullable().optional(),retailerCommissionBps:z.number().int().min(0).max(10000),paymentSchedule:z.object({cadence:z.enum(["monthly","quarterly"]),netDays:z.number().int().min(0).max(180),currency:z.string().regex(/^[A-Z]{3}$/).optional(),minimumPayoutMinor:z.number().int().min(0).optional()}).passthrough(),returnsPolicy:z.record(z.string(),z.unknown()).default({}),subscriptionTerms:z.record(z.string(),z.unknown()).default({permitted:false}),marketingPermissions:z.record(z.string(),z.unknown()).default({}),drmRequirements:z.record(z.string(),z.unknown()).default({}),deliveryRules:z.record(z.string(),z.unknown()).default({}),terminationPolicy:z.record(z.string(),z.unknown()).default({}),postTerminationAccessPolicy:z.enum(["preserve_perpetual_purchases","preserve_downloaded_only","block_future_downloads","revoke_all"]).default("preserve_perpetual_purchases"),documentSha256:z.string().regex(/^[a-f0-9]{64}$/i).or(z.literal("")).default(""),sourceDocumentObjectKey:z.string().max(500).nullable().optional(),territories:z.array(z.object({territoryCode:z.string().regex(/^[A-Z]{2}$/),decision:z.enum(["allow","deny"]).default("allow")})).min(1).max(300),formats:z.array(z.object({format:z.string().min(1).max(40),decision:z.enum(["allow","deny"]).default("allow"),drmRequirement:z.string().max(80).default("none"),downloadLimit:z.number().int().min(0).nullable().optional(),deviceLimit:z.number().int().min(0).nullable().optional(),offlinePermitted:z.boolean().default(true)})).min(1).max(20),channels:z.array(z.object({salesChannel:z.enum(["retail","subscription","library"]),permitted:z.boolean(),terms:z.record(z.string(),z.unknown()).default({})})).min(1).max(3)});

export async function saveContractVersion(db:CatalogDB,actorUserId:string,raw:unknown){const x=contractVersionSchema.parse(raw);const contract=await db.prepare("SELECT * FROM rights_contracts WHERE id=?").bind(x.contractId).first<any>();if(!contract)throw new ApiError(404,"Rights contract not found.");if(x.effectiveTo&&x.effectiveTo<=x.effectiveFrom)throw new ApiError(400,"Contract version end date must follow its effective date.");const existing=await db.prepare("SELECT * FROM rights_contract_versions WHERE contract_id=? AND version_number=?").bind(x.contractId,x.versionNumber).first<any>();if(existing&&existing.status!=="draft")throw new ApiError(409,"Activated contract versions are immutable. Create a new version instead.");if(x.status==="active"){const futureConflict=await db.prepare("SELECT id FROM rights_contract_versions WHERE contract_id=? AND status='active' AND id<>COALESCE(?, '') AND effective_from>=? AND (? IS NULL OR effective_from<?) LIMIT 1").bind(x.contractId,existing?.id||null,x.effectiveFrom,x.effectiveTo||null,x.effectiveTo||"9999").first<any>();if(futureConflict)throw new ApiError(409,"This contract already has an active version beginning inside the proposed effective window.");}
  const versionId=existing?.id||id("rcontractv"),at=now(),approvedAt=x.status==="active"?at:null;const statements:any[]=[db.prepare(`INSERT INTO rights_contract_versions(id,contract_id,version_number,status,effective_from,effective_to,retailer_commission_bps,payment_schedule_json,returns_policy_json,subscription_terms_json,marketing_permissions_json,drm_requirements_json,delivery_rules_json,termination_policy_json,post_termination_access_policy,document_sha256,source_document_object_key,approved_by_user_id,approved_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,effective_from=excluded.effective_from,effective_to=excluded.effective_to,retailer_commission_bps=excluded.retailer_commission_bps,payment_schedule_json=excluded.payment_schedule_json,returns_policy_json=excluded.returns_policy_json,subscription_terms_json=excluded.subscription_terms_json,marketing_permissions_json=excluded.marketing_permissions_json,drm_requirements_json=excluded.drm_requirements_json,delivery_rules_json=excluded.delivery_rules_json,termination_policy_json=excluded.termination_policy_json,post_termination_access_policy=excluded.post_termination_access_policy,document_sha256=excluded.document_sha256,source_document_object_key=excluded.source_document_object_key,approved_by_user_id=excluded.approved_by_user_id,approved_at=excluded.approved_at`).bind(versionId,x.contractId,x.versionNumber,"draft",x.effectiveFrom,x.effectiveTo||null,x.retailerCommissionBps,JSON.stringify(x.paymentSchedule),JSON.stringify(x.returnsPolicy),JSON.stringify(x.subscriptionTerms),JSON.stringify(x.marketingPermissions),JSON.stringify(x.drmRequirements),JSON.stringify(x.deliveryRules),JSON.stringify(x.terminationPolicy),x.postTerminationAccessPolicy,x.documentSha256,x.sourceDocumentObjectKey||null,null,null,existing?.created_at||at),db.prepare("DELETE FROM rights_contract_version_territories WHERE contract_version_id=?").bind(versionId),db.prepare("DELETE FROM rights_contract_version_formats WHERE contract_version_id=?").bind(versionId),db.prepare("DELETE FROM rights_contract_version_channels WHERE contract_version_id=?").bind(versionId)];for(const t of x.territories)statements.push(db.prepare("INSERT INTO rights_contract_version_territories(contract_version_id,territory_code,decision) VALUES(?,?,?)").bind(versionId,t.territoryCode,t.decision));for(const f of x.formats)statements.push(db.prepare("INSERT INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,download_limit,device_limit,offline_permitted) VALUES(?,?,?,?,?,?,?)").bind(versionId,f.format,f.decision,f.drmRequirement,f.downloadLimit??null,f.deviceLimit??null,f.offlinePermitted?1:0));for(const c of x.channels)statements.push(db.prepare("INSERT INTO rights_contract_version_channels(contract_version_id,sales_channel,permitted,terms_json) VALUES(?,?,?,?)").bind(versionId,c.salesChannel,c.permitted?1:0,JSON.stringify(c.terms)));if(x.status==="active")statements.push(db.prepare("UPDATE rights_contract_versions SET status='superseded',effective_to=CASE WHEN effective_to IS NULL OR effective_to>? THEN ? ELSE effective_to END WHERE contract_id=? AND id<>? AND status='active' AND effective_from<?").bind(x.effectiveFrom,x.effectiveFrom,x.contractId,versionId,x.effectiveFrom));if(x.status!=="draft")statements.push(db.prepare("UPDATE rights_contract_versions SET status=?,approved_by_user_id=?,approved_at=? WHERE id=? AND status='draft'").bind(x.status,x.status==="active"?actorUserId:null,x.status==="active"?approvedAt:null,versionId));statements.push(db.prepare("INSERT INTO rights_contract_audit(id,contract_id,contract_version_id,action,actor_user_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("rcaudit"),x.contractId,versionId,existing?"version_updated":"version_created",actorUserId,JSON.stringify(x),at));await db.batch(statements);return{id:versionId,contractId:x.contractId,versionNumber:x.versionNumber,status:x.status};}

export async function assignPublisherContract(db:CatalogDB,actorUserId:string,raw:unknown){const x=z.object({accountId:z.string().min(1),contractId:z.string().min(1),relationship:z.enum(["direct","distributor","aggregator","agent"]).default("direct"),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional(),status:z.enum(["active","suspended","terminated"]).default("active")}).parse(raw);const [account,contract]=await Promise.all([db.prepare("SELECT id FROM publishing_accounts WHERE id=?").bind(x.accountId).first<any>(),db.prepare("SELECT id FROM rights_contracts WHERE id=?").bind(x.contractId).first<any>()]);if(!account||!contract)throw new ApiError(404,"Publisher account or contract not found.");if(x.startsAt&&x.endsAt&&x.endsAt<=x.startsAt)throw new ApiError(400,"Contract assignment end must follow its start.");const at=now();await db.batch([db.prepare("INSERT INTO publisher_contract_assignments(account_id,contract_id,relationship,starts_at,ends_at,status,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,contract_id) DO UPDATE SET relationship=excluded.relationship,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status=excluded.status").bind(x.accountId,x.contractId,x.relationship,x.startsAt||null,x.endsAt||null,x.status,at),db.prepare("INSERT INTO rights_contract_audit(id,contract_id,action,actor_user_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?)").bind(id("rcaudit"),x.contractId,"publisher_assignment",actorUserId,JSON.stringify(x),at)]);return{assigned:true};}

function normalizeIdentityText(v:string){return v.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu," ").trim();}
export async function rebuildWorkIdentityKeys(db:CatalogDB,limit=1000){
  const rows=(await db.prepare(`SELECT w.id,w.title,COALESCE((SELECT c.name FROM editions e JOIN edition_contributors ec ON ec.edition_id=e.id JOIN contributors c ON c.id=ec.contributor_id WHERE e.work_id=w.id AND ec.role='author' ORDER BY ec.position LIMIT 1),'') author,COALESCE(w.original_language,(SELECT e.language FROM editions e WHERE e.work_id=w.id ORDER BY e.created_at LIMIT 1),'en') language FROM works w WHERE NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author_language') OR NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author') ORDER BY w.created_at LIMIT ?`).bind(Math.max(1,Math.min(5000,limit))).all<any>()).results;
  let created=0,collisions=0;const at=now();
  for(const r of rows){const title=normalizeIdentityText(String(r.title||"")),author=normalizeIdentityText(String(r.author||"")),language=String(r.language||"en").toLowerCase(),keys=[{key:`wkey_${await sha256(`${title}|${author}|${language}`)}`,scheme:"title_author_language",confidence:1},{key:`wkeyta_${await sha256(`${title}|${author}`)}`,scheme:"title_author",confidence:.82}];for(const candidate of keys){const existing=await db.prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?").bind(candidate.key).first<any>();if(existing&&String(existing.work_id)!==String(r.id)){collisions++;continue;}await db.prepare("INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(candidate.key,r.id,candidate.scheme,candidate.confidence,"catalog-rebuild",at,at).run();created++;}}
  const mappings=(await db.prepare("SELECT account_id,catalog_work_id,work_reference,original_work_title,publishing_edition_id FROM publisher_catalog_mappings WHERE catalog_work_id IS NOT NULL AND (work_reference<>'' OR original_work_title<>'') ORDER BY updated_at DESC LIMIT ?").bind(Math.max(1,Math.min(5000,limit))).all<any>()).results;
  for(const m of mappings){const edition=await db.prepare(`SELECT d.language,(SELECT display_name FROM publishing_edition_contributors c WHERE c.edition_id=d.id AND c.role='author' ORDER BY position LIMIT 1) author FROM publishing_edition_drafts d WHERE d.id=?`).bind(m.publishing_edition_id).first<any>(),p:PartnerProduct={productKey:"mapping",notificationType:"update",workReference:m.work_reference||undefined,originalWorkTitle:m.original_work_title||undefined,title:m.original_work_title||undefined,language:edition?.language||"en",contributors:edition?.author?[{name:String(edition.author),role:"author",position:0}]:[]};for(const candidate of await candidateWorkIdentityKeys(p)){const existing=await db.prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?").bind(candidate.key).first<any>();if(existing&&String(existing.work_id)!==String(m.catalog_work_id)){collisions++;continue;}await db.prepare("INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(candidate.key,m.catalog_work_id,candidate.scheme,candidate.scheme==="external_work_reference"?1:.82,`partner:${m.account_id}`,at,at).run();created++;}}
  return{scanned:rows.length,partnerMappings:mappings.length,created,collisions};
}

export async function reconcilePublicDomainWorks(db:CatalogDB,limit=250){await rebuildWorkIdentityKeys(db,Math.max(limit*3,500));const groups=(await db.prepare(`SELECT lower(trim(w.title)) title_key,lower(COALESCE((SELECT c.name FROM editions e JOIN edition_contributors ec ON ec.edition_id=e.id JOIN contributors c ON c.id=ec.contributor_id WHERE e.work_id=w.id AND ec.role='author' ORDER BY ec.position LIMIT 1),'')) author_key,COALESCE(w.original_language,(SELECT e.language FROM editions e WHERE e.work_id=w.id ORDER BY e.created_at LIMIT 1),'en') language,count(DISTINCT w.id) n,group_concat(DISTINCT w.id) ids FROM works w JOIN editions e0 ON e0.work_id=w.id LEFT JOIN products p0 ON p0.edition_id=e0.id WHERE (e0.canonical_public_domain=1 OR p0.source_name='gutenberg' OR e0.edition_type IN ('canonical_public_domain','annotated','new_translation','illustrated','scholarly')) GROUP BY title_key,author_key,language HAVING count(DISTINCT w.id)>1 LIMIT ?`).bind(Math.max(1,Math.min(1000,limit))).all<any>()).results;let merged=0;for(const g of groups){const ids=String(g.ids||"").split(",").filter(Boolean);if(ids.length<2)continue;const candidates=(await db.prepare(`SELECT w.id,MIN(CASE WHEN p.source_name='gutenberg' THEN 0 ELSE 1 END) source_rank,MIN(w.created_at) created_at FROM works w JOIN editions e ON e.work_id=w.id LEFT JOIN products p ON p.edition_id=e.id WHERE w.id IN (${ids.map(()=>"?").join(",")}) GROUP BY w.id ORDER BY source_rank,created_at,w.id`).bind(...ids).all<any>()).results;const canonical=String(candidates[0].id);for(const old of ids.filter(x=>x!==canonical)){await db.batch([db.prepare("UPDATE editions SET work_id=? WHERE work_id=?").bind(canonical,old),db.prepare("UPDATE publishing_titles SET catalog_work_id=? WHERE catalog_work_id=?").bind(canonical,old),db.prepare("UPDATE publisher_catalog_mappings SET catalog_work_id=? WHERE catalog_work_id=?").bind(canonical,old),db.prepare("INSERT OR REPLACE INTO work_redirects(old_work_id,canonical_work_id,reason,created_at) VALUES(?,?,?,?)").bind(old,canonical,"canonical-public-domain-work-reconciliation",now()),db.prepare("UPDATE works SET canonical_status='redirected',updated_at=? WHERE id=?").bind(now(),old)]);merged++;}await db.prepare("UPDATE works SET work_type='public_domain',canonical_status='canonical',updated_at=? WHERE id=?").bind(now(),canonical).run();}
  const canonicalRows=(await db.prepare(`SELECT w.id work_id,e.id edition_id,p.source_name,av.sha256 FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id LEFT JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' LEFT JOIN asset_versions av ON av.id=da.current_version_id WHERE p.source_name='gutenberg' AND p.storefront_status='active' ORDER BY w.id,e.created_at`).all<any>()).results;const seen=new Set<string>();for(const r of canonicalRows){if(seen.has(String(r.work_id)))continue;seen.add(String(r.work_id));await db.batch([db.prepare("UPDATE editions SET edition_type='canonical_public_domain',canonical_public_domain=1,differentiation_status='not_required' WHERE id=?").bind(r.edition_id),db.prepare("INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,source_text_fingerprint,asset_sha256,verification_status,policy_version,created_at,updated_at) VALUES(?,'canonical_public_domain','Canonical free Gutenberg edition','',?,'verified','fore-public-domain-editions-v1',?,?) ON CONFLICT(edition_id) DO UPDATE SET edition_type='canonical_public_domain',asset_sha256=excluded.asset_sha256,verification_status='verified',updated_at=excluded.updated_at").bind(r.edition_id,r.sha256||"",now(),now())]);}
  return{groups:groups.length,merged,canonicalized:seen.size};
}

export async function editionDifferentiationDecision(db:CatalogDB,input:{editionId:string;editionType:string;rightsBasis:string;differentiationSummary:string;assetSha256?:string|null;translatorPresent?:boolean}){const type=input.editionType||"original";if(input.rightsBasis!=="public_domain")return{allowed:true,reasonCode:"NOT_PUBLIC_DOMAIN",requiresReview:false};if(type==="canonical_public_domain")return{allowed:false,reasonCode:"CANONICAL_PUBLIC_DOMAIN_RESERVED",requiresReview:true};if(type==="original")return{allowed:false,reasonCode:"PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED",requiresReview:true};if(!input.differentiationSummary.trim())return{allowed:false,reasonCode:"DIFFERENTIATION_SUMMARY_REQUIRED",requiresReview:true};if(type==="new_translation"&&!input.translatorPresent)return{allowed:false,reasonCode:"TRANSLATOR_REQUIRED",requiresReview:true};if(input.assetSha256){const identical=await db.prepare(`SELECT e.id,e.edition_type,e.canonical_public_domain FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND e.id<>? LIMIT 1`).bind(input.assetSha256,input.editionId).first<any>();if(identical)return{allowed:false,reasonCode:"IDENTICAL_PUBLIC_DOMAIN_ASSET",requiresReview:true,matchedEditionId:String(identical.id)};}return{allowed:true,reasonCode:"DIFFERENTIATED_PUBLIC_DOMAIN_EDITION",requiresReview:false};}
