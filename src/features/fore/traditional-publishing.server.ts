/* eslint-disable prettier/prettier -- Byte-position-preserved private partner owner facades. */ import { z } from "zod/v3";
import { dispatchPartnerFeedProcessing,dispatchPrivatePartnerAction } from "../../storefront-strangler/publication-owner-routing.server";
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

export type PartnerProduct = {
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
  contributors?: {
    name: string;
    role: "author" | "editor" | "translator" | "illustrator" | "narrator" | "other";
    position: number;
  }[];
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
  editionType?:
    | "canonical_public_domain"
    | "annotated"
    | "new_translation"
    | "illustrated"
    | "scholarly"
    | "commercial_audiobook"
    | "original";
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
const clean = (v: unknown, max = 1000) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

export async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function derivedPartnerWebhookSecret(masterSecret: string, accountId: string) {
  if (!masterSecret || masterSecret.length < 32)
    throw new ApiError(503, "Partner webhook signing is not configured.");
  return `fwhsec_${bytesToBase64Url(await hmacSha256(masterSecret, `fore-partner-webhook-v1:${accountId}`))}`;
}

function randomToken(bytes = 32) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    const x = typeof value === "string" ? JSON.parse(value) : value;
    return (x ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function roleAllows(role: string, required: "analyst" | "editor" | "admin" | "owner") {
  const rank: Record<string, number> = { analyst: 1, finance: 1, editor: 2, admin: 3, owner: 4 };
  return (rank[role] || 0) >= (rank[required] || 99);
}

async function requirePartnerRole(
  db: CatalogDB,
  userId: string,
  accountId: string,
  required: "analyst" | "editor" | "admin" | "owner",
) {
  const member = await db
    .prepare("SELECT role,status FROM publishing_account_members WHERE account_id=? AND user_id=?")
    .bind(accountId, userId)
    .first<any>();
  if (!member || member.status !== "active" || !roleAllows(String(member.role), required))
    throw new ApiError(403, "You do not have permission to manage this publisher integration.");
  const account = await db
    .prepare("SELECT * FROM publishing_accounts WHERE id=?")
    .bind(accountId)
    .first<any>();
  if (!account || ["suspended", "closed"].includes(String(account.status)))
    throw new ApiError(403, "This publishing organization is not active.");
  return account;
}

export async function partnerAudit(
  db: CatalogDB,
  input: {
    accountId: string;
    environment?: string;
    actorType: string;
    actorId?: string;
    eventType: string;
    subjectType?: string;
    subjectId?: string;
    event?: unknown;
  },
) {
  await db
    .prepare(
      "INSERT INTO publisher_partner_audit_events(id,account_id,environment,actor_type,actor_id,event_type,subject_type,subject_id,event_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("paudit"),
      input.accountId,
      input.environment || "production",
      input.actorType,
      input.actorId || "",
      input.eventType,
      input.subjectType || "",
      input.subjectId || "",
      JSON.stringify(input.event || {}),
      now(),
    )
    .run();
}

export function normalizedCountryList(value: unknown) {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,;]+/g);
  return [
    ...new Set(
      values
        .map((x) => clean(x, 2).toUpperCase())
        .filter((x) => /^[A-Z]{2}$/.test(x) && !["XX", "ZZ"].includes(x)),
    ),
  ].sort();
}

function safePartnerCallbackUrl(value: string) {
  if (!value) return "";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ApiError(400, "Partner callback URL is invalid.");
  }
  if (u.protocol !== "https:") throw new ApiError(400, "Partner callback URLs must use HTTPS.");
  if (u.username || u.password)
    throw new ApiError(400, "Partner callback URLs may not include embedded credentials.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = h.includes(":");
  const blocked =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "::" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    (ipv6 && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")));
  if (blocked)
    throw new ApiError(
      400,
      "Partner callback URLs may not target localhost or private network addresses.",
    );
  u.hash = "";
  return u.toString();
}

const profileSchema = z.object({
  accountId: z.string().min(1),
  partnerCode: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => v.toUpperCase()),
  partnerType: z.enum(["publisher", "distributor", "aggregator", "agent"]).default("publisher"),
  integrationTier: z.enum(["managed", "api", "sftp", "hybrid"]).default("managed"),
  productionStatus: z
    .enum(["not_started", "testing", "certification", "active", "paused", "terminated"])
    .default("testing"),
  sandboxEnabled: z.boolean().default(true),
  metadataStandard: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"),
  defaultContractId: z.string().max(180).nullable().optional(),
  operationsEmail: z.string().email().or(z.literal("")).default(""),
  technicalEmail: z.string().email().or(z.literal("")).default(""),
  acknowledgementsUrl: z.string().url().or(z.literal("")).default(""),
  webhookUrl: z.string().url().or(z.literal("")).default(""),
  notes: z.string().max(5000).default(""),
});

export async function savePartnerProfile(db: CatalogDB, userId: string, raw: unknown) {
  const x = profileSchema.parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  x.acknowledgementsUrl = safePartnerCallbackUrl(x.acknowledgementsUrl);
  x.webhookUrl = safePartnerCallbackUrl(x.webhookUrl);
  // Certification is a retailer-side control. Publisher admins may edit integration
  // settings, but cannot promote themselves to production or clear a staff pause.
  const existingProfile = await db
    .prepare("SELECT production_status FROM publisher_partner_profiles WHERE account_id=?")
    .bind(x.accountId)
    .first<any>();
  const productionStatus = existingProfile ? String(existingProfile.production_status) : "testing";
  if (x.defaultContractId) {
    const assigned = await db
      .prepare(
        "SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'",
      )
      .bind(x.accountId, x.defaultContractId)
      .first<any>();
    if (!assigned)
      throw new ApiError(
        400,
        "The default contract must be actively assigned to this publishing organization.",
      );
  }
  const at = now();
  await db
    .prepare(
      `INSERT INTO publisher_partner_profiles(account_id,partner_code,partner_type,integration_tier,production_status,sandbox_enabled,metadata_standard,default_contract_id,operations_email,technical_email,acknowledgements_url,webhook_url,notes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET partner_code=excluded.partner_code,partner_type=excluded.partner_type,integration_tier=excluded.integration_tier,sandbox_enabled=excluded.sandbox_enabled,metadata_standard=excluded.metadata_standard,default_contract_id=excluded.default_contract_id,operations_email=excluded.operations_email,technical_email=excluded.technical_email,acknowledgements_url=excluded.acknowledgements_url,webhook_url=excluded.webhook_url,notes=excluded.notes,updated_at=excluded.updated_at`,
    )
    .bind(
      x.accountId,
      x.partnerCode,
      x.partnerType,
      x.integrationTier,
      productionStatus,
      x.sandboxEnabled ? 1 : 0,
      x.metadataStandard,
      x.defaultContractId || null,
      x.operationsEmail,
      x.technicalEmail,
      x.acknowledgementsUrl,
      x.webhookUrl,
      x.notes,
      at,
      at,
    )
    .run();
  if (x.acknowledgementsUrl || x.webhookUrl) {
    await db
      .prepare(
        `UPDATE publisher_validation_responses SET delivery_status='pending',next_attempt_at=?,last_error='' WHERE delivery_status='not_configured' AND submission_id IN (SELECT id FROM publisher_feed_submissions WHERE account_id=?)`,
      )
      .bind(at, x.accountId)
      .run();
  }
  await partnerAudit(db, {
    accountId: x.accountId,
    actorType: "user",
    actorId: userId,
    eventType: "partner.profile.saved",
    subjectType: "partner",
    subjectId: x.accountId,
    event: { partnerCode: x.partnerCode, productionStatus },
  });
  return { accountId: x.accountId, updatedAt: at };
}

export async function certifyPartnerProfile(db:CatalogDB,actorUserId:string,raw:unknown){
 return dispatchPrivatePartnerAction(db,"certify",{actorUserId,raw});
}









































































const channelSchema = z.object({
  id: z.string().max(180).optional(),
  accountId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  channelType: z.enum(["api", "sftp", "object_drop"]),
  label: z.string().trim().min(1).max(120),
  status: z.enum(["active", "paused", "disabled"]).default("active"),
  metadataFormat: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"),
  config: z.record(z.string(), z.unknown()).default({}),
  secretReference: z.string().max(500).default(""),
});
export async function savePartnerChannel(db: CatalogDB, userId: string, raw: unknown) {
  const x = channelSchema.parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  if (x.channelType === "sftp" && !x.secretReference)
    throw new ApiError(
      400,
      "SFTP channels must point to a secret-manager credential reference. Raw passwords/private keys are not stored in Cove.",
    );
  const disallowed = ["password", "privateKey", "secret", "token"].filter((k) =>
    Object.keys(x.config).some((v) => v.toLowerCase().includes(k.toLowerCase())),
  );
  if (disallowed.length)
    throw new ApiError(
      400,
      "Channel config may contain only non-secret transport settings. Store credentials in your secret manager and provide secretReference.",
    );
  const channelId = x.id || id("pchannel"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publisher_ingestion_channels(id,account_id,environment,channel_type,label,status,metadata_format,config_json,secret_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET environment=excluded.environment,channel_type=excluded.channel_type,label=excluded.label,status=excluded.status,metadata_format=excluded.metadata_format,config_json=excluded.config_json,secret_reference=excluded.secret_reference,updated_at=excluded.updated_at`,
    )
    .bind(
      channelId,
      x.accountId,
      x.environment,
      x.channelType,
      x.label,
      x.status,
      x.metadataFormat,
      JSON.stringify(x.config),
      x.secretReference,
      at,
      at,
    )
    .run();
  await partnerAudit(db, {
    accountId: x.accountId,
    environment: x.environment,
    actorType: "user",
    actorId: userId,
    eventType: "partner.channel.saved",
    subjectType: "channel",
    subjectId: channelId,
    event: { channelType: x.channelType, label: x.label },
  });
  return { id: channelId };
}

const credentialSchema = z.object({
  accountId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  label: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.enum(["feeds:write", "feeds:read", "assets:write", "catalog:read"]))
    .min(1)
    .max(4)
    .default(["feeds:write", "feeds:read"]),
  ipAllowlist: z.array(z.string().trim().min(3).max(80)).max(100).default([]),
  expiresAt: z.string().datetime().nullable().optional(),
});
export async function issuePartnerCredential(db:CatalogDB,userId:string,raw:unknown){
 return dispatchPrivatePartnerAction(db,"issue-credential",{actorUserId:userId,raw});
}






























































export async function revokePartnerCredential(db:CatalogDB,userId:string,raw:unknown){
 return dispatchPrivatePartnerAction(db,"revoke-credential",{actorUserId:userId,raw});
}






















function ipMatchesRule(ip: string, rule: string) {
  if (!rule) return false;
  if (ip === rule) return true;
  // Conservative CIDR support for IPv4. IPv6 allowlists should use exact addresses until a dedicated parser is deployed.
  const m = rule.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/);
  const p = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m || !p) return false;
  const bits = Number(m[5]);
  if (bits < 0 || bits > 32) return false;
  const toN = (a: RegExpMatchArray) =>
    (((Number(a[1]) << 24) >>> 0) + (Number(a[2]) << 16) + (Number(a[3]) << 8) + Number(a[4])) >>>
    0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toN(m) & mask) === (toN(p) & mask);
}

export async function authenticatePartnerRequest(
  db: CatalogDB,
  request: Request,
  requiredScope: string,
): Promise<PartnerPrincipal> {
  const supplied = clean(
    request.headers.get("x-fore-partner-key") ||
      request.headers.get("authorization")?.replace(/^CovePartner\s+/i, ""),
    500,
  );
  const dot = supplied.indexOf(".");
  if (dot < 10) throw new ApiError(401, "A valid Cove partner credential is required.");
  const prefix = supplied.slice(0, dot);
  const row = await db
    .prepare("SELECT * FROM publisher_partner_credentials WHERE key_prefix=?")
    .bind(prefix)
    .first<any>();
  if (!row || row.status !== "active" || (row.expires_at && String(row.expires_at) <= now()))
    throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const hash = await sha256(supplied);
  let diff = hash.length ^ String(row.secret_hash).length;
  for (let i = 0; i < Math.max(hash.length, String(row.secret_hash).length); i++)
    diff |= (hash.charCodeAt(i) || 0) ^ (String(row.secret_hash).charCodeAt(i) || 0);
  if (diff !== 0) throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const scopes = new Set(parseJson<string[]>(row.scopes_json, []));
  if (!scopes.has(requiredScope))
    throw new ApiError(403, `Partner credential lacks ${requiredScope}.`);
  const allowlist = parseJson<string[]>(row.ip_allowlist_json, []);
  const ip = clean(
    request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0],
    100,
  );
  if (allowlist.length && !allowlist.some((r) => ipMatchesRule(ip, r)))
    throw new ApiError(403, "This client address is not allowed for the partner credential.");
  const profile = await db
    .prepare(
      "SELECT production_status,sandbox_enabled FROM publisher_partner_profiles WHERE account_id=?",
    )
    .bind(row.account_id)
    .first<any>();
  if (!profile) throw new ApiError(403, "Partner integration is not configured.");
  if (row.environment === "production" && String(profile.production_status) !== "active")
    throw new ApiError(403, "Production partner ingestion is not active.");
  if (row.environment === "sandbox" && !Number(profile.sandbox_enabled))
    throw new ApiError(403, "Partner sandbox access is disabled.");
  await db
    .prepare("UPDATE publisher_partner_credentials SET last_used_at=? WHERE id=?")
    .bind(now(), row.id)
    .run();
  return {
    credentialId: String(row.id),
    accountId: String(row.account_id),
    environment: row.environment,
    actorUserId: String(row.actor_user_id),
    keyPrefix: prefix,
    scopes,
  };
}

function xmlDecode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tagText(xml: string, tags: string[]) {
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = xml.match(
      new RegExp(
        `<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`,
        "i",
      ),
    );
    if (m) return xmlDecode(m[1]);
  }
  return "";
}
function tagBlocks(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...xml.matchAll(
      new RegExp(
        `<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`,
        "gi",
      ),
    ),
  ].map((m) => m[1]);
}
function onixDate(value: string) {
  const v = value.replace(/\D/g, "");
  if (v.length >= 8) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00.000Z`;
  if (v.length >= 6) return `${v.slice(0, 4)}-${v.slice(4, 6)}-01T00:00:00.000Z`;
  if (v.length >= 4) return `${v.slice(0, 4)}-01-01T00:00:00.000Z`;
  return null;
}
function onixRole(
  code: string,
): "author" | "editor" | "translator" | "illustrator" | "narrator" | "other" {
  const c = code.toUpperCase();
  if (["B06", "B10"].includes(c)) return "translator";
  if (["A12", "A13"].includes(c)) return "illustrator";
  if (c === "E07") return "narrator";
  if (["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10", "A11"].includes(c))
    return "author";
  if (/^B\d{2}$/.test(c)) return "editor";
  return "other";
}
function onixAvailability(code: string): PartnerProduct["availability"] {
  if (["20", "21", "22", "23", "30", "31", "32", "33", "40"].includes(code)) return "available";
  if (["10", "11", "12", "13", "14", "15", "16", "17"].includes(code)) return "preorder";
  if (["41", "42", "43", "44", "45", "46", "47", "48"].includes(code))
    return "temporarily_unavailable";
  if (
    [
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "50",
      "51",
      "52",
      "53",
      "54",
      "55",
      "56",
      "57",
      "58",
      "59",
      "60",
      "61",
      "62",
      "63",
      "64",
      "65",
      "66",
      "67",
      "68",
      "69",
      "70",
      "71",
      "72",
      "73",
      "74",
      "75",
      "76",
      "77",
      "78",
      "79",
      "80",
      "81",
      "82",
      "83",
      "84",
      "85",
      "86",
      "87",
      "88",
      "89",
      "90",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
      "97",
      "98",
      "99",
    ].includes(code)
  )
    return "withdrawn";
  return "available";
}

function parseOnix(xml: string): {
  products: PartnerProduct[];
  warnings: string[];
  version: string;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new ApiError(
      400,
      "ONIX feeds containing DTD/entity declarations are rejected. Submit self-contained ONIX XML without external entities.",
    );
  if (
    /<(?:a001|b221|b244|j151|j152)\b/i.test(xml) &&
    !/<(?:Product|RecordReference|ProductIdentifier)\b/i.test(xml)
  )
    throw new ApiError(
      400,
      "ONIX short-tag-only feeds are not accepted by Cove's in-process parser. Configure the partner channel to send ONIX reference tags; the ingestion acknowledgement fails closed rather than guessing short-tag semantics.",
    );
  const version = /release\s*=\s*["']3/i.test(xml) ? "onix_3" : "onix_2_1",
    blocks = tagBlocks(xml, "Product");
  if (!blocks.length) throw new ApiError(400, "No ONIX Product records were found.");
  const warnings: string[] = [],
    products: PartnerProduct[] = [];
  blocks.forEach((block, ordinal) => {
    const recordReference = tagText(block, ["RecordReference"]);
    const notificationCode = tagText(block, ["NotificationType"]);
    const notificationType: PartnerProduct["notificationType"] =
      notificationCode === "05"
        ? "delete"
        : ["01", "02", "03"].includes(notificationCode)
          ? "create"
          : "update";
    const identifiers = tagBlocks(block, "ProductIdentifier").map((b) => ({
      type: tagText(b, ["ProductIDType"]),
      value: tagText(b, ["IDValue"]),
    }));
    const isbn =
      identifiers.find((x) => x.type === "15" && /^\d{13}$/.test(x.value))?.value || null;
    const proprietary = identifiers.find((x) => x.type === "01")?.value || "";
    const productKey = recordReference || isbn || proprietary;
    if (!productKey) {
      warnings.push(`Product ${ordinal + 1} has no RecordReference/ISBN/proprietary identifier.`);
      return;
    }
    const titleDetail = tagBlocks(block, "TitleDetail")[0] || tagBlocks(block, "Title")[0] || block;
    const title = tagText(titleDetail, ["TitleText", "TitleWithoutPrefix"]);
    const subtitle = tagText(titleDetail, ["Subtitle"]);
    const description =
      tagBlocks(block, "TextContent")
        .map((t) => tagText(t, ["Text"]))
        .find(Boolean) || tagText(block, ["Annotation", "OtherText"]);
    const contributors = tagBlocks(block, "Contributor")
      .map((c, i) => ({
        name: tagText(c, ["PersonName", "PersonNameInverted", "CorporateName"]),
        role: onixRole(tagText(c, ["ContributorRole"])),
        position: Number(tagText(c, ["SequenceNumber"]) || i),
      }))
      .filter((c) => c.name)
      .slice(0, 50);
    const languageBlock =
      tagBlocks(block, "Language").find((l) => ["01", ""].includes(tagText(l, ["LanguageRole"]))) ||
      tagBlocks(block, "Language")[0] ||
      "";
    const language = (tagText(languageBlock, ["LanguageCode"]) || "en").toLowerCase();
    const publisherBlock = tagBlocks(block, "Publisher")[0] || "";
    const publisherName = tagText(publisherBlock, ["PublisherName"]);
    const imprintName = tagText(tagBlocks(block, "Imprint")[0] || "", ["ImprintName"]);
    const pubDates = tagBlocks(block, "PublishingDate");
    const releaseDate = onixDate(
      tagText(
        pubDates.find((d) => ["01", "11"].includes(tagText(d, ["PublishingDateRole"]))) ||
          pubDates[0] ||
          "",
        ["Date"],
      ),
    );
    const supply = tagBlocks(block, "SupplyDetail")[0] || block;
    const availability = onixAvailability(
      tagText(supply, ["ProductAvailability", "ProductAvailabilityCode"]),
    );
    const prices = tagBlocks(supply, "Price");
    const retailPrice =
      prices.find((p) =>
        ["01", "02", "04", "41", "42"].includes(tagText(p, ["PriceType", "PriceTypeCode"])),
      ) ||
      prices[0] ||
      "";
    const amountRaw = tagText(retailPrice, ["PriceAmount"]);
    const currency = (tagText(retailPrice, ["CurrencyCode"]) || "USD").toUpperCase();
    const priceMinor =
      amountRaw && !Number.isNaN(Number(amountRaw))
        ? Math.round(Number(amountRaw) * 100)
        : undefined;
    const territoryBlocks = [
      ...tagBlocks(block, "Territory"),
      ...tagBlocks(retailPrice, "Territory"),
    ];
    const included = normalizedCountryList(
      territoryBlocks.flatMap((t) => tagText(t, ["CountriesIncluded"]).split(/\s+/g)),
    );
    const excluded = normalizedCountryList(
      territoryBlocks.flatMap((t) => tagText(t, ["CountriesExcluded"]).split(/\s+/g)),
    );
    const form = tagText(block, ["ProductForm", "ProductFormDetail"]);
    const format: "ebook" | "audiobook" = /audio|spoken|EC|ED|EA/i.test(form)
      ? "audiobook"
      : "ebook";
    const relatedWork = tagBlocks(block, "RelatedWork")[0] || "",
      workIdentifier = tagBlocks(relatedWork, "WorkIdentifier")[0] || "",
      workIdType = tagText(workIdentifier, ["WorkIDType"]),
      workIdValue = tagText(workIdentifier, ["IDValue"]),
      workReference = workIdValue ? `${workIdType || "01"}:${workIdValue}` : "";
    products.push({
      productKey,
      recordReference,
      workReference: workReference || undefined,
      notificationType,
      title: title || undefined,
      subtitle,
      description,
      language,
      format,
      editionLabel: tagText(block, ["EditionStatement"]),
      isbn13: isbn,
      publisherIdentifier: proprietary || recordReference,
      publisherName,
      imprintName,
      contributors,
      rightsBasis: "licensed",
      territories: {
        mode: included.length ? "expression" : "worldwide",
        include: included,
        exclude: excluded,
      },
      releaseDate,
      currency,
      priceMinor,
      availability,
      editionType: format === "audiobook" ? "commercial_audiobook" : "original",
    });
  });
  return { products, warnings, version };
}

const partnerProductSchema = z.object({
  productKey: z.string().trim().min(1).max(300),
  recordReference: z.string().max(300).optional(),
  workReference: z.string().max(500).optional(),
  originalWorkTitle: z.string().max(500).optional(),
  notificationType: z.enum(["create", "update", "delete"]).default("update"),
  title: z.string().trim().max(500).optional(),
  subtitle: z.string().max(500).default(""),
  description: z.string().max(30000).default(""),
  language: z.string().min(2).max(35).default("en"),
  format: z.enum(["ebook", "audiobook"]).default("ebook"),
  editionLabel: z.string().max(180).default(""),
  isbn13: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .optional(),
  publisherIdentifier: z.string().max(300).default(""),
  publisherName: z.string().max(300).default(""),
  imprintName: z.string().max(300).default(""),
  contributors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(300),
        role: z.enum(["author", "editor", "translator", "illustrator", "narrator", "other"]),
        position: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .max(100)
    .default([]),
  rightsBasis: z.enum(["owned", "licensed", "public_domain"]).default("licensed"),
  territories: z
    .object({
      mode: z.enum(["worldwide", "expression"]).default("worldwide"),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .optional(),
  releaseDate: z.string().datetime().nullable().optional(),
  preorderDate: z.string().datetime().nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .default("USD"),
  priceMinor: z.number().int().min(0).max(100000000).optional(),
  availability: z
    .enum(["available", "preorder", "temporarily_unavailable", "withdrawn"])
    .optional(),
  subscriptionPermitted: z.boolean().default(false),
  libraryPermitted: z.boolean().default(false),
  downloadable: z.boolean().default(true),
  drmRequirement: z.enum(["none", "watermark", "lcp", "adobe_acs"]).default("none"),
  editionType: z
    .enum([
      "canonical_public_domain",
      "annotated",
      "new_translation",
      "illustrated",
      "scholarly",
      "commercial_audiobook",
      "original",
    ])
    .default("original"),
  differentiationSummary: z.string().max(5000).default(""),
  contractReference: z.string().max(300).default(""),
  sourceRevision: z.string().max(300).default(""),
  assetKind: z.enum(["epub", "cover", "audio", "sample", "supplement"]).optional(),
  filename: z.string().trim().min(1).max(240).optional(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .transform((v) => v.toLowerCase())
    .optional(),
  sizeBytes: z.number().int().min(0).max(2_000_000_000).optional(),
  mimeType: z.string().max(120).optional(),
});

function validatePartnerProduct(product: PartnerProduct, feedType: string) {
  const issues: { severity: "warning" | "error"; code: string; message: string }[] = [];
  if (feedType === "metadata" && product.notificationType !== "delete") {
    if (!product.title?.trim())
      issues.push({
        severity: "error",
        code: "TITLE_REQUIRED",
        message: "Metadata records require a title.",
      });
    if (product.priceMinor == null)
      issues.push({
        severity: "error",
        code: "INITIAL_PRICE_REQUIRED",
        message:
          "Metadata records require an explicit initial priceMinor, including an intentional zero price. Subsequent changes may use the dedicated price feed.",
      });
    if (!product.territories)
      issues.push({
        severity: "error",
        code: "INITIAL_TERRITORY_REQUIRED",
        message:
          "Metadata records require an explicit initial territory scope. Subsequent changes may use the dedicated territory feed.",
      });
    if (!product.contributors?.some((c) => c.role === "author") && product.format !== "audiobook")
      issues.push({
        severity: "warning",
        code: "AUTHOR_MISSING",
        message: "No author contributor was supplied.",
      });
    if (product.rightsBasis === "public_domain") {
      if (["original", "canonical_public_domain"].includes(String(product.editionType)))
        issues.push({
          severity: "error",
          code: "PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED",
          message:
            "Commercial public-domain submissions must declare a differentiated edition (annotated, new translation, illustrated, scholarly, or commercial audiobook). Cove reserves canonical_public_domain for canonical free-source ingestion.",
        });
      if (!product.differentiationSummary?.trim())
        issues.push({
          severity: "error",
          code: "DIFFERENTIATION_SUMMARY_REQUIRED",
          message: "Explain the substantive differentiation from the canonical public-domain text.",
        });
      if (
        product.editionType === "new_translation" &&
        !product.contributors?.some((c) => c.role === "translator")
      )
        issues.push({
          severity: "error",
          code: "TRANSLATOR_REQUIRED",
          message: "A new translation must identify at least one translator.",
        });
    }
    if (product.editionType === "commercial_audiobook" && product.format !== "audiobook")
      issues.push({
        severity: "error",
        code: "EDITION_FORMAT_MISMATCH",
        message: "commercial_audiobook classification requires audiobook format.",
      });
  }
  if (["price", "availability", "territory"].includes(feedType) && !product.productKey)
    issues.push({
      severity: "error",
      code: "PRODUCT_KEY_REQUIRED",
      message: "Delta records require partnerProductKey.",
    });
  if (feedType === "price" && product.priceMinor == null)
    issues.push({
      severity: "error",
      code: "PRICE_REQUIRED",
      message: "Price feed records require priceMinor.",
    });
  if (feedType === "availability" && !product.availability)
    issues.push({
      severity: "error",
      code: "AVAILABILITY_REQUIRED",
      message: "Availability feed records require availability.",
    });
  if (feedType === "territory" && !product.territories)
    issues.push({
      severity: "error",
      code: "TERRITORY_SCOPE_REQUIRED",
      message: "Territory feed records require an explicit territory scope.",
    });
  if (feedType === "assets_manifest") {
    if (!product.assetKind)
      issues.push({
        severity: "error",
        code: "ASSET_KIND_REQUIRED",
        message: "Asset manifest records require assetKind.",
      });
    if (!product.filename)
      issues.push({
        severity: "error",
        code: "ASSET_FILENAME_REQUIRED",
        message: "Asset manifest records require filename.",
      });
    if (!product.sha256)
      issues.push({
        severity: "error",
        code: "ASSET_SHA256_REQUIRED",
        message: "Asset manifest records require sha256.",
      });
    if (product.sizeBytes == null)
      issues.push({
        severity: "error",
        code: "ASSET_SIZE_REQUIRED",
        message: "Asset manifest records require sizeBytes.",
      });
  }
  if (product.territories) {
    product.territories.include = normalizedCountryList(product.territories.include);
    product.territories.exclude = normalizedCountryList(product.territories.exclude);
  }
  return issues;
}

async function readBounded(request: Request, limit: number) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new ApiError(413, "Partner feed exceeds the configured upload limit.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit)
    throw new ApiError(413, "Partner feed exceeds the configured upload limit.");
  return bytes;
}

export async function submitPartnerFeed(_env:CoveEnv,_request:Request,_principal:PartnerPrincipal){
 throw new ApiError(503,"Partner feed intake requires owner-controlled R2 staging and replay certification.");
}














































































































































































































































































































































async function candidateWorkIdentityKeys(p: PartnerProduct) {
  const norm = (v: string) =>
      clean(v)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    author = norm(p.contributors?.find((c) => c.role === "author")?.name || "");
  const keys: { key: string; scheme: string }[] = [];
  if (p.workReference)
    keys.push({
      key: `wref_${await sha256(clean(p.workReference, 500).toLowerCase())}`,
      scheme: "external_work_reference",
    });
  const sourceTitle = norm(p.originalWorkTitle || p.title || "");
  if (sourceTitle && author)
    keys.push({
      key: `wkeyta_${await sha256(`${sourceTitle}|${author}`)}`,
      scheme: "title_author",
    });
  if (sourceTitle)
    keys.push({
      key: `wkey_${await sha256(`${sourceTitle}|${author}|${clean(p.language || "en").toLowerCase()}`)}`,
      scheme: "title_author_language",
    });
  return keys;
}

async function matchAssetExpectations(_db:CatalogDB,_input:unknown){
 throw new ApiError(503,"Partner asset expectation matching requires its private owner.");
}




































































/** Canonical partner application is now exclusively owned. This caller cannot write D1. */
export async function processPartnerFeedQueue(db: CatalogDB, limit = 25) {
  return dispatchPartnerFeedProcessing(db, limit);
}

export async function revealPartnerWebhookSecret(env: CoveEnv, userId: string, accountId: string) {
  await requirePartnerRole(env.DB as CatalogDB, userId, accountId, "admin");
  const profile = await env.DB.prepare(
    "SELECT partner_code FROM publisher_partner_profiles WHERE account_id=?",
  )
    .bind(accountId)
    .first<any>();
  if (!profile) throw new ApiError(404, "Partner integration profile not found.");
  const secret = await derivedPartnerWebhookSecret(
    env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "",
    accountId,
  );
  await partnerAudit(env.DB as CatalogDB, {
    accountId,
    actorType: "user",
    actorId: userId,
    eventType: "partner.webhook_secret.revealed",
    subjectType: "partner",
    subjectId: accountId,
    event: { partnerCode: profile.partner_code || "" },
  });
  return {
    accountId,
    partnerCode: profile.partner_code || "",
    algorithm: "HMAC-SHA256",
    secret,
    signatureHeader: "X-Cove-Signature",
    timestampHeader: "X-Cove-Timestamp",
  };
}

function callbackRetryAt(attempts: number) {
  const minutes = Math.min(360, Math.max(1, 2 ** Math.min(8, attempts)) * 2);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function postPartnerAcknowledgement(
  url: string,
  payload: string,
  input: { secret: string; responseId: string },
) {
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
  const rows = (
    await db
      .prepare(
        `SELECT r.*,s.account_id,s.environment,s.external_feed_id,s.feed_type,s.mode,s.status submission_status,s.source_sha256,
      p.partner_code,p.acknowledgements_url,p.webhook_url
    FROM publisher_validation_responses r
    JOIN publisher_feed_submissions s ON s.id=r.submission_id
    LEFT JOIN publisher_partner_profiles p ON p.account_id=s.account_id
    WHERE r.delivery_status IN ('pending','failed') AND r.attempts<8 AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?)
    ORDER BY r.created_at,r.id LIMIT ?`,
      )
      .bind(at, Math.max(1, Math.min(200, limit)))
      .all<any>()
  ).results;
  let delivered = 0,
    failed = 0,
    notConfigured = 0;
  for (const row of rows) {
    let destination = clean(
      row.destination_url || row.acknowledgements_url || row.webhook_url,
      2000,
    );
    const attempts = Number(row.attempts || 0) + 1;
    if (!destination) {
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='not_configured',attempts=?,last_attempt_at=?,last_error='No acknowledgement callback URL is configured.',next_attempt_at=NULL WHERE id=?",
        )
        .bind(attempts, at, row.id)
        .run();
      notConfigured++;
      continue;
    }
    try {
      destination = safePartnerCallbackUrl(destination);
      const secret = await derivedPartnerWebhookSecret(
        env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "",
        String(row.account_id),
      );
      const payloadObject = {
        schemaVersion: "fore.partner.ack.v1",
        eventId: String(row.id),
        eventType: `partner.feed.${String(row.response_type)}`,
        createdAt: String(row.created_at),
        partner: {
          accountId: String(row.account_id),
          partnerCode: String(row.partner_code || ""),
          environment: String(row.environment),
        },
        submission: {
          id: String(row.submission_id),
          externalFeedId: String(row.external_feed_id || ""),
          feedType: String(row.feed_type),
          mode: String(row.mode),
          status: String(row.submission_status),
          sourceSha256: String(row.source_sha256 || ""),
        },
        response: {
          type: String(row.response_type),
          status: String(row.status),
          code: String(row.machine_code),
          message: String(row.message),
          payload: parseJson(row.payload_json, {}),
        },
      };
      const payload = JSON.stringify(payloadObject);
      const payloadSha = await sha256(payload);
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET destination_url=?,payload_sha256=?,attempts=?,last_attempt_at=?,last_error='',next_attempt_at=NULL WHERE id=?",
        )
        .bind(destination, payloadSha, attempts, at, row.id)
        .run();
      const result = await postPartnerAcknowledgement(destination, payload, {
        secret,
        responseId: String(row.id),
      });
      const deliveredAt = now();
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='delivered',delivered_at=?,last_error='',next_attempt_at=NULL WHERE id=?",
        )
        .bind(deliveredAt, row.id)
        .run();
      await partnerAudit(db, {
        accountId: String(row.account_id),
        environment: String(row.environment),
        actorType: "worker",
        actorId: "partner-ack",
        eventType: "partner.ack.delivered",
        subjectType: "validation_response",
        subjectId: String(row.id),
        event: { destination, httpStatus: result.status, attempts, payloadSha256: payloadSha },
      });
      delivered++;
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : "Partner acknowledgement delivery failed."
      ).slice(0, 2000);
      const terminal = attempts >= 8;
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='failed',attempts=?,last_attempt_at=?,last_error=?,next_attempt_at=? WHERE id=?",
        )
        .bind(attempts, at, message, terminal ? null : callbackRetryAt(attempts), row.id)
        .run();
      await partnerAudit(db, {
        accountId: String(row.account_id),
        environment: String(row.environment),
        actorType: "worker",
        actorId: "partner-ack",
        eventType: "partner.ack.failed",
        subjectType: "validation_response",
        subjectId: String(row.id),
        event: { destination, attempts, terminal, error: message },
      });
      failed++;
    }
  }
  return { leased: rows.length, delivered, failed, notConfigured };
}

export async function partnerFeedAcknowledgement(
  db: CatalogDB,
  principal: PartnerPrincipal,
  submissionId: string,
) {
  const submission = await db
    .prepare(
      "SELECT * FROM publisher_feed_submissions WHERE id=? AND account_id=? AND environment=?",
    )
    .bind(submissionId, principal.accountId, principal.environment)
    .first<any>();
  if (!submission) throw new ApiError(404, "Feed submission not found.");
  const items = (
    await db
      .prepare(
        "SELECT ordinal,partner_product_key,notification_type,status,validation_json,applied_entity_type,applied_entity_id FROM publisher_feed_items WHERE submission_id=? ORDER BY ordinal LIMIT 10000",
      )
      .bind(submissionId)
      .all<any>()
  ).results;
  const responses = (
    await db
      .prepare(
        "SELECT id,response_type,status,machine_code,message,payload_json,delivery_status,attempts,destination_url,payload_sha256,last_attempt_at,next_attempt_at,last_error,created_at,delivered_at FROM publisher_validation_responses WHERE submission_id=? ORDER BY created_at",
      )
      .bind(submissionId)
      .all<any>()
  ).results;
  return {
    submission,
    items: items.map((i) => ({ ...i, validation: parseJson(i.validation_json, []) })),
    responses: responses.map((r) => ({ ...r, payload: parseJson(r.payload_json, {}) })),
  };
}

export async function uploadPartnerAsset(_env:CoveEnv,_request:Request,_principal:PartnerPrincipal){
 throw new ApiError(503,"Partner asset upload requires an independently verified private owner R2 intake.");
}









































































































































































export async function uploadPartnerAssetBatch(
  env: CoveEnv,
  request: Request,
  principal: PartnerPrincipal,
) {
  const bytes = await readBounded(request, 250 * 1024 * 1024),
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry)
    throw new ApiError(400, "Bulk asset archives require manifest.json at the archive root.");
  let manifest: any;
  try {
    manifest = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new ApiError(400, "Bulk asset manifest.json is not valid JSON.");
  }
  const entries = z
    .array(
      z.object({
        productKey: z.string().trim().min(1).max(300),
        kind: z.enum(["epub", "cover"]),
        path: z.string().min(1).max(500),
        filename: z.string().max(240).optional(),
        mimeType: z.string().max(120).optional(),
        sha256: z
          .string()
          .regex(/^[a-fA-F0-9]{64}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(500)
    .parse(manifest?.assets);
  if (Object.keys(zip.files).length > 1001)
    throw new ApiError(413, "Bulk asset archive contains too many files.");
  const duplicateKeys = new Set<string>(),
    duplicatePaths = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.productKey}\0${entry.kind}`;
    if (duplicateKeys.has(key))
      throw new ApiError(
        400,
        `Bulk manifest contains duplicate ${entry.kind} entries for ${entry.productKey}.`,
      );
    duplicateKeys.add(key);
    if (duplicatePaths.has(entry.path))
      throw new ApiError(400, `Bulk manifest reuses archive path ${entry.path}.`);
    duplicatePaths.add(entry.path);
  }
  const results: any[] = [];
  let accepted = 0,
    rejected = 0,
    totalExtracted = 0;
  for (const entry of entries) {
    try {
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.split("/").includes("..")
      )
        throw new ApiError(400, "Asset paths may not escape the archive root.");
      const file = zip.file(entry.path);
      if (!file || file.dir) throw new ApiError(400, `Archive asset ${entry.path} was not found.`);
      const assetBytes = await file.async("uint8array");
      totalExtracted += assetBytes.byteLength;
      if (totalExtracted > 300 * 1024 * 1024)
        throw new ApiError(413, "Bulk asset archive expands beyond Cove's 300 MiB safety limit.");
      const max = publishingUploadLimit(entry.kind === "epub" ? "manuscript" : "cover");
      if (assetBytes.byteLength > max)
        throw new ApiError(413, `${entry.path} exceeds the ${entry.kind} upload limit.`);
      if (entry.sha256 && (await sha256(assetBytes)) !== entry.sha256.toLowerCase())
        throw new ApiError(409, `${entry.path} checksum does not match manifest.json.`);
      const mime =
          entry.mimeType ||
          (entry.kind === "epub"
            ? "application/epub+zip"
            : /\.png$/i.test(entry.path)
              ? "image/png"
              : "image/jpeg"),
        filename =
          entry.filename ||
          entry.path.split("/").pop() ||
          `asset.${entry.kind === "epub" ? "epub" : "jpg"}`;
      const internal = new Request("https://fore.internal/partner-asset", {
        method: "POST",
        headers: {
          "x-fore-product-key": entry.productKey,
          "x-fore-asset-kind": entry.kind,
          "x-fore-filename": filename,
          "content-type": mime,
        },
        body: new Uint8Array(assetBytes),
      });
      const out = await uploadPartnerAsset(env, internal, principal);
      results.push({
        productKey: entry.productKey,
        path: entry.path,
        status: "accepted",
        asset: out,
      });
      accepted++;
    } catch (e) {
      results.push({
        productKey: entry.productKey,
        path: entry.path,
        status: "rejected",
        error: e instanceof Error ? e.message : "Asset ingestion failed.",
      });
      rejected++;
    }
  }
  await partnerAudit(env.DB, {
    accountId: principal.accountId,
    environment: principal.environment,
    actorType: "credential",
    actorId: principal.credentialId,
    eventType: "partner.assets.batch",
    subjectType: "asset_batch",
    subjectId: id("assetbatch"),
    event: { accepted, rejected, itemCount: entries.length, totalExtracted },
  });
  return {
    environment: principal.environment,
    itemCount: entries.length,
    acceptedCount: accepted,
    rejectedCount: rejected,
    results,
  };
}

export async function partnerDashboard(db: CatalogDB, userId: string, accountId: string) {
  await requirePartnerRole(db, userId, accountId, "analyst");
  const [
    profile,
    credentials,
    channels,
    feeds,
    mappings,
    assets,
    expectations,
    responses,
    contracts,
    audit,
  ] = await Promise.all([
    db
      .prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?")
      .bind(accountId)
      .first<any>(),
    db
      .prepare(
        "SELECT id,account_id,environment,label,key_prefix,scopes_json,ip_allowlist_json,status,last_used_at,expires_at,created_at,revoked_at FROM publisher_partner_credentials WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_ingestion_channels WHERE account_id=? ORDER BY environment,label",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_feed_submissions WHERE account_id=? ORDER BY received_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_catalog_mappings WHERE account_id=? ORDER BY updated_at DESC LIMIT 200",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,environment,partner_product_key,asset_kind,source_filename,mime_type,size_bytes,sha256,status,linked_publishing_asset_version_id,created_at,updated_at FROM publisher_feed_assets WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,submission_id,environment,partner_product_key,asset_kind,source_filename,expected_mime_type,expected_size_bytes,expected_sha256,status,matched_asset_id,validation_json,created_at,matched_at FROM publisher_asset_expectations WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT r.id,r.submission_id,r.response_type,r.status,r.machine_code,r.message,r.delivery_status,r.attempts,r.destination_url,r.payload_sha256,r.last_attempt_at,r.next_attempt_at,r.last_error,r.created_at,r.delivered_at FROM publisher_validation_responses r JOIN publisher_feed_submissions s ON s.id=r.submission_id WHERE s.account_id=? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT a.*,rc.reference_code,rc.name,rc.status contract_status,rcv.id active_version_id,rcv.version_number,rcv.effective_from,rcv.effective_to,rcv.retailer_commission_bps,rcv.post_termination_access_policy FROM publisher_contract_assignments a JOIN rights_contracts rc ON rc.id=a.contract_id LEFT JOIN rights_contract_versions rcv ON rcv.contract_id=rc.id AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) WHERE a.account_id=? ORDER BY rc.reference_code`,
      )
      .bind(now(), now(), accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_partner_audit_events WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
  ]);
  return {
    profile: profile || null,
    credentials: credentials.results.map((r: any) => ({
      ...r,
      scopes: parseJson(r.scopes_json, []),
      ipAllowlist: parseJson(r.ip_allowlist_json, []),
    })),
    channels: channels.results.map((r: any) => ({ ...r, config: parseJson(r.config_json, {}) })),
    feeds: feeds.results,
    mappings: mappings.results,
    assets: assets.results,
    expectations: expectations.results.map((r: any) => ({
      ...r,
      validation: parseJson(r.validation_json, []),
    })),
    responses: responses.results,
    contracts: contracts.results,
    audit: audit.results,
  };
}

/** Direct contract-version D1 writes were retired. Even if an old caller reaches
 * this symbol, it cannot bypass the private serialized owner. All production
 * staff writes remain unavailable until the writer-only cutover is certified.
 */
export async function saveContractVersion(
  _db: CatalogDB,
  _actorUserId: string,
  _raw: unknown,
): Promise<never> {
  throw new ApiError(503, "Distribution contract changes require their canonical owner.");
}

export async function assignPublisherContract(db:CatalogDB,actorUserId:string,raw:unknown){
 return dispatchPrivatePartnerAction(db,"assign-contract",{actorUserId,raw});
}














































function normalizeIdentityText(v: string) {
  return v
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export async function rebuildWorkIdentityKeys(db: CatalogDB, limit = 1000) {
  const rows = (
    await db
      .prepare(
        `SELECT w.id,w.title,COALESCE((SELECT c.name FROM editions e JOIN edition_contributors ec ON ec.edition_id=e.id JOIN contributors c ON c.id=ec.contributor_id WHERE e.work_id=w.id AND ec.role='author' ORDER BY ec.position LIMIT 1),'') author,COALESCE(w.original_language,(SELECT e.language FROM editions e WHERE e.work_id=w.id ORDER BY e.created_at LIMIT 1),'en') language FROM works w WHERE NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author_language') OR NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author') ORDER BY w.created_at LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(5000, limit)))
      .all<any>()
  ).results;
  let created = 0,
    collisions = 0;
  const at = now();
  for (const r of rows) {
    const title = normalizeIdentityText(String(r.title || "")),
      author = normalizeIdentityText(String(r.author || "")),
      language = String(r.language || "en").toLowerCase(),
      keys = [
        {
          key: `wkey_${await sha256(`${title}|${author}|${language}`)}`,
          scheme: "title_author_language",
          confidence: 1,
        },
        {
          key: `wkeyta_${await sha256(`${title}|${author}`)}`,
          scheme: "title_author",
          confidence: 0.82,
        },
      ];
    for (const candidate of keys) {
      const existing = await db
        .prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?")
        .bind(candidate.key)
        .first<any>();
      if (existing && String(existing.work_id) !== String(r.id)) {
        collisions++;
        continue;
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          candidate.key,
          r.id,
          candidate.scheme,
          candidate.confidence,
          "catalog-rebuild",
          at,
          at,
        )
        .run();
      created++;
    }
  }
  const mappings = (
    await db
      .prepare(
        "SELECT account_id,catalog_work_id,work_reference,original_work_title,publishing_edition_id FROM publisher_catalog_mappings WHERE catalog_work_id IS NOT NULL AND (work_reference<>'' OR original_work_title<>'') ORDER BY updated_at DESC LIMIT ?",
      )
      .bind(Math.max(1, Math.min(5000, limit)))
      .all<any>()
  ).results;
  for (const m of mappings) {
    const edition = await db
        .prepare(
          `SELECT d.language,(SELECT display_name FROM publishing_edition_contributors c WHERE c.edition_id=d.id AND c.role='author' ORDER BY position LIMIT 1) author FROM publishing_edition_drafts d WHERE d.id=?`,
        )
        .bind(m.publishing_edition_id)
        .first<any>(),
      p: PartnerProduct = {
        productKey: "mapping",
        notificationType: "update",
        workReference: m.work_reference || undefined,
        originalWorkTitle: m.original_work_title || undefined,
        title: m.original_work_title || undefined,
        language: edition?.language || "en",
        contributors: edition?.author
          ? [{ name: String(edition.author), role: "author", position: 0 }]
          : [],
      };
    for (const candidate of await candidateWorkIdentityKeys(p)) {
      const existing = await db
        .prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?")
        .bind(candidate.key)
        .first<any>();
      if (existing && String(existing.work_id) !== String(m.catalog_work_id)) {
        collisions++;
        continue;
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          candidate.key,
          m.catalog_work_id,
          candidate.scheme,
          candidate.scheme === "external_work_reference" ? 1 : 0.82,
          `partner:${m.account_id}`,
          at,
          at,
        )
        .run();
      created++;
    }
  }
  return { scanned: rows.length, partnerMappings: mappings.length, created, collisions };
}

export async function reconcilePublicDomainWorks(db:CatalogDB,limit=250){
 return (await dispatchPrivatePartnerAction(db,"reconcile-public-domain",{limit})) as {groups:number;merged:number;canonicalized:number};
}














































































export async function editionDifferentiationDecision(
  db: CatalogDB,
  input: {
    editionId: string;
    editionType: string;
    rightsBasis: string;
    differentiationSummary: string;
    assetSha256?: string | null;
    translatorPresent?: boolean;
  },
) {
  const type = input.editionType || "original";
  if (input.rightsBasis !== "public_domain")
    return { allowed: true, reasonCode: "NOT_PUBLIC_DOMAIN", requiresReview: false };
  if (type === "canonical_public_domain")
    return { allowed: false, reasonCode: "CANONICAL_PUBLIC_DOMAIN_RESERVED", requiresReview: true };
  if (type === "original")
    return {
      allowed: false,
      reasonCode: "PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED",
      requiresReview: true,
    };
  if (!input.differentiationSummary.trim())
    return { allowed: false, reasonCode: "DIFFERENTIATION_SUMMARY_REQUIRED", requiresReview: true };
  if (type === "new_translation" && !input.translatorPresent)
    return { allowed: false, reasonCode: "TRANSLATOR_REQUIRED", requiresReview: true };
  if (input.assetSha256) {
    const identical = await db
      .prepare(
        `SELECT e.id,e.edition_type,e.canonical_public_domain FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND e.id<>? LIMIT 1`,
      )
      .bind(input.assetSha256, input.editionId)
      .first<any>();
    if (identical)
      return {
        allowed: false,
        reasonCode: "IDENTICAL_PUBLIC_DOMAIN_ASSET",
        requiresReview: true,
        matchedEditionId: String(identical.id),
      };
  }
  return {
    allowed: true,
    reasonCode: "DIFFERENTIATED_PUBLIC_DOMAIN_EDITION",
    requiresReview: false,
  };
}
