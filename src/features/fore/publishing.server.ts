/* eslint-disable prettier/prettier -- Publishing editor QA facades */ import JSZip from "jszip";
import { z } from "zod/v3";
import { ApiError } from "./service";
import {
  detectRightsConflicts,
  upsertRightsContract,
  upsertRightsGrant,
  upsertRightsParty,
} from "./rights.server";
import { runAutomatedPublishingReview } from "./moderation.server";
import {
  FORE_AI_POLICY_VERSION,
  FORE_RIGHTS_POLICY_VERSION,
  assessSubmissionContentPolicy,
  publisherRightsSnapshot,
  recordAssetFingerprint,
  scanAccountRiskLinks,
  scanIdentitySimilarity,
} from "./publishing-trust.server";
import { createRoyaltyContractVersion } from "./royalty-engine.server";
import { ensurePreorderReleasePlan } from "./preorder.server";
import {
  commercialAudioReadiness,
  commercialAudioSubmissionEvidence,
} from "./commercial-audio.server";
import { emitNotification } from "./notifications.server";
import { mirrorPublishingMalwareResult } from "./security.server";
import { assessPublisherRisk } from "./risk-tax.server";
import {
  hasPublicationOwner,
  dispatchPublicationActivation,
  dispatchPublicationPreorder,
  dispatchPublicationRecovery,
  dispatchPublicationMaterialization,
  dispatchPublishingOnboardingReview,
  dispatchPublishingOwnerValidationJob,dispatchPrivatePublishingEditor,
} from "../../storefront-strangler/publication-owner-routing.server";

export type PublishingDB = {
  prepare(sql: string): {
    bind(...values: unknown[]): ReturnType<PublishingDB["prepare"]>;
    first<T = any>(): Promise<T | null>;
    all<T = any>(): Promise<{ results: T[] }>;
    run(): Promise<any>;
  };
  batch(statements: any[]): Promise<unknown>;
};
export type PublishingEnv = {
  DB: PublishingDB;
  BUCKET?: {
    get(key: string, options?: any): Promise<any>;
    put(key: string, value: any, options?: any): Promise<any>;
    delete(key: string): Promise<void>;
  };
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?: string;
};

export async function recordPublicationActivation(
  db: PublishingDB,
  event: {
    lifecycleId: string;
    publicationVersionId: string;
    fromPublicationVersionId: string | null;
    activationType: "initial" | "update" | "schedule" | "rollback" | "staff";
    actorUserId?: string | null;
    reasonCode: string;
    metadata: unknown;
    at: string;
  },
) {
  await db
    .prepare(
      "INSERT INTO publishing_publication_activations(id,lifecycle_id,publication_version_id,from_publication_version_id,activation_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `pva_${crypto.randomUUID()}`,
      event.lifecycleId,
      event.publicationVersionId,
      event.fromPublicationVersionId,
      event.activationType,
      event.actorUserId || null,
      event.reasonCode,
      JSON.stringify(event.metadata),
      event.at,
    )
    .run();
}
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const isoOrNull = z.string().datetime().nullable().optional();
const roles = ["owner", "admin", "editor", "finance", "analyst"] as const;
type Role = (typeof roles)[number];
const roleRank: Record<Role, number> = { analyst: 1, editor: 2, finance: 2, admin: 3, owner: 4 };

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256Hex(bytes: Uint8Array | string) {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function safeJson<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text || "")) as T;
  } catch {
    return fallback;
  }
}
function cleanText(value: unknown, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

async function membership(db: PublishingDB, userId: string, accountId: string) {
  return db
    .prepare(
      "SELECT * FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'",
    )
    .bind(accountId, userId)
    .first<any>();
}
async function requireRole(db: PublishingDB, userId: string, accountId: string, minimum: Role) {
  const row = await membership(db, userId, accountId);
  if (!row || roleRank[row.role as Role] < roleRank[minimum])
    throw new ApiError(403, "You do not have permission to perform this publishing action.");
  return row;
}
async function editionAccess(
  db: PublishingDB,
  userId: string,
  editionId: string,
  minimum: Role = "analyst",
) {
  const row = await db
    .prepare(
      `SELECT e.*,t.account_id,t.title,t.subtitle,t.description,t.language title_language,t.audience,t.publisher_name,t.imprint_name,t.series_name,t.series_relationship,t.series_position,t.categories_json,t.keywords_json
    FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
    )
    .bind(editionId)
    .first<any>();
  if (!row) throw new ApiError(404, "Publishing edition not found.");
  await requireRole(db, userId, String(row.account_id), minimum);
  return row;
}
export async function audit(
  db: PublishingDB,
  accountId: string | null,
  actorUserId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await db
    .prepare(
      "INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("pubaudit"),
      accountId,
      actorUserId,
      entityType,
      entityId,
      action,
      JSON.stringify(metadata),
      now(),
    )
    .run();
}

export async function ensurePublishingLifecycle(db: PublishingDB, publishingEditionId: string) {
  let row = await db
    .prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?")
    .bind(publishingEditionId)
    .first<any>();
  if (row) return row;
  const edition = await db
    .prepare(
      `SELECT e.id,e.status,e.created_at,e.updated_at FROM publishing_edition_drafts e WHERE e.id=?`,
    )
    .bind(publishingEditionId)
    .first<any>();
  if (!edition) throw new ApiError(404, "Publishing edition not found.");
  const lifecycleId = id("lifecycle"),
    state =
      edition.status === "published"
        ? "live"
        : edition.status === "approved"
          ? "approved"
          : edition.status === "submitted"
            ? "human_review"
            : edition.status === "validating"
              ? "validation"
              : "draft",
    at = now();
  await db
    .prepare(
      "INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,state,owner_update_policy,live_at,created_at,updated_at) VALUES(?,?,?,'auto_update',?,?,?)",
    )
    .bind(
      lifecycleId,
      publishingEditionId,
      state,
      state === "live" ? at : null,
      edition.created_at || at,
      at,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'migration','lifecycle_created','{}',?)",
    )
    .bind(id("lifeevt"), lifecycleId, null, state, at)
    .run();
  row = await db
    .prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?")
    .bind(lifecycleId)
    .first<any>();
  return row;
}

const normalLifecycleTransitions: Record<string, Set<string>> = {
  draft: new Set(["draft", "validation", "submitted", "suppressed", "takedown", "retired"]),
  validation: new Set(["validation", "draft", "submitted", "suppressed", "takedown", "retired"]),
  submitted: new Set([
    "automated_review",
    "human_review",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  automated_review: new Set([
    "human_review",
    "approved",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  human_review: new Set([
    "human_review",
    "approved",
    "draft",
    "live",
    "updated",
    "retired",
    "suppressed",
    "takedown",
  ]),
  approved: new Set([
    "approved",
    "scheduled",
    "preorder",
    "live",
    "updated",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  scheduled: new Set([
    "scheduled",
    "preorder",
    "live",
    "updated",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  preorder: new Set(["preorder", "live", "updated", "draft", "suppressed", "takedown", "retired"]),
  live: new Set(["live", "updated", "draft", "suppressed", "takedown", "retired"]),
  updated: new Set(["updated", "draft", "suppressed", "takedown", "retired"]),
  suppressed: new Set(["suppressed"]),
  takedown: new Set(["takedown"]),
  retired: new Set(["retired"]),
};

async function transitionPublishingLifecycle(
  db: PublishingDB,
  publishingEditionId: string,
  toState: string,
  triggerType:
    "publisher" | "automation" | "staff" | "schedule" | "moderation" | "rollback" | "migration",
  actorUserId: string | null,
  reasonCode = "",
  metadata: Record<string, unknown> = {},
) {
  const lifecycle = await ensurePublishingLifecycle(db, publishingEditionId);
  const allowed = normalLifecycleTransitions[String(lifecycle.state)];
  if (
    triggerType !== "moderation" &&
    triggerType !== "migration" &&
    (!allowed || !allowed.has(toState))
  )
    throw new ApiError(
      409,
      `Invalid publishing lifecycle transition: ${lifecycle.state} → ${toState}.`,
    );
  const at = now(),
    timestampColumn =
      toState === "scheduled"
        ? "scheduled_at"
        : toState === "preorder"
          ? "preorder_at"
          : toState === "live" || toState === "updated"
            ? "live_at"
            : toState === "suppressed"
              ? "suppressed_at"
              : toState === "takedown"
                ? "takedown_at"
                : toState === "retired"
                  ? "retired_at"
                  : null;
  const sql = `UPDATE publishing_release_lifecycles SET state=?,state_reason=?,${timestampColumn ? `${timestampColumn}=COALESCE(${timestampColumn},?),` : ""}updated_at=? WHERE id=?`;
  await db
    .prepare(sql)
    .bind(
      ...(timestampColumn
        ? [toState, reasonCode, at, at, lifecycle.id]
        : [toState, reasonCode, at, lifecycle.id]),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("lifeevt"),
      lifecycle.id,
      lifecycle.state,
      toState,
      triggerType,
      actorUserId,
      reasonCode,
      JSON.stringify(metadata),
      at,
    )
    .run();
  return await db
    .prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?")
    .bind(lifecycle.id)
    .first<any>();
}

const accountSchema = z.object({
  id: z.string().max(180).optional(),
  accountType: z.enum(["person", "company"]).default("person"),
  legalName: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
  contactEmail: z.string().email().or(z.literal("")).default(""),
  website: z.string().url().or(z.literal("")).default(""),
  termsVersion: z.string().max(80).default("fore-publishing-v1"),
  acceptTerms: z.boolean().default(false),
});

export async function upsertPublishingAccount(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"account-save",{userId,raw});
}
















































































export async function savePublishingAddress(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      addressType: z.enum(["legal", "mailing", "tax"]),
      line1: z.string().trim().min(1).max(200),
      line2: z.string().max(200).default(""),
      city: z.string().trim().min(1).max(160),
      region: z.string().max(160).default(""),
      postalCode: z.string().max(40).default(""),
      countryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase()),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "admin");
  const at = now();
  const existing = await db
    .prepare("SELECT id FROM publishing_addresses WHERE account_id=? AND address_type=?")
    .bind(x.accountId, x.addressType)
    .first<any>();
  const addressId = existing?.id || id("pubaddr");
  await db
    .prepare(
      `INSERT INTO publishing_addresses(id,account_id,address_type,line1,line2,city,region,postal_code,country_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,address_type) DO UPDATE SET line1=excluded.line1,line2=excluded.line2,city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,country_code=excluded.country_code,updated_at=excluded.updated_at`,
    )
    .bind(
      addressId,
      x.accountId,
      x.addressType,
      x.line1,
      x.line2,
      x.city,
      x.region,
      x.postalCode,
      x.countryCode,
      at,
      at,
    )
    .run();
  await audit(db, x.accountId, userId, "address", addressId, "saved", {
    addressType: x.addressType,
  });
  return { id: addressId };
}

export async function savePenName(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      id: z.string().max(180).optional(),
      accountId: z.string().min(1),
      displayName: z.string().trim().min(1).max(220),
      sortName: z.string().max(220).default(""),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "editor");
  const penId = x.id || id("pen"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_pen_names(id,account_id,display_name,sort_name,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,sort_name=excluded.sort_name,updated_at=excluded.updated_at`,
    )
    .bind(penId, x.accountId, x.displayName, x.sortName, at, at)
    .run();
  const identityMatches = await scanIdentitySimilarity(db, {
    accountId: x.accountId,
    subjectType: "pen_name",
    subjectId: penId,
    name: x.displayName,
  });
  await audit(db, x.accountId, userId, "pen_name", penId, x.id ? "updated" : "created", {
    identitySimilarityMatches: identityMatches.length,
  });
  return { id: penId, identitySimilarityMatches: identityMatches.length };
}

export async function invitePublishingMember(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"member-invite",{userId,raw});
}





















export async function startIdentityVerification(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"identity-start",{userId,raw});
}







































export async function submitTaxProfile(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"tax-submit",{userId,raw});
}







































































export async function submitPayoutAccount(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"payout-submit",{userId,raw});
}































































const titleSchema = z.object({
  id: z.string().max(180).optional(),
  accountId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(300).default(""),
  description: z.string().max(20000).default(""),
  language: z.string().trim().min(2).max(35).default("en"),
  audience: z
    .enum(["children", "young_adult", "general", "academic", "professional"])
    .default("general"),
  publisherName: z.string().max(240).default(""),
  imprintName: z.string().max(240).default(""),
  seriesName: z.string().max(300).default(""),
  seriesRelationship: z
    .enum(["main", "prequel", "novella", "companion", "boxset", "related"])
    .default("main"),
  seriesPosition: z.number().nullable().optional(),
  categories: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export async function savePublishingTitle(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"title-save",{userId,raw});
}






























const territoryScopeSchema = z.object({
  mode: z.enum(["single", "set", "worldwide", "expression"]).default("worldwide"),
  territory: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  territorySetId: z.string().max(180).optional(),
  include: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(300)
    .default([]),
  exclude: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(300)
    .default([]),
  includeSetIds: z.array(z.string().max(180)).max(100).default([]),
  excludeSetIds: z.array(z.string().max(180)).max(100).default([]),
});
const editionSchema = z.object({
  id: z.string().max(180).optional(),
  titleId: z.string().min(1),
  format: z.enum(["ebook", "audiobook"]).default("ebook"),
  editionLabel: z.string().max(120).default(""),
  language: z.string().min(2).max(35).default("en"),
  isbn13: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .optional(),
  publisherIdentifier: z.string().max(120).default(""),
  rightsBasis: z.enum(["owned", "licensed", "public_domain"]).default("owned"),
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
  differentiationSummary: z.string().max(4000).default(""),
  contractId: z.string().max(180).nullable().optional(),
  contractVersionId: z.string().max(180).nullable().optional(),
  territoryScope: territoryScopeSchema.default({
    mode: "worldwide",
    include: [],
    exclude: [],
    includeSetIds: [],
    excludeSetIds: [],
  }),
  rightsStartAt: isoOrNull,
  rightsEndAt: isoOrNull,
  releaseDate: isoOrNull,
  preorderDate: isoOrNull,
  listCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .default("USD"),
  listPriceMinor: z.number().int().min(0).max(100000000).default(0),
  drmRequirement: z.enum(["none", "watermark", "lcp", "adobe_acs"]).default("none"),
  downloadable: z.boolean().default(true),
  subscriptionPermitted: z.boolean().default(false),
  libraryPermitted: z.boolean().default(false),
  salesChannels: z
    .array(z.enum(["retail", "subscription", "library"]))
    .min(1)
    .max(3)
    .default(["retail"]),
  contributors: z
    .array(
      z.object({
        penNameId: z.string().max(180).nullable().optional(),
        displayName: z.string().trim().min(1).max(220),
        role: z.enum(["author", "editor", "translator", "illustrator", "narrator", "other"]),
        position: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .max(50)
    .default([]),
});
export async function savePublishingEdition(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"edition-save",{userId,raw});
}

































































































































function publishingChecks(kind: string, format: string) {
  if (kind === "cover")
    return [
      ["malware", true, "external"],
      ["cover", true, "inline"],
      ["images", true, "inline"],
      ["render", true, "external"],
      ["duplicate", false, "inline"],
    ] as const;
  if (kind === "manuscript" && format === "ebook")
    return [
      ["malware", true, "external"],
      ["archive_safety", true, "inline"],
      ["epubcheck", true, "external"],
      ["metadata", true, "inline"],
      ["images", false, "inline"],
      ["navigation", true, "inline"],
      ["links", true, "inline"],
      ["fonts", false, "inline"],
      ["fixed_layout", false, "inline"],
      ["accessibility", false, "inline"],
      ["render", true, "external"],
      ["device_compatibility", true, "external"],
      ["duplicate", true, "inline"],
    ] as const;
  if (kind === "audio")
    return [
      ["malware", true, "external"],
      ["audio_integrity", true, "external"],
      ["duplicate", true, "inline"],
    ] as const;
  return [
    ["malware", true, "external"],
    ["duplicate", false, "inline"],
  ] as const;
}

function imageDimensions(bytes: Uint8Array, mime: string) {
  if (
    mime === "image/png" &&
    bytes.length >= 24 &&
    String.fromCharCode(...bytes.slice(1, 4)) === "PNG"
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if ((mime === "image/jpeg" || mime === "image/jpg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = bytes[p + 1],
        len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      )
        return {
          height: (bytes[p + 5] << 8) | bytes[p + 6],
          width: (bytes[p + 7] << 8) | bytes[p + 8],
        };
      if (len < 2) break;
      p += 2 + len;
    }
  }
  return null;
}

async function inspectEpub(bytes: Uint8Array) {
  const issues: { code: string; severity: "warning" | "error"; message: string }[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ApiError(400, "The manuscript is not a readable EPUB archive.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > 10000)
    throw new ApiError(413, "The EPUB contains too many archive entries.");
  let expanded = 0;
  for (const f of entries) expanded += Number((f as any)._data?.uncompressedSize || 0);
  if (expanded > 500 * 1024 * 1024 || (bytes.byteLength && expanded / bytes.byteLength > 120))
    throw new ApiError(413, "The EPUB expands beyond Cove's archive-safety limits.");
  const mimetype = await zip.file("mimetype")?.async("string");
  if (mimetype?.trim() !== "application/epub+zip")
    issues.push({
      code: "MIMETYPE",
      severity: "error",
      message: "EPUB mimetype entry is missing or invalid.",
    });
  if (zip.file("META-INF/encryption.xml"))
    issues.push({
      code: "ENCRYPTED",
      severity: "error",
      message: "Encrypted/DRM EPUB uploads are not accepted as source manuscripts.",
    });
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const rootfile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootfile)
    issues.push({ code: "CONTAINER", severity: "error", message: "EPUB package path is missing." });
  const opf = (rootfile ? await zip.file(rootfile)?.async("string") : "") || "";
  if (!opf)
    issues.push({ code: "OPF", severity: "error", message: "EPUB package document is missing." });
  const cleanText = (v: string) =>
    v
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  const metaValues = (property: string) =>
    Array.from(
      opf.matchAll(
        new RegExp(
          `<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<\\/meta>|<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']*)["'][^>]*\\/?\\s*>`,
          "gi",
        ),
      ),
    )
      .map((m) => cleanText(m[1] || m[2] || ""))
      .filter(Boolean);
  const title = cleanText(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || "");
  const language = cleanText(opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1] || "");
  const packageVersion = opf.match(/<package\b[^>]*\bversion=["']([^"']+)["']/i)?.[1] || "";
  if (!title)
    issues.push({
      code: "METADATA_TITLE",
      severity: "error",
      message: "EPUB metadata has no title.",
    });
  if (!language)
    issues.push({
      code: "METADATA_LANGUAGE",
      severity: "warning",
      message: "EPUB metadata has no primary language.",
    });
  const hasNav = /properties\s*=\s*["'][^"']*\bnav\b/i.test(opf),
    hasNcx = /media-type\s*=\s*["']application\/x-dtbncx\+xml/i.test(opf);
  if (!hasNav && !hasNcx)
    issues.push({
      code: "NAV",
      severity: "error",
      message: "EPUB has no navigation document or NCX.",
    });
  const renditionLayout =
      metaValues("rendition:layout")[0] ||
      (/name=["']fixed-layout["'][^>]+content=["']true["']/i.test(opf)
        ? "pre-paginated"
        : "reflowable"),
    fixed = renditionLayout === "pre-paginated";
  const pageProgression = (
    opf.match(/page-progression-direction=["'](ltr|rtl|default)["']/i)?.[1] ||
    metaValues("page-progression-direction")[0] ||
    "default"
  ).toLowerCase();
  const primaryWritingMode = (
    metaValues("primary-writing-mode")[0] ||
    metaValues("rendition:orientation")[0] ||
    "horizontal-tb"
  ).toLowerCase();
  const accessModes = [
    ...new Set(metaValues("schema:accessMode").concat(metaValues("accessMode"))),
  ];
  const accessibilityFeatures = [
    ...new Set(
      metaValues("schema:accessibilityFeature").concat(metaValues("accessibilityFeature")),
    ),
  ];
  const accessibilityHazards = [
    ...new Set(metaValues("schema:accessibilityHazard").concat(metaValues("accessibilityHazard"))),
  ];
  const accessModeSufficient = [
    ...new Set(
      metaValues("schema:accessModeSufficient").concat(metaValues("accessModeSufficient")),
    ),
  ];
  const accessibilitySummary =
    metaValues("schema:accessibilitySummary")[0] || metaValues("accessibilitySummary")[0] || "";
  const conformsTo = [
    ...new Set(metaValues("dcterms:conformsTo").concat(metaValues("schema:conformsTo"))),
  ];
  const certifier = metaValues("a11y:certifiedBy")[0] || metaValues("schema:certifiedBy")[0] || "";
  const certifierCredential = metaValues("a11y:certifierCredential")[0] || "",
    certifierReport = metaValues("a11y:certifierReport")[0] || "",
    certificationDate = metaValues("dcterms:modified")[0] || "";
  const fonts = entries.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f.name)).map((f) => f.name);
  const cssFiles = entries.filter((f) => /\.css$/i.test(f.name) && !f.dir).slice(0, 250);
  let cssText = "";
  for (const f of cssFiles) {
    if (cssText.length > 750000) break;
    cssText += (await f.async("string")).slice(0, 100000);
  }
  const htmlFiles = entries
    .filter((f) => /\.(xhtml|html|htm)$/i.test(f.name) && !f.dir)
    .slice(0, 1200);
  let broken = 0,
    images = 0,
    missingAlt = 0,
    emptyAlt = 0,
    headings = 0,
    headingJumps = 0,
    tables = 0,
    tablesWithoutHeaders = 0,
    mathml = 0,
    svg = 0,
    svgMissingTextAlternative = 0,
    footnotes = 0,
    endnotes = 0,
    pagebreaks = 0,
    langNodes = 0,
    remoteResources = 0,
    scriptedContent = 0,
    fingerprintTextSize = 0;
  const fingerprintTextParts: string[] = [];
  let previousHeading = 0,
    oversizedImages = false;
  const normalize = (base: string, ref: string) => {
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(ref)) return null;
    const clean = ref.split("#")[0].split("?")[0];
    if (!clean) return null;
    const stack = base.split("/").slice(0, -1);
    for (const part of clean.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(decodeURIComponent(part));
    }
    return stack.join("/");
  };
  for (const file of htmlFiles) {
    const text = await file.async("string");
    if (fingerprintTextSize < 500000) {
      const chunk = text.slice(0, Math.min(50000, 500000 - fingerprintTextSize));
      fingerprintTextParts.push(chunk);
      fingerprintTextSize += chunk.length;
    }
    for (const m of text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const p = normalize(file.name, m[1]);
      if (p && !zip.file(p)) broken++;
    }
    for (const m of text.matchAll(
      /<(img|audio|video|source|link|iframe|object|embed|image)\b[^>]*(?:src|href|xlink:href)\s*=\s*["']([^"']+)["'][^>]*>/gi,
    ))
      if (/^(?:https?:)?\/\//i.test(m[2])) remoteResources++;
    scriptedContent += (text.match(/<script\b/gi) || []).length;
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
      images++;
      const tag = m[0],
        alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
      if (!alt) missingAlt++;
      else if (!alt[1].trim()) emptyAlt++;
      const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0),
        h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || 0);
      if (w > 5000 || h > 5000) oversizedImages = true;
    }
    for (const m of text.matchAll(/<h([1-6])\b/gi)) {
      const level = Number(m[1]);
      headings++;
      if (previousHeading && level > previousHeading + 1) headingJumps++;
      previousHeading = level;
    }
    for (const m of text.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
      tables++;
      if (!/<th\b/i.test(m[0])) tablesWithoutHeaders++;
    }
    mathml += (text.match(/<math\b/gi) || []).length;
    svg += (text.match(/<svg\b/gi) || []).length;
    for (const m of text.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      const node = m[0];
      if (
        !/aria-hidden\s*=\s*["']true["']/i.test(node) &&
        !/(?:aria-label|aria-labelledby)\s*=/i.test(node) &&
        !/<(?:title|desc)\b/i.test(node)
      )
        svgMissingTextAlternative++;
    }
    footnotes += (text.match(/epub:type=["'][^"']*\bfootnote\b/gi) || []).length;
    endnotes += (text.match(/epub:type=["'][^"']*\bendnote\b/gi) || []).length;
    pagebreaks += (text.match(/epub:type=["'][^"']*\bpagebreak\b/gi) || []).length;
    langNodes += (text.match(/(?:xml:lang|\blang)=["'][^"']+["']/gi) || []).length;
  }
  remoteResources +=
    (cssText.match(/url\(\s*["']?(?:https?:)?\/\//gi) || []).length +
    (cssText.match(/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//gi) || []).length;
  const mediaOverlays = /media-overlay\s*=/i.test(opf),
    dictionaryContent =
      /<dc:type[^>]*>\s*dictionary\s*<\/dc:type>/i.test(opf) ||
      /epub:type=["'][^"']*\bdictionary\b/i.test(fingerprintTextParts.join("\n"));
  const verticalWriting =
      /writing-mode\s*:\s*(vertical|tb-|sideways)/i.test(cssText) ||
      /^vertical/.test(primaryWritingMode),
    rtl = pageProgression === "rtl" || /direction\s*:\s*rtl/i.test(cssText);
  const complexCss =
    /(position\s*:\s*(absolute|fixed)|transform\s*:|columns?\s*:|float\s*:|writing-mode\s*:|shape-outside\s*:)/i.test(
      cssText,
    );
  if (broken)
    issues.push({
      code: "BROKEN_LINKS",
      severity: "error",
      message: `${broken} internal EPUB references could not be resolved.`,
    });
  if (remoteResources)
    issues.push({
      code: "REMOTE_RESOURCES",
      severity: "error",
      message: `${remoteResources} remote resource reference${remoteResources === 1 ? "" : "s"} would require network access while reading. Package required assets inside the EPUB.`,
    });
  if (scriptedContent)
    issues.push({
      code: "SCRIPTED_CONTENT",
      severity: "error",
      message: `${scriptedContent} scripted content reference${scriptedContent === 1 ? "" : "s"} detected. Cove strips executable EPUB scripting for reader security; publish a non-scripted fallback edition.`,
    });
  if (missingAlt)
    issues.push({
      code: "MISSING_ALT",
      severity: "warning",
      message: `${missingAlt} images do not declare alt text.`,
    });
  if (svgMissingTextAlternative)
    issues.push({
      code: "SVG_TEXT_ALTERNATIVE",
      severity: "warning",
      message: `${svgMissingTextAlternative} inline SVG graphic${svgMissingTextAlternative === 1 ? "" : "s"} lack a title, description, ARIA label, or explicit decorative marker.`,
    });
  if (!headings && htmlFiles.length > 1)
    issues.push({
      code: "HEADING_STRUCTURE",
      severity: "warning",
      message: "No semantic heading elements were detected across the EPUB content documents.",
    });
  if (headingJumps)
    issues.push({
      code: "HEADING_STRUCTURE",
      severity: "warning",
      message: `${headingJumps} heading transitions skip a semantic level.`,
    });
  if (tablesWithoutHeaders)
    issues.push({
      code: "TABLE_SEMANTICS",
      severity: "warning",
      message: `${tablesWithoutHeaders} tables do not contain header cells.`,
    });
  const claimedConformance = conformsTo.some((v) => /EPUB Accessibility|wcag/i.test(v));
  const requiredAccessibilityMetadata =
    accessModes.length > 0 && accessibilityFeatures.length > 0 && accessibilityHazards.length > 0;
  if (!requiredAccessibilityMetadata)
    issues.push({
      code: "ACCESSIBILITY_METADATA",
      severity: claimedConformance ? "error" : "warning",
      message:
        "EPUB accessibility discoverability metadata is incomplete (accessMode, accessibilityFeature, accessibilityHazard).",
    });
  if (claimedConformance && (missingAlt || headingJumps || tablesWithoutHeaders || !language))
    issues.push({
      code: "ACCESSIBILITY_CONFORMANCE_MISMATCH",
      severity: "error",
      message:
        "The EPUB claims accessibility conformance but Cove detected unresolved structural/accessibility issues.",
    });
  const altTextComplete = missingAlt === 0 && svgMissingTextAlternative === 0,
    semanticStructure = headings > 0 && headingJumps === 0,
    tableSemantics = tablesWithoutHeaders === 0;
  const mathmlDeclaredAccessible =
    mathml > 0 && accessibilityFeatures.some((v) => /^mathml$/i.test(v.trim()));
  if (mathml > 0 && !mathmlDeclaredAccessible)
    issues.push({
      code: "MATHML_DISCLOSURE",
      severity: "warning",
      message:
        "MathML is present, but the EPUB accessibility metadata does not declare the MathML accessibility feature.",
    });
  const nonvisualReading =
    fixed && images > 0 && !altTextComplete
      ? "not_supported"
      : altTextComplete && semanticStructure && !!language
        ? "supported"
        : "partial";
  const visualAdjustments = fixed ? "not_supported" : "supported";
  const validationStatus = issues.some((i) => i.severity === "error")
    ? "failed"
    : issues.length
      ? "warning"
      : "passed";
  const accessibility = {
    visualAdjustments,
    nonvisualReading,
    primaryLanguageDeclared: !!language,
    readingOrderVerified: (hasNav || hasNcx) && broken === 0,
    altTextComplete,
    semanticStructure,
    tableSemanticsComplete: tableSemantics,
    mathmlPresent: mathml > 0,
    mathmlAccessible: mathmlDeclaredAccessible,
    accessibilityNavigation: hasNav,
    pageNavigation: pagebreaks > 0,
    accessModes,
    accessModeSufficient,
    features: accessibilityFeatures,
    hazards: accessibilityHazards,
    conformsTo,
    summary: accessibilitySummary,
    certification: {
      certifier,
      credential: certifierCredential,
      report: certifierReport,
      date: certificationDate,
    },
    validationPolicyVersion: "fore-epub-accessibility-v1",
    validationStatus,
  };
  const compatibilityClass:
    | "reflowable_standard"
    | "reflowable_complex"
    | "fixed_layout"
    | "comic_manga"
    | "picture_book"
    | "dictionary"
    | "unknown" = dictionaryContent
    ? "dictionary"
    : fixed
      ? images > Math.max(8, htmlFiles.length / 2)
        ? "comic_manga"
        : "fixed_layout"
      : complexCss || verticalWriting
        ? "reflowable_complex"
        : "reflowable_standard";
  const warnings: string[] = [];
  if (fixed)
    warnings.push(
      "Fixed-layout content does not support Cove text-size or line-spacing overrides.",
    );
  if (verticalWriting)
    warnings.push("Vertical writing relies on publisher CSS and may vary by browser engine.");
  if (mediaOverlays)
    warnings.push(
      "Embedded EPUB media overlays are detected but Cove uses its separate audiobook/Biosync system for synchronized audio.",
    );
  if (oversizedImages) warnings.push("Oversized images are scaled in reflowable reading mode.");
  if (dictionaryContent)
    warnings.push(
      "Dictionary semantics are preserved, but Cove does not yet provide a dedicated dictionary lookup/navigation mode.",
    );
  if (complexCss)
    warnings.push(
      "Complex publisher CSS is preserved where safe and may render differently across browser engines.",
    );
  if (remoteResources)
    warnings.push(
      "Remote resource dependencies are not supported for commercial publication or offline reading.",
    );
  if (scriptedContent)
    warnings.push("Executable EPUB scripting is not supported and is stripped by the Cove reader.");
  const readerSupport =
    remoteResources || scriptedContent
      ? "unsupported"
      : mediaOverlays || fixed || verticalWriting || dictionaryContent || complexCss
        ? "supported_with_limits"
        : "full";
  const formatProfile = {
    epubVersion: packageVersion.startsWith("2")
      ? "EPUB 2"
      : packageVersion.startsWith("3")
        ? "EPUB 3"
        : "EPUB",
    packageVersion,
    navigationType: hasNav && hasNcx ? "both" : hasNav ? "epub3_nav" : hasNcx ? "ncx" : "unknown",
    renditionLayout,
    pageProgressionDirection: pageProgression,
    writingMode: verticalWriting
      ? primaryWritingMode.startsWith("vertical")
        ? primaryWritingMode
        : "vertical-rl"
      : "horizontal-tb",
    rtl,
    verticalWriting,
    complexCss,
    embeddedFonts: fonts.length > 0,
    svg: svg > 0,
    mathml: mathml > 0,
    complexTables: tables > 0,
    footnotes: footnotes > 0,
    endnotes: endnotes > 0,
    dictionaryContent,
    mediaOverlays,
    oversizedImages,
    accessibilityNavigation: hasNav,
    compatibilityClass,
    readerSupport,
    features: {
      fontCount: fonts.length,
      imageCount: images,
      htmlFileCount: htmlFiles.length,
      tableCount: tables,
      mathmlCount: mathml,
      svgCount: svg,
      svgMissingTextAlternativeCount: svgMissingTextAlternative,
      footnoteCount: footnotes,
      endnoteCount: endnotes,
      pagebreakCount: pagebreaks,
      langNodeCount: langNodes,
      remoteResourceCount: remoteResources,
      scriptedContentCount: scriptedContent,
    },
    warnings,
  };
  return {
    zip,
    expandedBytes: expanded,
    metadata: {
      title,
      language,
      packageVersion,
      fixedLayout: fixed,
      accessibilityMetadata: requiredAccessibilityMetadata,
      fontCount: fonts.length,
      imageCount: images,
      brokenInternalReferences: broken,
      missingAlt,
      emptyAlt,
      accessibility,
      formatProfile,
    },
    fingerprintText: fingerprintTextParts.join("\n").slice(0, 500000),
    issues,
  };
}

export async function readBoundedPublishingUpload(request: Request, limit: number) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}
export function publishingUploadLimit(kind: string) {
  return kind === "audio"
    ? 750 * 1024 * 1024
    : kind === "manuscript"
      ? 150 * 1024 * 1024
      : kind === "cover"
        ? 25 * 1024 * 1024
        : 100 * 1024 * 1024;
}

async function recordInlineResult(
  db: PublishingDB,
  jobId: string,
  versionId: string,
  check: string,
  status: "passed" | "warning" | "failed" | "blocked",
  issues: any[] = [],
  validator = "fore-inline",
  version = "1",
) {
  const at = now();
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_validation_jobs SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?",
      )
      .bind(
        status,
        status === "failed" || status === "blocked"
          ? cleanText(issues[0]?.message || "Validation failed", 1000)
          : "",
        at,
        jobId,
      ),
    db
      .prepare(
        "INSERT INTO publishing_validation_results(id,job_id,asset_version_id,check_type,validator_name,validator_version,status,issue_count,issues_json,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pubval"),
        jobId,
        versionId,
        check,
        validator,
        version,
        status,
        issues.length,
        JSON.stringify(issues),
        at,
      ),
  ]);
}

async function refreshAssetValidationSummary(db: PublishingDB, assetVersionId: string) {
  const jobs = (
    await db
      .prepare("SELECT status,required FROM publishing_validation_jobs WHERE asset_version_id=?")
      .bind(assetVersionId)
      .all<any>()
  ).results;
  const required = jobs.filter((j) => Number(j.required) === 1);
  let summary = "pending",
    quarantine = "quarantined";
  if (required.some((j) => ["failed", "blocked"].includes(String(j.status))))
    ((summary = "blocked"), (quarantine = "rejected"));
  else if (required.some((j) => ["queued", "leased"].includes(String(j.status))))
    ((summary = required.some((j) => String(j.status) === "leased") ? "running" : "pending"),
      (quarantine = "scanning"));
  else if (required.every((j) => String(j.status) === "passed")) {
    summary = jobs.some((j) => String(j.status) === "warning") ? "warning" : "passed";
    quarantine = "clean";
  } else summary = "blocked";
  await db
    .prepare(
      "UPDATE publishing_asset_versions SET validation_summary=?,quarantine_status=? WHERE id=?",
    )
    .bind(summary, quarantine, assetVersionId)
    .run();
  return { summary, quarantine };
}

export async function uploadPublishingAsset(env:PublishingEnv,userId:string,input:{editionId:string;kind:string;filename:string;mimeType:string;bytes:Uint8Array}){
if(!(input.bytes instanceof Uint8Array)||input.bytes.byteLength>65536)throw new ApiError(503,"Publishing asset upload requires private storage attestation.");
return dispatchPrivatePublishingEditor(env.DB,"asset-upload",{userId,raw:{...input,bytes:Array.from(input.bytes)}});
}





































































































































































































































































































export async function signPublishingAccessibilityDeclaration(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"accessibility-sign",{userId,raw});
}






















































































export async function leasePublishingValidationJobs(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "lease-validation", raw);
}

export async function completePublishingValidationJob(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "complete-validation", raw);
}

async function assetStatus(db: PublishingDB, editionId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT a.id,a.kind,a.required,a.current_version_id,v.quarantine_status,v.validation_summary,v.sha256,v.object_key,v.mime_type,v.size_bytes,v.original_filename
    FROM publishing_assets a LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE a.edition_id=? ORDER BY a.kind`,
      )
      .bind(editionId)
      .all<any>()
  ).results;
  return rows;
}

export async function publishingReadiness(db: PublishingDB, userId: string, editionId: string) {
  const edition = await editionAccess(db, userId, editionId, "analyst"),
    account = await db
      .prepare("SELECT * FROM publishing_accounts WHERE id=?")
      .bind(edition.account_id)
      .first<any>();
  const contributors = (
      await db
        .prepare(
          "SELECT * FROM publishing_edition_contributors WHERE edition_id=? ORDER BY position",
        )
        .bind(editionId)
        .all<any>()
    ).results,
    assets = await assetStatus(db, editionId);
  const blockers: string[] = [];
  if (!account?.terms_accepted_at) blockers.push("Accept the current Cove Publishing agreement.");
  const legalAddress = await db
    .prepare(
      "SELECT id FROM publishing_addresses WHERE account_id=? AND address_type='legal' LIMIT 1",
    )
    .bind(edition.account_id)
    .first<any>();
  if (!legalAddress) blockers.push("Add a legal business/residential address.");
  if (account?.identity_status !== "verified")
    blockers.push("Identity verification must be complete.");
  if (account?.tax_status !== "verified") blockers.push("Tax information must be validated.");
  if (account?.payout_status !== "verified") blockers.push("A verified payout method is required.");
  if (!contributors.some((c) => c.role === "author"))
    blockers.push("Add at least one author/contributor.");
  if (!edition.description?.trim()) blockers.push("Add a book description.");
  if (Number(edition.list_price_minor) < 0) blockers.push("Set a valid list price.");
  if (edition.format === "ebook" && !assets.some((a) => a.kind === "manuscript"))
    blockers.push("Upload an EPUB manuscript.");
  if (!assets.some((a) => a.kind === "cover")) blockers.push("Upload cover artwork.");
  for (const a of assets.filter((a) => Number(a.required) === 1))
    if (a.validation_summary !== "passed" && a.validation_summary !== "warning")
      blockers.push(`${a.kind} validation is not complete.`);
  const openRequired =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND j.required=1 AND j.status<>'passed'`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(openRequired) > 0)
    blockers.push(
      `${openRequired} required validation check${Number(openRequired) === 1 ? " is" : "s are"} still unresolved.`,
    );
  const duplicateReview =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND d.disposition IN ('review','fraud_hold')`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(duplicateReview) > 0) blockers.push("Potential duplicate content requires review.");
  const declaration = await db
    .prepare("SELECT * FROM publishing_rights_declarations WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  if (!declaration) blockers.push("Sign the Cove publisher rights declaration for this revision.");
  else {
    if (String(declaration.policy_version) !== FORE_RIGHTS_POLICY_VERSION)
      blockers.push(
        `Re-sign the publisher rights declaration under the current ${FORE_RIGHTS_POLICY_VERSION} policy.`,
      );
    if (
      !Number(declaration.authority_attestation) ||
      !Number(declaration.no_infringement_attestation) ||
      !Number(declaration.evidence_complete_attestation)
    )
      blockers.push("The rights declaration attestations are incomplete.");
    const evidence = (
      await db
        .prepare("SELECT * FROM publishing_rights_evidence WHERE declaration_id=?")
        .bind(declaration.id)
        .all<any>()
    ).results;
    if (
      ["licensed", "public_domain"].includes(String(declaration.rights_basis)) &&
      !evidence.length
    )
      blockers.push("Upload rights evidence for licensed or public-domain material.");
    if (evidence.some((r: any) => !["clean"].includes(String(r.scan_status))))
      blockers.push("Rights evidence scanning must complete before submission.");
    if (evidence.some((r: any) => r.verification_status === "rejected"))
      blockers.push("Rejected rights evidence must be resolved before submission.");
    if (
      ["licensed", "public_domain"].includes(String(declaration.rights_basis)) &&
      !evidence.some((r: any) => r.verification_status === "verified")
    )
      blockers.push(
        "Licensed or public-domain material requires at least one staff-verified rights evidence record before submission.",
      );
  }
  const aiDisclosure = await db
    .prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  if (!aiDisclosure)
    blockers.push(
      "Sign the Cove AI-content disclosure for this revision, including fully human-created works.",
    );
  else {
    if (String(aiDisclosure.policy_version) !== FORE_AI_POLICY_VERSION)
      blockers.push(
        `Re-sign the AI-content disclosure under the current ${FORE_AI_POLICY_VERSION} policy.`,
      );
    if (
      edition.format === "audiobook" &&
      ["ai_generated", "mixed"].includes(String(aiDisclosure.narration_origin)) &&
      !String(aiDisclosure.synthetic_voice_label || "").trim()
    )
      blockers.push(
        "Synthetic or mixed AI narration requires a customer-facing synthetic voice label.",
      );
  }
  let accessibilityDeclaration: any = null;
  if (String(edition.format) === "ebook") {
    const manuscript = assets.find((a: any) => a.kind === "manuscript");
    accessibilityDeclaration = await db
      .prepare(
        "SELECT * FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?",
      )
      .bind(editionId, edition.revision)
      .first<any>();
    if (!accessibilityDeclaration)
      blockers.push(
        "Sign the Cove EPUB accessibility declaration for this revision, including editions with no formal conformance claim.",
      );
    else {
      if (String(accessibilityDeclaration.policy_version) !== "fore-epub-accessibility-v1")
        blockers.push(
          "Re-sign the EPUB accessibility declaration under the current Cove accessibility policy.",
        );
      const declaration = safeJson<any>(accessibilityDeclaration.declaration_json, {});
      if (
        !manuscript?.current_version_id ||
        String(declaration.sourceAssetVersionId || "") !==
          String(manuscript.current_version_id || "")
      )
        blockers.push(
          "The accessibility declaration is bound to an older manuscript. Open a new revision and sign against the current EPUB.",
        );
      const inspection = manuscript?.current_version_id
        ? await db
            .prepare(
              "SELECT accessibility_json FROM publishing_epub_inspections WHERE asset_version_id=?",
            )
            .bind(manuscript.current_version_id)
            .first<any>()
        : null;
      const detected = safeJson<any>(inspection?.accessibility_json, {});
      if (declaration?.publisher?.claimsConformance && detected.validationStatus === "failed")
        blockers.push(
          "The current EPUB fails Cove accessibility validation and cannot retain a formal conformance claim.",
        );
    }
  }
  if (String(edition.rights_basis) === "public_domain") {
    const et = String(edition.edition_type || "original"),
      summary = String(edition.differentiation_summary || "").trim();
    if (["original", "canonical_public_domain"].includes(et))
      blockers.push(
        "Public-domain submissions must be a differentiated annotated, translated, illustrated, scholarly, or commercial-audiobook edition. Cove reserves the canonical free edition for its canonical public-domain source.",
      );
    if (!summary)
      blockers.push("Describe the substantive differentiation in this public-domain edition.");
    if (et === "new_translation" && !contributors.some((c) => c.role === "translator"))
      blockers.push("A new translation edition must identify at least one translator.");
    const manuscript = assets.find((a: any) => a.kind === "manuscript");
    if (manuscript?.sha256) {
      const duplicate = await db
        .prepare(
          `SELECT e.id FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND (? IS NULL OR e.id<>?) LIMIT 1`,
        )
        .bind(
          manuscript.sha256,
          edition.catalog_edition_id || null,
          edition.catalog_edition_id || null,
        )
        .first<any>();
      if (duplicate)
        blockers.push(
          "This public-domain EPUB is byte-identical to an existing edition. Commercial public-domain editions must add substantive differentiation rather than duplicate the canonical free copy.",
        );
    }
  }
  const partner = await db
    .prepare(
      "SELECT production_status,default_contract_id FROM publisher_partner_profiles WHERE account_id=?",
    )
    .bind(edition.account_id)
    .first<any>();
  if (partner && String(partner.production_status) === "active") {
    if (!edition.contract_id)
      blockers.push(
        "Production partner titles must be governed by an assigned distribution contract; per-book flags cannot substitute for contract policy.",
      );
    if (edition.contract_id) {
      const assigned = await db
        .prepare(
          "SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'",
        )
        .bind(edition.account_id, edition.contract_id)
        .first<any>();
      if (!assigned)
        blockers.push(
          "The selected distribution contract is not actively assigned to this publisher.",
        );
    }
    if (edition.contract_version_id) {
      const active = await db
        .prepare(
          "SELECT 1 ok FROM rights_contract_versions WHERE id=? AND contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)",
        )
        .bind(edition.contract_version_id, edition.contract_id, now(), now())
        .first<any>();
      if (!active)
        blockers.push("The selected distribution contract version is not currently effective.");
    }
  }
  const similarityReview =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND sm.cross_account=1 AND sm.disposition IN ('review','fraud_hold') AND sm.score>=.95`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(similarityReview) > 0)
    blockers.push("High-confidence cross-publisher content similarity requires review.");
  let commercialAudio: any = null;
  if (String(edition.format) === "audiobook") {
    commercialAudio = await commercialAudioReadiness(db as any, editionId);
    blockers.push(...commercialAudio.blockers);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    account: {
      identityStatus: account?.identity_status,
      taxStatus: account?.tax_status,
      payoutStatus: account?.payout_status,
      termsAccepted: !!account?.terms_accepted_at,
    },
    assets,
    contributors,
    rightsDeclaration: declaration
      ? { id: declaration.id, status: declaration.status, rightsBasis: declaration.rights_basis }
      : null,
    aiDisclosure: aiDisclosure
      ? {
          id: aiDisclosure.id,
          policyVersion: aiDisclosure.policy_version,
          textOrigin: aiDisclosure.text_origin,
          coverOrigin: aiDisclosure.cover_origin,
          narrationOrigin: aiDisclosure.narration_origin,
        }
      : null,
    accessibilityDeclaration: accessibilityDeclaration
      ? {
          policyVersion: accessibilityDeclaration.policy_version,
          revision: Number(accessibilityDeclaration.revision || 0),
          createdAt: accessibilityDeclaration.created_at,
        }
      : null,
    commercialAudio,
  };
}

export async function submitPublishingEdition(env:PublishingEnv,userId:string,editionId:string){
return dispatchPrivatePublishingEditor(env.DB,"edition-submit",{userId,editionId});
}




















































































































































































































































































































export async function openPublishingRevision(db:PublishingDB,userId:string,editionId:string){
return dispatchPrivatePublishingEditor(db,"revision-open",{userId,editionId});
}














































export async function setPublishingUpdatePolicy(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"update-policy",{userId,raw});
}










































































export async function optInOwnedPublicationUpdate(db:PublishingDB,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(db,"owner-optin",{userId,raw});
}
















































export function scopeToGrant(scope: any) {
  const mode = scope?.mode || "worldwide";
  if (mode === "single")
    return {
      scopeMode: "single" as const,
      territory: String(scope.territory || "US").toUpperCase(),
    };
  if (mode === "set")
    return { scopeMode: "set" as const, territorySetId: String(scope.territorySetId || "WORLD") };
  if (mode === "expression")
    return {
      scopeMode: "expression" as const,
      includeTerritories: (scope.include || []).map((x: string) => x.toUpperCase()),
      excludeTerritories: (scope.exclude || []).map((x: string) => x.toUpperCase()),
      includeSetIds: scope.includeSetIds || [],
      excludeSetIds: scope.excludeSetIds || [],
    };
  return {
    scopeMode: "worldwide" as const,
    excludeTerritories: (scope.exclude || []).map((x: string) => x.toUpperCase()),
  };
}
export async function bucketBytes(env: PublishingEnv, key: string) {
  const obj = await env.BUCKET?.get(key);
  if (!obj) throw new ApiError(503, "A publication asset is missing from storage.");
  return new Uint8Array(await new Response(obj.body).arrayBuffer());
}

export async function ensureCatalogParties(db: PublishingDB, account: any, tax: any, payout: any) {
  const at = now();
  let publisherId = account.publisher_id,
    financePartyId = account.finance_party_id,
    rightsPartyId = account.rights_party_id;
  if (!publisherId) {
    publisherId = id("publisher");
    await db
      .prepare("INSERT INTO publishers(id,name,website,created_at,updated_at) VALUES(?,?,?,?,?)")
      .bind(publisherId, account.display_name, account.website || "", at, at)
      .run();
  }
  if (!rightsPartyId) {
    const r = await upsertRightsParty(db as any, {
      displayName: account.display_name,
      partyType: "publisher",
      publisherId,
      contactEmail: account.contact_email || "",
      referenceCode: `FORE-PUB-${account.id}`,
      status: "active",
    });
    rightsPartyId = r.id;
  }
  if (!financePartyId) {
    financePartyId = id("finparty");
    await db
      .prepare(
        `INSERT INTO finance_parties(id,party_type,display_name,publisher_id,tax_country,withholding_bps,payout_currency,status,created_at,updated_at) VALUES(?,'publisher',?,?,?,?,?,'active',?,?)`,
      )
      .bind(
        financePartyId,
        account.display_name,
        publisherId,
        tax?.country_code || account.country_code,
        Number(tax?.withholding_bps || 0),
        payout?.payout_currency || "USD",
        at,
        at,
      )
      .run();
  }
  await db
    .prepare(
      "UPDATE publishing_accounts SET publisher_id=?,finance_party_id=?,rights_party_id=?,status='active',updated_at=? WHERE id=?",
    )
    .bind(publisherId, financePartyId, rightsPartyId, at, account.id)
    .run();
  return { publisherId, financePartyId, rightsPartyId };
}

export async function publicationVersionManifest(
  db: PublishingDB,
  publicationVersionId: string | null | undefined,
) {
  if (!publicationVersionId) return null;
  const row = await db
    .prepare("SELECT id,manifest_json FROM publishing_publication_versions WHERE id=?")
    .bind(publicationVersionId)
    .first<any>();
  return row ? { id: String(row.id), manifest: safeJson<any>(row.manifest_json, {}) } : null;
}

/** Retired: never activate commercial rights directly through the shared application DB. */
export async function activatePublicationCommercialTerms(
  _db: PublishingDB,
  _currentManifest: any,
  _previousManifest: any | null,
  _at: string,
): Promise<never> {
  throw new ApiError(503, "Commercial activation requires the canonical private owner.");
}

export async function materializePublishingSubmission(
  env: PublishingEnv,
  submissionId: string,
  reviewerUserId: string,
) {
  if (hasPublicationOwner(env.DB))
    return dispatchPublicationMaterialization(env.DB, { submissionId, reviewerUserId });
  throw new ApiError(503, "Publishing materialization requires its canonical private owner.");
}

/** The owner reserves canonical identities and holds the product before this
 * complete implementation can write. Unenrolled legacy callers retain their
 * existing path until production writer closure is certified. */

async function activatePublicationVersion(
  db: PublishingDB,
  publicationVersionId: string,
  actorUserId: string | null,
  triggerType: "schedule" | "rollback" | "staff",
) {
  if (hasPublicationOwner(db))
    return dispatchPublicationActivation(db, { publicationVersionId, actorUserId, triggerType });
  return activatePublicationVersionOwned(db, publicationVersionId, actorUserId, triggerType);
}

/** The private legal owner executes this implementation against its own
 * PRIMARY_DB after durably acquiring the product's publication hold. */
/** Retired: the owner verifies the frozen version and executes the physical activation. */
export async function activatePublicationVersionOwned(
  _db: PublishingDB,
  _publicationVersionId: string,
  _actorUserId: string | null,
  _triggerType: "schedule" | "rollback" | "staff",
): Promise<never> {
  throw new ApiError(503, "Publication version activation requires its private owner.");
}

/** Only the owner invokes this implementation on enrolled databases; the
 * scheduler always dispatches the typed command through its bound facade. */
/** Retired: scheduled preorder activation cannot bypass canonical owner denial. */
export async function openPublicationPreorderOwned(
  _db: PublishingDB,
  _publicationVersionId: string,
): Promise<never> {
  throw new ApiError(503, "Preorder activation requires its canonical private owner.");
}

export async function advancePublishingReleaseSchedules(db: PublishingDB) {
  // A complete primary activation can already be live/preorder when its
  // final owner commit fails. Recover recorded holds before the lifecycle
  // query, which intentionally selects only still-due releases.
  const recovery = hasPublicationOwner(db) ? await dispatchPublicationRecovery(db) : null;
  const atMs = Date.now(),
    atSeconds = Math.floor(atMs / 1000),
    rows = (
      await db
        .prepare(
          `SELECT l.*,pv.id version_id,pv.manifest_json,pv.version_number FROM publishing_release_lifecycles l LEFT JOIN publishing_publication_versions pv ON pv.id=COALESCE(l.pending_publication_version_id,l.current_publication_version_id) WHERE l.state IN ('scheduled','preorder') AND CASE WHEN json_valid(pv.manifest_json) THEN (CAST(strftime('%s',json_extract(pv.manifest_json,'$.metadata.releaseDate')) AS INTEGER)<=? OR (l.state='scheduled' AND l.pending_publication_version_id IS NULL AND CAST(strftime('%s',json_extract(pv.manifest_json,'$.metadata.preorderDate')) AS INTEGER)<=?)) ELSE 0 END ORDER BY l.updated_at,l.id LIMIT 500`,
        )
        .bind(atSeconds, atSeconds)
        .all<any>()
    ).results;
  const advanced: any[] = [];
  for (const row of rows) {
    if (!row.version_id) continue;
    const m = safeJson<any>(row.manifest_json, {}),
      meta = m.metadata || {},
      releaseMs = meta.releaseDate ? new Date(meta.releaseDate).getTime() : NaN,
      preorderMs = meta.preorderDate ? new Date(meta.preorderDate).getTime() : NaN;
    if (Number.isFinite(releaseMs) && releaseMs <= atMs) {
      advanced.push(await activatePublicationVersion(db, row.version_id, null, "schedule"));
      continue;
    }
    if (
      row.state === "scheduled" &&
      !row.pending_publication_version_id &&
      Number.isFinite(preorderMs) &&
      preorderMs <= atMs
    ) {
      advanced.push(
        hasPublicationOwner(db)
          ? await dispatchPublicationPreorder(db, { publicationVersionId: row.version_id })
          : await openPublicationPreorderOwned(db, row.version_id),
      );
    }
  }
  return { checked: rows.length, advanced, ...(recovery ? { recovery } : {}) };
}

export async function rollbackPublishingVersion(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        editionId: z.string().min(1),
        versionNumber: z.number().int().min(1),
        reasonCode: z.string().trim().min(3).max(120),
        notes: z.string().max(4000).default(""),
      })
      .parse(raw),
    lifecycle = await ensurePublishingLifecycle(db, x.editionId),
    target = await db
      .prepare(
        "SELECT * FROM publishing_publication_versions WHERE lifecycle_id=? AND version_number=?",
      )
      .bind(lifecycle.id, x.versionNumber)
      .first<any>();
  if (!target) throw new ApiError(404, "Publication version not found.");
  if (["suppressed", "takedown", "retired"].includes(String(lifecycle.state)))
    throw new ApiError(
      409,
      "Rollback is blocked while the release is suppressed, taken down, or retired. Restore the release through moderation first.",
    );
  if (target.id === lifecycle.current_publication_version_id)
    return {
      publicationVersionId: target.id,
      state: lifecycle.state,
      versionNumber: x.versionNumber,
      alreadyCurrent: true,
    };
  const result = await activatePublicationVersion(db, target.id, reviewerUserId, "rollback");
  await audit(db, null, reviewerUserId, "publishing_release", lifecycle.id, "rollback", {
    toVersion: x.versionNumber,
    fromVersionId: lifecycle.current_publication_version_id,
    reasonCode: x.reasonCode,
    notes: x.notes,
  });
  return result;
}

export async function reviewPublishingSubmission(env:PublishingEnv,userId:string,raw:unknown){
return dispatchPrivatePublishingEditor(env.DB,"review-submission",{userId,raw});
}





























































































































































/** A review is no longer a shared-D1 authority write. Only the isolated
 * privately authenticated owner can record a negative onboarding decision.
 * Positive KYC/tax/payout verification requires external proof and remains closed. */
export async function reviewPublishingOnboarding(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
    .object({
      accountId: z.string().min(1).max(180),
      kind: z.enum(["identity", "tax", "payout"]),
      recordId: z.string().min(1).max(180),
      status: z.enum(["verified", "failed", "expired", "manual_review", "restricted"]),
      reasonCode: z.string().max(120).default(""),
      withholdingBps: z.number().int().min(0).max(10000).optional(),
      requirementsDue: z.array(z.string().max(240)).max(100).optional(),
    })
    .parse(raw);
  if (!hasPublicationOwner(db))
    throw new ApiError(503, "Publishing verification review requires its private legal owner.");
  return dispatchPublishingOnboardingReview(db, { ...x, reviewerUserId });
}

export async function publishingSnapshot(
  db: PublishingDB,
  userId: string,
  accountId?: string | null,
) {
  const memberships = (
    await db
      .prepare(
        `SELECT m.*,a.display_name,a.legal_name,a.country_code,a.status account_status,a.identity_status,a.tax_status,a.payout_status,a.terms_accepted_at FROM publishing_account_members m JOIN publishing_accounts a ON a.id=m.account_id WHERE m.user_id=? AND m.status='active' ORDER BY a.created_at`,
      )
      .bind(userId)
      .all<any>()
  ).results;
  const selected = accountId ? memberships.find((m) => m.account_id === accountId) : memberships[0];
  if (!selected)
    return {
      accounts: memberships,
      account: null,
      titles: [],
      penNames: [],
      members: [],
      onboarding: null,
    };
  const aid = String(selected.account_id);
  await requireRole(db, userId, aid, "analyst");
  const [
    account,
    addresses,
    penNames,
    members,
    titles,
    editions,
    assets,
    validations,
    submissions,
    publications,
  ] = await Promise.all([
    db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(aid).first<any>(),
    db
      .prepare("SELECT * FROM publishing_addresses WHERE account_id=? ORDER BY address_type")
      .bind(aid)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_pen_names WHERE account_id=? ORDER BY display_name")
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT role,status,invited_email,accepted_at,created_at,user_id FROM publishing_account_members WHERE account_id=? ORDER BY created_at",
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_titles WHERE account_id=? ORDER BY updated_at DESC")
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT e.* FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY e.updated_at DESC`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT a.*,v.version_number,v.original_filename,v.mime_type,v.size_bytes,v.sha256,v.quarantine_status,v.validation_summary,v.extracted_metadata_json FROM publishing_assets a JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE t.account_id=? ORDER BY a.updated_at DESC`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT j.*,v.original_filename,a.kind,a.edition_id FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY j.created_at DESC LIMIT 500`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT id,edition_id,revision,status,snapshot_sha256,submitted_at,decided_at,published_at FROM publishing_submission_snapshots WHERE account_id=? ORDER BY submitted_at DESC",
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_publications WHERE publishing_account_id=? ORDER BY published_at DESC",
      )
      .bind(aid)
      .all<any>(),
  ]);
  const latestIdentity = await db
      .prepare(
        "SELECT id,provider,status,reason_code,initiated_at,decided_at,expires_at FROM publishing_identity_verifications WHERE account_id=? ORDER BY initiated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>(),
    latestTax = await db
      .prepare(
        "SELECT id,country_code,tax_classification,form_type,provider,status,withholding_bps,treaty_country_code,validated_at,expires_at FROM publishing_tax_profiles WHERE account_id=? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>(),
    latestPayout = await db
      .prepare(
        "SELECT id,provider,method,bank_country_code,payout_currency,account_last4,status,payout_threshold_minor,requirements_due_json,verified_at FROM publishing_payout_accounts WHERE account_id=? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>();
  const [lifecycles, publicationVersions, activations, moderationCases, appeals] =
    await Promise.all([
      db
        .prepare(
          `SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY l.updated_at DESC`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT pv.id,pv.lifecycle_id,pv.submission_id,pv.version_number,pv.previous_version_id,pv.rollback_of_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pv.created_at DESC`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT pa.* FROM publishing_publication_activations pa JOIN publishing_release_lifecycles l ON l.id=pa.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pa.created_at DESC LIMIT 500`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT c.*,(SELECT ma.id FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_id,(SELECT ma.action_type FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_type,(SELECT ma.rationale FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_rationale,(SELECT ma.reversible FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_reversible FROM moderation_cases c WHERE c.publishing_account_id=? ORDER BY c.updated_at DESC LIMIT 200`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          "SELECT a.*,c.category,c.summary FROM moderation_appeals a JOIN moderation_cases c ON c.id=a.case_id WHERE a.publishing_account_id=? ORDER BY a.submitted_at DESC",
        )
        .bind(aid)
        .all<any>(),
    ]);
  let finance = { statements: [] as any[], payouts: [] as any[], royaltyBalances: [] as any[] };
  if (account?.finance_party_id) {
    const [statementRows, payoutRows, balanceRows] = await Promise.all([
      db
        .prepare(
          "SELECT id,period_start,period_end,currency,sales_minor,refunds_minor,royalties_minor,withholding_minor,reserve_minor,payable_minor,generated_at FROM finance_statements WHERE party_id=? ORDER BY period_end DESC,generated_at DESC LIMIT 24",
        )
        .bind(account.finance_party_id)
        .all<any>(),
      db
        .prepare(
          `SELECT pi.id,pi.currency,pi.gross_minor,pi.withholding_minor,pi.net_minor,pi.status,pi.external_payout_id,pi.created_at,pb.period_start,pb.period_end,pb.paid_at FROM payout_items pi JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pi.party_id=? ORDER BY pi.created_at DESC LIMIT 50`,
        )
        .bind(account.finance_party_id)
        .all<any>(),
      db
        .prepare(
          "SELECT currency,status,SUM(royalty_minor) royalty_minor,SUM(withholding_minor) withholding_minor,SUM(payable_minor) payable_minor,COUNT(*) event_count FROM finance_royalty_allocations WHERE party_id=? GROUP BY currency,status ORDER BY currency,status",
        )
        .bind(account.finance_party_id)
        .all<any>(),
    ]);
    finance = {
      statements: statementRows.results,
      payouts: payoutRows.results,
      royaltyBalances: balanceRows.results,
    };
  }
  const trust = await publisherRightsSnapshot(db, userId, aid);
  return {
    accounts: memberships,
    account,
    addresses: addresses.results,
    penNames: penNames.results,
    members: members.results,
    titles: titles.results,
    editions: editions.results,
    assets: assets.results,
    validations: validations.results,
    submissions: submissions.results,
    publications: publications.results,
    lifecycles: lifecycles.results,
    publicationVersions: publicationVersions.results,
    publicationActivations: activations.results,
    moderationCases: moderationCases.results,
    appeals: appeals.results,
    finance,
    ...trust,
    onboarding: {
      identity: latestIdentity,
      tax: latestTax,
      payout: latestPayout,
      ready:
        account?.identity_status === "verified" &&
        account?.tax_status === "verified" &&
        account?.payout_status === "verified" &&
        !!account?.terms_accepted_at,
    },
  };
}

export async function adminPublishingSnapshot(db: PublishingDB) {
  const [
    accounts,
    submissions,
    jobs,
    duplicates,
    auditRows,
    lifecycles,
    versions,
    activations,
    automated,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT a.*,(SELECT count(*) FROM publishing_titles t WHERE t.account_id=a.id) title_count,(SELECT COALESCE(SUM(s.strike_points),0) FROM moderation_sanctions s WHERE s.publishing_account_id=a.id AND s.status='active') active_strikes FROM publishing_accounts a ORDER BY a.updated_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        `SELECT s.id,s.edition_id,s.account_id,s.revision,s.status,s.snapshot_sha256,s.submitted_at,s.decided_at,s.published_at,t.title,e.format,a.display_name publisher_name,ar.outcome automated_outcome,ar.risk_score automated_risk_score,l.state lifecycle_state FROM publishing_submission_snapshots s JOIN publishing_edition_drafts e ON e.id=s.edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=s.account_id LEFT JOIN publishing_automated_reviews ar ON ar.submission_id=s.id LEFT JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id ORDER BY s.submitted_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        "SELECT status,check_type,count(*) count FROM publishing_validation_jobs GROUP BY status,check_type ORDER BY status,check_type",
      )
      .all<any>(),
    db
      .prepare(
        `SELECT d.*,v.original_filename,a.kind,t.title FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.disposition IN ('review','fraud_hold') ORDER BY d.created_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_audit_events ORDER BY created_at DESC LIMIT 300")
      .all<any>(),
    db
      .prepare(
        `SELECT l.*,t.title,a.display_name publisher_name,e.format,e.catalog_product_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=t.account_id ORDER BY l.updated_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        `SELECT pv.id,pv.lifecycle_id,pv.version_number,pv.previous_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id,t.title FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id ORDER BY pv.created_at DESC LIMIT 1000`,
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_publication_activations ORDER BY created_at DESC LIMIT 1000",
      )
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_automated_reviews ORDER BY created_at DESC LIMIT 500")
      .all<any>(),
  ]);
  return {
    accounts: accounts.results,
    submissions: submissions.results,
    jobs: jobs.results,
    duplicates: duplicates.results,
    audit: auditRows.results,
    lifecycles: lifecycles.results,
    versions: versions.results,
    activations: activations.results,
    automatedReviews: automated.results,
  };
}

export async function resolveDuplicateMatch(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        id: z.string().min(1),
        disposition: z.enum(["cleared", "duplicate", "fraud_hold"]),
      })
      .parse(raw),
    row = await db
      .prepare(
        `SELECT d.*,t.account_id FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.id=?`,
      )
      .bind(x.id)
      .first<any>();
  if (!row) throw new ApiError(404, "Duplicate review item not found.");
  await db
    .prepare("UPDATE publishing_duplicate_matches SET disposition=?,updated_at=? WHERE id=?")
    .bind(x.disposition, now(), x.id)
    .run();
  await audit(db, row.account_id, reviewerUserId, "duplicate_match", x.id, "resolved", {
    disposition: x.disposition,
  });
  return { saved: true };
}

export async function catalogPublishingAsset(env: PublishingEnv, assetVersionId: string) {
  const row = await env.DB.prepare(
    `SELECT av.object_key,av.mime_type,av.size_bytes,da.kind,p.storefront_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id JOIN editions e ON e.id=da.edition_id JOIN products p ON p.edition_id=e.id WHERE av.id=? AND da.kind='cover' AND p.storefront_status='active' LIMIT 1`,
  )
    .bind(assetVersionId)
    .first<any>();
  if (!row || !env.BUCKET) throw new ApiError(404, "Catalog asset not found.");
  const object = await env.BUCKET.get(row.object_key);
  if (!object) throw new ApiError(404, "Catalog asset not found.");
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type || "application/octet-stream",
      "Content-Length": String(object.size || row.size_bytes || 0),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
