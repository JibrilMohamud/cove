import { z } from "zod/v3";
import { ApiError } from "./service";
import { createModerationCase, type StaffContext } from "./moderation.server";
import type { PublishingDB, PublishingEnv } from "./publishing.server";
import { dispatchPublishingOwnerValidationJob,dispatchPrivateTrustAction } from "../../storefront-strangler/publication-owner-routing.server";

const now = () => new Date().toISOString();
const id = (p: string) => `${p}_${crypto.randomUUID()}`;
const clean = (v: unknown, max = 4000) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const origin = z.enum(["human", "ai_assisted", "ai_generated", "mixed"]);
const optionalOrigin = z.enum(["human", "ai_assisted", "ai_generated", "mixed", "not_applicable"]);
export const FORE_RIGHTS_POLICY_VERSION = "fore-rights-v1";
export const FORE_AI_POLICY_VERSION = "fore-ai-content-v1";
const addressSchema = z.object({
  line1: z.string().trim().min(2).max(240),
  line2: z.string().trim().max(240).default(""),
  city: z.string().trim().min(1).max(160),
  region: z.string().trim().max(160).default(""),
  postalCode: z.string().trim().min(2).max(32),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
});

async function member(
  db: PublishingDB,
  userId: string,
  accountId: string,
  min: "analyst" | "editor" | "admin" | "owner" = "analyst",
) {
  const rank: any = { analyst: 1, editor: 2, finance: 2, admin: 3, owner: 4 };
  const m = await db
    .prepare(
      "SELECT role FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'",
    )
    .bind(accountId, userId)
    .first<any>();
  if (!m || rank[String(m.role)] < rank[min])
    throw new ApiError(403, "You do not have permission to perform this publishing action.");
  return m;
}
async function edition(db: PublishingDB, editionId: string) {
  const r = await db
    .prepare(
      `SELECT e.*,t.account_id,t.title FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
    )
    .bind(editionId)
    .first<any>();
  if (!r) throw new ApiError(404, "Publishing edition not found.");
  return r;
}
async function audit(
  db: PublishingDB,
  accountId: string | null,
  userId: string | null,
  type: string,
  entityId: string,
  action: string,
  meta: unknown = {},
) {
  await db
    .prepare(
      "INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(id("pubaudit"), accountId, userId, type, entityId, action, JSON.stringify(meta), now())
    .run();
}

async function requireActivePolicy(db: PublishingDB, policyKey: string, version: string) {
  const row = await db
    .prepare(
      "SELECT policy_key,version,title,status,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE policy_key=? AND version=? AND status='active'",
    )
    .bind(policyKey, version)
    .first<any>();
  if (!row)
    throw new ApiError(
      503,
      `Cove policy ${policyKey} ${version} is not active; publishing signatures are temporarily unavailable until policy configuration is reconciled.`,
    );
  return row;
}

export async function publicPublishingPolicies(db: PublishingDB) {
  const rows = (
    await db
      .prepare(
        "SELECT policy_key,version,title,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE status='active' ORDER BY policy_key",
      )
      .all<any>()
  ).results;
  return {
    policies: rows.map((r: any) => ({
      ...r,
      rules: (() => {
        try {
          return JSON.parse(String(r.rules_json || "{}"));
        } catch {
          return {};
        }
      })(),
    })),
  };
}

export async function signPublishingRightsDeclaration(db:PublishingDB,userId:string,raw:unknown){
 return dispatchPrivateTrustAction(db,"sign-rights",{actorUserId:userId,raw});
}

export async function signPublishingAiDisclosure(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      editionId: z.string().min(1),
      textOrigin: origin,
      coverOrigin: optionalOrigin,
      narrationOrigin: optionalOrigin,
      translationOrigin: optionalOrigin,
      syntheticVoiceLabel: z.string().max(240).default(""),
      modelNames: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
      generationNotes: z.string().max(5000).default(""),
      humanEditorialReviewAttestation: z.literal(true),
      rightsResponsibilityAttestation: z.literal(true),
      nonSpamAttestation: z.literal(true),
      signatureName: z.string().trim().min(2).max(240),
    })
    .parse(raw);
  const e = await edition(db, x.editionId);
  await member(db, userId, String(e.account_id), "editor");
  await requireActivePolicy(db, "ai_content", FORE_AI_POLICY_VERSION);
  if (!["draft", "changes_requested"].includes(String(e.status)))
    throw new ApiError(
      409,
      "Open a new revision before changing the signed AI-content disclosure.",
    );
  if (
    e.format === "audiobook" &&
    ["ai_generated", "mixed"].includes(x.narrationOrigin) &&
    !x.syntheticVoiceLabel.trim()
  )
    throw new ApiError(
      400,
      "AI-generated or mixed narration requires a customer-facing synthetic voice label.",
    );
  const prior = await db
    .prepare("SELECT id FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(e.id, e.revision)
    .first<any>();
  if (prior)
    throw new ApiError(
      409,
      "This revision already has a signed immutable AI-content disclosure. Open a new revision to replace it.",
    );
  const disclosureId = id("aidisc"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_ai_disclosures(id,edition_id,account_id,revision,policy_version,text_origin,cover_origin,narration_origin,translation_origin,synthetic_voice_label,model_names_json,generation_notes,human_editorial_review_attestation,rights_responsibility_attestation,non_spam_attestation,signature_name,signed_by_user_id,signed_at,created_at) VALUES(?,?,?,?, ?,?,?,?,?,?,?,?,1,1,1,?,?,?,?)`,
    )
    .bind(
      disclosureId,
      e.id,
      e.account_id,
      e.revision,
      FORE_AI_POLICY_VERSION,
      x.textOrigin,
      x.coverOrigin,
      x.narrationOrigin,
      x.translationOrigin,
      x.syntheticVoiceLabel,
      JSON.stringify(x.modelNames),
      x.generationNotes,
      x.signatureName,
      userId,
      at,
      at,
    )
    .run();
  await audit(db, String(e.account_id), userId, "ai_disclosure", disclosureId, "signed", {
    editionId: e.id,
    revision: e.revision,
    policyVersion: FORE_AI_POLICY_VERSION,
    textOrigin: x.textOrigin,
    coverOrigin: x.coverOrigin,
    narrationOrigin: x.narrationOrigin,
  });
  return {
    id: disclosureId,
    editionId: e.id,
    revision: Number(e.revision),
    policyVersion: FORE_AI_POLICY_VERSION,
  };
}

export async function uploadRightsEvidence(env:PublishingEnv,userId:string,input:{
 declarationId:string;evidenceType:string;description?:string;filename:string;mimeType:string;
 bytes:Uint8Array;issuedBy?:string;issuedAt?:string|null;expiresAt?:string|null
}){
 if(!(input.bytes instanceof Uint8Array)||input.bytes.byteLength>32768)
  throw new ApiError(413,"Private rights evidence upload is limited to 32 KiB in isolated QA.");
 return dispatchPrivateTrustAction(env.DB,"upload-evidence",{
  actorUserId:userId,raw:{...input,bytes:Array.from(input.bytes)}
 });
}

async function sha256(bytes: Uint8Array | string) {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(raw)));
  return [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function normalizeText(s: string) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500000);
}
function fnv64(token: string) {
  let h = 1469598103934665603n;
  for (const c of new TextEncoder().encode(token)) {
    h ^= BigInt(c);
    h = BigInt.asUintN(64, h * 1099511628211n);
  }
  return h;
}
function simhash64(tokens: string[]) {
  const v = new Array(64).fill(0);
  for (const t of tokens.slice(0, 100000)) {
    const h = fnv64(t);
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] >= 0) out |= 1n << BigInt(i);
  return out.toString(16).padStart(16, "0");
}
function hamming(a: string, b: string) {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b),
    n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export async function recordAssetFingerprint(
  db: PublishingDB,
  input: {
    assetVersionId: string;
    accountId: string;
    editionId: string;
    assetKind: string;
    exactSha256: string;
    text?: string;
    metadata?: unknown;
  },
) {
  const existing = await db
    .prepare("SELECT id FROM publishing_asset_fingerprints WHERE asset_version_id=?")
    .bind(input.assetVersionId)
    .first<any>();
  if (existing) return existing;
  const normalized = normalizeText(input.text || ""),
    tokens = normalized ? normalized.split(" ").filter(Boolean) : [],
    normalizedHash = normalized ? await sha256(normalized) : "",
    sim = tokens.length >= 100 ? simhash64(tokens) : "",
    bands = simhashBands(sim),
    metaHash = await sha256(JSON.stringify(input.metadata || {})),
    fid = id("fingerprint"),
    at = now();
  await db
    .prepare(
      "INSERT INTO publishing_asset_fingerprints(id,asset_version_id,account_id,edition_id,asset_kind,exact_sha256,normalized_text_sha256,simhash64,simhash_band0,simhash_band1,simhash_band2,simhash_band3,token_count,metadata_fingerprint,detector_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'fore-fingerprint-v2',?)",
    )
    .bind(
      fid,
      input.assetVersionId,
      input.accountId,
      input.editionId,
      input.assetKind,
      input.exactSha256,
      normalizedHash,
      sim,
      ...bands,
      tokens.length,
      metaHash,
      at,
    )
    .run();
  const candidates = (
    await db
      .prepare(
        `SELECT * FROM publishing_asset_fingerprints
    WHERE asset_version_id<>? AND asset_kind=? AND (
      exact_sha256=? OR (?<>'' AND normalized_text_sha256=?) OR
      (?<>'' AND (simhash_band0=? OR simhash_band1=? OR simhash_band2=? OR simhash_band3=?))
    ) ORDER BY created_at DESC LIMIT 4000`,
      )
      .bind(
        input.assetVersionId,
        input.assetKind,
        input.exactSha256,
        normalizedHash,
        normalizedHash,
        sim,
        bands[0],
        bands[1],
        bands[2],
        bands[3],
      )
      .all<any>()
  ).results;
  for (const c of candidates) {
    let type: string | undefined,
      score = 0;
    if (c.exact_sha256 === input.exactSha256) {
      type = "exact";
      score = 1;
    } else if (normalizedHash && c.normalized_text_sha256 === normalizedHash) {
      type = "normalized_text";
      score = 0.995;
    } else if (sim) {
      const d = hamming(sim, String(c.simhash64 || ""));
      if (d <= 7) {
        type = "simhash";
        score = 1 - d / 64;
      }
    }
    if (!type) continue;
    const a = String(input.accountId),
      b = String(c.account_id),
      cross = a !== b,
      mid = id("simmatch");
    await db
      .prepare(
        `INSERT OR IGNORE INTO publishing_similarity_matches(id,asset_version_id,matched_asset_version_id,similarity_type,score,cross_account,disposition,detector_version,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'review','fore-fingerprint-v2',?,?,?)`,
      )
      .bind(
        mid,
        input.assetVersionId,
        c.asset_version_id,
        type,
        score,
        cross ? 1 : 0,
        JSON.stringify({
          tokenCount: tokens.length,
          matchedTokenCount: Number(c.token_count || 0),
          simhashDistance: sim ? hamming(sim, String(c.simhash64 || "")) : null,
        }),
        at,
        at,
      )
      .run();
    if (cross) {
      const linkType = type === "exact" ? "shared_exact_asset" : "high_content_similarity",
        linkScore = type === "exact" ? 100 : Math.round(score * 100);
      await upsertAccountRiskLink(db, a, b, linkType, linkScore, {
        assetVersionId: input.assetVersionId,
        matchedAssetVersionId: c.asset_version_id,
        similarityType: type,
      });
    }
  }
  return {
    id: fid,
    normalizedTextSha256: normalizedHash,
    simhash64: sim,
    tokenCount: tokens.length,
  };
}

function simhashBands(sim: string): [string, string, string, string] {
  if (!/^[0-9a-f]{16}$/i.test(sim)) return ["", "", "", ""];
  return [sim.slice(0, 4), sim.slice(4, 8), sim.slice(8, 12), sim.slice(12, 16)];
}

async function upsertAccountRiskLink(
  db: PublishingDB,
  a: string,
  b: string,
  linkType: string,
  score: number,
  evidence: unknown = {},
) {
  if (!a || !b || a === b) return;
  const lo = a < b ? a : b,
    hi = a < b ? b : a,
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_account_risk_links(id,account_a_id,account_b_id,link_type,score,evidence_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_a_id,account_b_id,link_type) DO UPDATE SET score=MAX(score,excluded.score),evidence_json=excluded.evidence_json,last_seen_at=excluded.last_seen_at`,
    )
    .bind(
      id("risklink"),
      lo,
      hi,
      linkType,
      Math.max(0, Math.min(100, score)),
      JSON.stringify(evidence),
      at,
      at,
    )
    .run();
  await ensureRiskCluster(db, lo, hi, linkType);
}

async function ensureRiskCluster(db: PublishingDB, a: string, b: string, reason: string) {
  const links = (
    await db
      .prepare(
        "SELECT link_type,score FROM publishing_account_risk_links WHERE account_a_id=? AND account_b_id=? ORDER BY score DESC",
      )
      .bind(a, b)
      .all<any>()
  ).results;
  if (!links.length) return;
  const max = Math.max(...links.map((r: any) => Number(r.score || 0))),
    aggregate = Math.min(100, max + Math.min(40, Math.max(0, links.length - 1) * 20));
  if (aggregate < 85) return;
  const memberships = (
    await db
      .prepare(
        `SELECT DISTINCT c.id,c.risk_score FROM publishing_risk_clusters c JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id
    WHERE m.account_id IN (?,?) AND c.status IN ('open','monitoring') ORDER BY c.risk_score DESC,c.created_at`,
      )
      .bind(a, b)
      .all<any>()
  ).results;
  const at = now(),
    cid = String(memberships[0]?.id || id("riskcluster"));
  if (!memberships.length)
    await db
      .prepare(
        "INSERT INTO publishing_risk_clusters(id,status,risk_score,reason,created_at,updated_at) VALUES(?,'open',?,?,?,?)",
      )
      .bind(cid, aggregate, reason, at, at)
      .run();
  else
    await db
      .prepare(
        "UPDATE publishing_risk_clusters SET risk_score=MAX(risk_score,?),reason=?,updated_at=? WHERE id=?",
      )
      .bind(aggregate, reason, at, cid)
      .run();
  for (const extra of memberships.slice(1)) {
    const members = (
      await db
        .prepare("SELECT * FROM publishing_risk_cluster_members WHERE cluster_id=?")
        .bind(extra.id)
        .all<any>()
    ).results;
    for (const m of members)
      await db
        .prepare(
          `INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,?,?)
      ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score),evidence_json=excluded.evidence_json`,
        )
        .bind(cid, m.account_id, m.member_score, m.evidence_json || "{}", m.added_at || at)
        .run();
    await db.prepare("DELETE FROM publishing_risk_clusters WHERE id=?").bind(extra.id).run();
  }
  for (const accountId of [a, b])
    await db
      .prepare(
        `INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,'{}',?)
    ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score)`,
      )
      .bind(cid, accountId, aggregate, at)
      .run();
}

const publicMailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "mail.com",
]);
export async function scanAccountRiskLinks(db: PublishingDB, accountId: string) {
  const account = await db
    .prepare(
      "SELECT id,contact_email,finance_party_id,rights_party_id FROM publishing_accounts WHERE id=?",
    )
    .bind(accountId)
    .first<any>();
  if (!account) return { links: 0 };
  let linked = 0;
  const email = String(account.contact_email || "").toLowerCase(),
    domain = email.includes("@") ? email.split("@").pop() || "" : "";
  if (domain && !publicMailDomains.has(domain)) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND lower(substr(contact_email,instr(contact_email,'@')+1))=?",
        )
        .bind(accountId, domain)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_contact_domain", 45, {
        domain,
      });
      linked++;
    }
  }
  const controllers = (
    await db
      .prepare(
        `SELECT DISTINCT m2.account_id FROM publishing_account_members m1 JOIN publishing_account_members m2 ON m2.user_id=m1.user_id
    WHERE m1.account_id=? AND m2.account_id<>? AND m1.status='active' AND m2.status='active' AND m1.role IN ('owner','admin') AND m2.role IN ('owner','admin')`,
      )
      .bind(accountId, accountId)
      .all<any>()
  ).results;
  for (const r of controllers) {
    await upsertAccountRiskLink(
      db,
      accountId,
      String(r.account_id),
      "shared_account_controller",
      65,
      { basis: "shared active owner/admin identity" },
    );
    linked++;
  }
  if (account.finance_party_id) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND finance_party_id=? AND finance_party_id IS NOT NULL",
        )
        .bind(accountId, account.finance_party_id)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_payout_reference", 95, {
        financePartyId: String(account.finance_party_id),
      });
      linked++;
    }
  }
  if (account.rights_party_id) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND rights_party_id=? AND rights_party_id IS NOT NULL",
        )
        .bind(accountId, account.rights_party_id)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_identity_reference", 90, {
        rightsPartyId: String(account.rights_party_id),
      });
      linked++;
    }
  }
  return { links: linked };
}

function normalizedName(v: string) {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 240);
}
function editDistance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return prev[b.length];
}
export async function scanIdentitySimilarity(
  db: PublishingDB,
  input: {
    accountId: string;
    subjectType: "publisher_name" | "pen_name" | "contributor";
    subjectId: string;
    name: string;
  },
) {
  const n = normalizedName(input.name);
  if (n.length < 4) return [];
  const rows = [
    ...(
      await db
        .prepare("SELECT id,name,'publisher' entity_type FROM publishers WHERE name<>'' LIMIT 4000")
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,name,'contributor' entity_type FROM contributors WHERE name<>'' LIMIT 4000",
        )
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,display_name name,'publishing_account' entity_type FROM publishing_accounts WHERE id<>? LIMIT 4000",
        )
        .bind(input.accountId)
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,display_name name,'pen_name' entity_type FROM publishing_pen_names WHERE account_id<>? LIMIT 4000",
        )
        .bind(input.accountId)
        .all<any>()
    ).results,
  ];
  const matches: any[] = [];
  for (const r of rows) {
    const m = normalizedName(String(r.name || ""));
    if (!m) continue;
    const dist = editDistance(n, m),
      score = Math.round((1 - dist / Math.max(n.length, m.length)) * 100);
    if (score < 90) continue;
    const duplicate = await db
      .prepare(
        `SELECT id FROM publishing_identity_similarity_matches WHERE account_id=? AND subject_type=? AND subject_id=? AND submitted_name=? AND matched_entity_type=? AND matched_entity_id=? AND status='review' LIMIT 1`,
      )
      .bind(input.accountId, input.subjectType, input.subjectId, input.name, r.entity_type, r.id)
      .first<any>();
    if (duplicate) {
      matches.push({
        id: String(duplicate.id),
        score,
        matchedName: r.name,
        matchedEntityType: r.entity_type,
        existing: true,
      });
      continue;
    }
    const matchId = id("idsim"),
      at = now();
    await db
      .prepare(
        "INSERT INTO publishing_identity_similarity_matches(id,account_id,subject_type,subject_id,submitted_name,matched_entity_type,matched_entity_id,matched_name,similarity_score,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      )
      .bind(
        matchId,
        input.accountId,
        input.subjectType,
        input.subjectId,
        input.name,
        r.entity_type,
        r.id,
        r.name,
        score,
        at,
        at,
      )
      .run();
    matches.push({ id: matchId, score, matchedName: r.name, matchedEntityType: r.entity_type });
  }
  return matches;
}

export async function assessSubmissionContentPolicy(db:PublishingDB,submissionId:string){
 return dispatchPrivateTrustAction(db,"assess-content",{submissionId});
}

async function publishingAccountForSubject(
  db: PublishingDB,
  subjectType: string,
  subjectId: string,
) {
  let r: any = null;
  if (subjectType === "title")
    r = await db
      .prepare("SELECT account_id FROM publishing_titles WHERE id=?")
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "edition")
    r = await db
      .prepare(
        "SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?",
      )
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "publication")
    r = await db
      .prepare("SELECT publishing_account_id account_id FROM publishing_publications WHERE id=?")
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "publisher")
    r = await db
      .prepare("SELECT id account_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1")
      .bind(subjectId, subjectId)
      .first<any>();
  else if (subjectType === "author")
    r = await db
      .prepare("SELECT account_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1")
      .bind(subjectId, subjectId)
      .first<any>();
  return r?.account_id ? String(r.account_id) : null;
}
async function lifecycleForSubject(db: PublishingDB, type: string, subjectId: string) {
  if (type === "edition")
    return db
      .prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?")
      .bind(subjectId)
      .first<any>();
  if (type === "publication")
    return db
      .prepare(
        `SELECT l.* FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id JOIN publishing_release_lifecycles l ON l.publishing_edition_id=s.edition_id WHERE p.id=?`,
      )
      .bind(subjectId)
      .first<any>();
  if (type === "title")
    return db
      .prepare(
        `SELECT l.* FROM publishing_edition_drafts e JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id WHERE e.title_id=? ORDER BY l.updated_at DESC LIMIT 1`,
      )
      .bind(subjectId)
      .first<any>();
  return null;
}
function disputeEvent(
  db: PublishingDB,
  disputeId: string,
  eventType: string,
  actorType: "claimant" | "publisher" | "staff" | "system" | "worker",
  actorUserId: string | null,
  payload: any = {},
) {
  return db
    .prepare(
      "INSERT INTO rights_dispute_events(id,dispute_id,event_type,actor_type,actor_user_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id("rightsevt"),
      disputeId,
      eventType,
      actorType,
      actorUserId,
      JSON.stringify(payload),
      now(),
    );
}
async function notify(
  db: PublishingDB,
  disputeId: string,
  type: string,
  recipientType: "claimant" | "publisher" | "staff",
  recipient: string,
  payload: any = {},
) {
  if (!recipient) return;
  await db
    .prepare(
      "INSERT INTO rights_notification_jobs(id,dispute_id,notification_type,recipient_type,recipient,payload_json,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,8,?,?,?)",
    )
    .bind(
      id("rightsnotify"),
      disputeId,
      type,
      recipientType,
      recipient,
      JSON.stringify(payload),
      now(),
      now(),
      now(),
    )
    .run();
}

async function resolveCopyrightSubject(
  db: PublishingDB,
  input: { subjectType?: string; subjectId?: string; reportedUrl?: string },
) {
  if (input.subjectType && input.subjectId) {
    const accountId = await publishingAccountForSubject(db, input.subjectType, input.subjectId);
    if (!accountId)
      throw new ApiError(404, "The reported Cove publishing subject could not be found.");
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      accountId,
      reportedUrl: input.reportedUrl || "",
    };
  }
  if (!input.reportedUrl)
    throw new ApiError(400, "Provide a Cove content URL or a recognized publishing subject.");
  let u: URL;
  try {
    u = new URL(input.reportedUrl);
  } catch {
    throw new ApiError(400, "The reported content URL is invalid.");
  }
  const path = u.pathname.replace(/\/+$/g, "");
  let row: any = null,
    subjectType = "",
    subjectId = "";
  let m = path.match(/^\/book\/([^/]+)$/);
  if (m) {
    const productId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publishing_account_id FROM publishing_publications WHERE product_id=? ORDER BY published_at DESC LIMIT 1",
      )
      .bind(productId)
      .first<any>();
    if (row) {
      subjectType = "publication";
      subjectId = String(row.id);
    }
  }
  m = path.match(/^\/edition\/([^/]+)$/);
  if (!row && m) {
    const editionId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publishing_account_id FROM publishing_publications WHERE edition_id=? ORDER BY published_at DESC LIMIT 1",
      )
      .bind(editionId)
      .first<any>();
    if (row) {
      subjectType = "publication";
      subjectId = String(row.id);
    }
  }
  m = path.match(/^\/publisher\/([^/]+)$/);
  if (!row && m) {
    const publisherId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publisher_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1",
      )
      .bind(publisherId, publisherId)
      .first<any>();
    if (row) {
      subjectType = "publisher";
      subjectId = String(row.publisher_id || row.id);
      row.publishing_account_id = row.id;
    }
  }
  m = path.match(/^\/author\/([^/]+)$/);
  if (!row && m) {
    const contributorId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,account_id,contributor_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1",
      )
      .bind(contributorId, contributorId)
      .first<any>();
    if (row) {
      subjectType = "author";
      subjectId = String(row.contributor_id || row.id);
      row.publishing_account_id = row.account_id;
    }
  }
  if (!row || !row.publishing_account_id)
    throw new ApiError(
      404,
      "That URL does not resolve to content published through Cove Publishing. Include a Cove book, edition, publisher, or author URL.",
    );
  return {
    subjectType,
    subjectId,
    accountId: String(row.publishing_account_id),
    reportedUrl: u.toString(),
  };
}

export async function submitCopyrightNotice(db:PublishingDB,userId:string|null,raw:unknown){
 return dispatchPrivateTrustAction(db,"submit-notice",{actorUserId:userId,raw});
}

async function takeDown(_db:PublishingDB,_dispute:any,_staffUserId:string,_reason:string){
 throw new ApiError(503,"Rights takedown mutations require the private owner.");
}

async function applyRoyaltyHold(_db:PublishingDB,_dispute:any,_pub:any,_staffUserId:string){
 throw new ApiError(503,"Royalty holds require a durable owner-first denial.");
}

export async function validateCopyrightNotice(db:PublishingDB,staff:StaffContext,raw:unknown){
 return dispatchPrivateTrustAction(db,"validate-notice",{actorUserId:staff.userId,raw});
}

export async function submitCopyrightCounterNotice(db:PublishingDB,userId:string,raw:unknown){
 return dispatchPrivateTrustAction(db,"submit-counter",{actorUserId:userId,raw});
}

function utcDateKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function observedFixedHoliday(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const d = new Date(Date.UTC(year, month, 1));
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + delta + (n - 1) * 7);
  return d;
}
function lastWeekday(year: number, month: number, weekday: number) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  const delta = (d.getUTCDay() - weekday + 7) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d;
}
function isUsFederalBusinessHoliday(d: Date) {
  const y = d.getUTCFullYear(),
    key = utcDateKey(d),
    holidays = [
      observedFixedHoliday(y, 0, 1),
      observedFixedHoliday(y + 1, 0, 1),
      nthWeekday(y, 0, 1, 3),
      nthWeekday(y, 1, 1, 3),
      lastWeekday(y, 4, 1),
      observedFixedHoliday(y, 5, 19),
      observedFixedHoliday(y, 6, 4),
      nthWeekday(y, 8, 1, 1),
      nthWeekday(y, 9, 1, 2),
      observedFixedHoliday(y, 10, 11),
      nthWeekday(y, 10, 4, 4),
      observedFixedHoliday(y, 11, 25),
    ];
  return holidays.some((h) => utcDateKey(h) === key);
}
function addBusinessDays(input: Date, days: number) {
  const d = new Date(input);
  let n = 0;
  while (n < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !isUsFederalBusinessHoliday(d)) n++;
  }
  return d.toISOString();
}

export async function validateCopyrightCounterNotice(db:PublishingDB,staff:StaffContext,raw:unknown){
 return dispatchPrivateTrustAction(db,"validate-counter",{actorUserId:staff.userId,raw});
}

export async function recordCopyrightCourtAction(db:PublishingDB,staff:StaffContext,raw:unknown){
 return dispatchPrivateTrustAction(db,"court-action",{actorUserId:staff.userId,raw});
}

async function recalcRepeatPolicy(_db:PublishingDB,_accountId:string){
 throw new ApiError(503,"Repeat-infringer policy must be evaluated at the private owner.");
}

export async function resolveRightsDispute(db:PublishingDB,staff:StaffContext,raw:unknown){
 const x=z.object({restoreContent:z.boolean().optional(),royaltyDisposition:z.enum(["release","continue_hold"]).optional()}).passthrough().parse(raw);
 if(x.restoreContent||x.royaltyDisposition==="release")
   throw new ApiError(503,"A rights restoration or royalty release requires fresh independently verified owner authorization.");
 return dispatchPrivateTrustAction(db,"resolve-dispute",{actorUserId:staff.userId,raw});
}

export async function manageRepeatInfringerPolicy(db:PublishingDB,staff:StaffContext,raw:unknown){
 return dispatchPrivateTrustAction(db,"repeat-policy",{actorUserId:staff.userId,raw});
}

export async function advanceRightsDisputeDeadlines(db: PublishingDB) {
  const due = (
    await db
      .prepare(
        "SELECT * FROM rights_disputes WHERE status='waiting_restore_window' AND litigation_hold=0 AND restore_not_before_at IS NOT NULL AND restore_not_before_at<=?",
      )
      .bind(now())
      .all<any>()
  ).results;
  // DO NOT acknowledge a restored work or notify a claimant of restoration
  // while the production owner is unavailable. Leave disputes pending and
  // explicitly fail the job so operators can resolve the legal deadline.
  if (due.length)
    throw new ApiError(
      503,
      "Copyright restoration deadline reached; independent legal-owner certification is required.",
    );
  return { checked: 0, restored: 0 };
}

export async function leaseRightsNotificationJobs(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        workerId: z.string().min(1).max(160),
        limit: z.number().int().min(1).max(100).default(20),
        leaseSeconds: z.number().int().min(30).max(1800).default(300),
      })
      .parse(raw),
    at = now(),
    until = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  await db
    .prepare(
      "UPDATE rights_notification_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts",
    )
    .bind(at, at, at)
    .run();
  const rows = (
    await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE status='queued' AND available_at<=? AND attempts<max_attempts ORDER BY created_at LIMIT ?",
      )
      .bind(at, x.limit)
      .all<any>()
  ).results;
  const leased: any[] = [];
  for (const r of rows) {
    await db
      .prepare(
        "UPDATE rights_notification_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",
      )
      .bind(x.workerId, until, at, r.id)
      .run();
    const got = await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?",
      )
      .bind(r.id, x.workerId)
      .first<any>();
    if (got) leased.push(got);
  }
  return { jobs: leased };
}
export async function completeRightsNotificationJob(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        jobId: z.string().min(1),
        workerId: z.string().min(1),
        status: z.enum(["sent", "failed"]),
        providerMessageId: z.string().max(500).default(""),
        error: z.string().max(2000).default(""),
      })
      .parse(raw),
    j = await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?",
      )
      .bind(x.jobId, x.workerId)
      .first<any>();
  if (!j)
    throw new ApiError(409, "Notification job lease is missing or no longer owned by this worker.");
  const terminal = x.status === "sent" || Number(j.attempts) >= Number(j.max_attempts),
    status = x.status === "sent" ? "sent" : terminal ? "failed" : "queued",
    available =
      status === "queued"
        ? new Date(
            Date.now() +
              Math.min(3600, 60 * Math.pow(2, Math.max(0, Number(j.attempts) - 1))) * 1000,
          ).toISOString()
        : j.available_at;
  await db
    .prepare(
      "UPDATE rights_notification_jobs SET status=?,provider_message_id=?,last_error=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
    )
    .bind(status, x.providerMessageId, x.error, available, now(), j.id)
    .run();
  return { id: j.id, status };
}

export async function leaseRightsEvidenceScanJobs(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "lease-rights-scan", raw);
}

export async function completeRightsEvidenceScanJob(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "complete-rights-scan", raw);
}

export async function reviewRightsEvidence(db:PublishingDB,staff:StaffContext,raw:unknown){
 return dispatchPrivateTrustAction(db,"review-evidence",{actorUserId:staff.userId,raw});
}

export async function resolveSimilarityMatch(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        id: z.string().min(1),
        disposition: z.enum(["cleared", "authorized_overlap", "infringing", "fraud_hold"]),
      })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_similarity_matches WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Similarity match not found.");
  await db
    .prepare("UPDATE publishing_similarity_matches SET disposition=?,updated_at=? WHERE id=?")
    .bind(x.disposition, now(), x.id)
    .run();
  return { saved: true, reviewedBy: staff.userId };
}
export async function resolveIdentitySimilarity(
  db: PublishingDB,
  staff: StaffContext,
  raw: unknown,
) {
  const x = z
      .object({ id: z.string().min(1), status: z.enum(["cleared", "authorized", "impersonation"]) })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_identity_similarity_matches WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Identity similarity match not found.");
  await db
    .prepare("UPDATE publishing_identity_similarity_matches SET status=?,updated_at=? WHERE id=?")
    .bind(x.status, now(), x.id)
    .run();
  if (x.status === "impersonation") {
    await createModerationCase(db, {
      subjectType: r.subject_type === "pen_name" ? "author" : "publisher",
      subjectId: String(r.subject_id),
      publishingAccountId: String(r.account_id),
      category: "impersonation",
      queue: "impersonation",
      priority: "high",
      sourceType: "identity_similarity",
      sourceRef: `identity-match:${r.id}`,
      riskScore: Number(r.similarity_score),
      summary: `Potential impersonation match: ${r.submitted_name} vs ${r.matched_name}.`,
    });
    let targetAccountId: string | null = null;
    if (r.matched_entity_type === "publishing_account")
      targetAccountId = String(r.matched_entity_id);
    else if (r.matched_entity_type === "pen_name")
      targetAccountId =
        (
          await db
            .prepare("SELECT account_id FROM publishing_pen_names WHERE id=?")
            .bind(r.matched_entity_id)
            .first<any>()
        )?.account_id || null;
    else if (r.matched_entity_type === "publisher")
      targetAccountId =
        (
          await db
            .prepare(
              "SELECT id FROM publishing_accounts WHERE publisher_id=? ORDER BY created_at LIMIT 1",
            )
            .bind(r.matched_entity_id)
            .first<any>()
        )?.id || null;
    if (targetAccountId && targetAccountId !== String(r.account_id))
      await upsertAccountRiskLink(
        db,
        String(r.account_id),
        String(targetAccountId),
        "repeated_impersonation_target",
        Math.max(90, Number(r.similarity_score || 0)),
        {
          identitySimilarityMatchId: r.id,
          matchedEntityType: r.matched_entity_type,
          matchedEntityId: r.matched_entity_id,
        },
      );
  }
  return { saved: true, reviewedBy: staff.userId };
}
export async function resolveRiskCluster(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        id: z.string().min(1),
        status: z.enum(["cleared", "confirmed_fraud", "monitoring"]),
        reason: z.string().max(5000).default(""),
      })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_risk_clusters WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Risk cluster not found.");
  await db
    .prepare("UPDATE publishing_risk_clusters SET status=?,reason=?,updated_at=? WHERE id=?")
    .bind(x.status, x.reason, now(), x.id)
    .run();
  return { saved: true, reviewedBy: staff.userId };
}

export async function rightsOperationsDashboard(db: PublishingDB) {
  const [
    disputes,
    notices,
    counters,
    holds,
    incidents,
    repeatStates,
    similarity,
    identityMatches,
    clusters,
    notifications,
    evidence,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT d.*,c.priority,c.status case_status,a.display_name publisher_name FROM rights_disputes d JOIN moderation_cases c ON c.id=d.case_id LEFT JOIN publishing_accounts a ON a.id=d.publishing_account_id ORDER BY d.created_at DESC LIMIT 500`,
      )
      .all<any>(),
    db.prepare("SELECT * FROM copyright_notices ORDER BY received_at DESC LIMIT 500").all<any>(),
    db
      .prepare("SELECT * FROM copyright_counter_notices ORDER BY received_at DESC LIMIT 500")
      .all<any>(),
    db.prepare("SELECT * FROM royalty_holds ORDER BY started_at DESC LIMIT 500").all<any>(),
    db
      .prepare("SELECT * FROM publisher_infringement_incidents ORDER BY decided_at DESC LIMIT 500")
      .all<any>(),
    db
      .prepare(
        "SELECT r.*,a.display_name publisher_name FROM repeat_infringer_policy_state r JOIN publishing_accounts a ON a.id=r.publishing_account_id ORDER BY active_strike_points DESC",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_similarity_matches WHERE disposition IN ('review','fraud_hold','infringing') ORDER BY score DESC,created_at DESC LIMIT 500",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_identity_similarity_matches WHERE status='review' ORDER BY similarity_score DESC,created_at DESC LIMIT 500",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT c.*,COUNT(m.account_id) member_count FROM publishing_risk_clusters c LEFT JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id GROUP BY c.id ORDER BY c.risk_score DESC,c.updated_at DESC LIMIT 300",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT notification_type,status,COUNT(*) count FROM rights_notification_jobs GROUP BY notification_type,status ORDER BY notification_type,status",
      )
      .all<any>(),
    db
      .prepare(
        `SELECT e.id,e.declaration_id,e.account_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at,d.rights_basis,d.edition_id,d.revision,a.display_name publisher_name FROM publishing_rights_evidence e JOIN publishing_rights_declarations d ON d.id=e.declaration_id JOIN publishing_accounts a ON a.id=e.account_id ORDER BY e.created_at DESC LIMIT 500`,
      )
      .all<any>(),
  ]);
  return {
    disputes: disputes.results,
    notices: notices.results,
    counters: counters.results,
    royaltyHolds: holds.results,
    infringementIncidents: incidents.results,
    repeatInfringerStates: repeatStates.results,
    similarityMatches: similarity.results,
    identityMatches: identityMatches.results,
    riskClusters: clusters.results,
    notificationQueue: notifications.results,
    rightsEvidence: evidence.results,
  };
}

export async function publisherRightsSnapshot(db: PublishingDB, userId: string, accountId: string) {
  await member(db, userId, accountId, "analyst");
  const [declarations, evidence, ai, accessibility, disputes, counters, holds] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM publishing_rights_declarations WHERE account_id=? ORDER BY signed_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT e.id,e.declaration_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at FROM publishing_rights_evidence e WHERE e.account_id=? ORDER BY e.created_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_ai_disclosures WHERE account_id=? ORDER BY signed_at DESC")
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT d.* FROM publishing_accessibility_declarations d JOIN publishing_edition_drafts e ON e.id=d.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY d.created_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM rights_disputes WHERE publishing_account_id=? ORDER BY created_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM copyright_counter_notices WHERE publishing_account_id=? ORDER BY received_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare("SELECT * FROM royalty_holds WHERE publishing_account_id=? ORDER BY started_at DESC")
      .bind(accountId)
      .all<any>(),
  ]);
  return {
    rightsDeclarations: declarations.results,
    rightsEvidence: evidence.results,
    aiDisclosures: ai.results,
    accessibilityDeclarations: accessibility.results,
    rightsDisputes: disputes.results,
    counterNotices: counters.results,
    royaltyHolds: holds.results,
  };
}
