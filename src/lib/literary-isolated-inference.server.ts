import {
  PROFILE_MODEL,
  PROFILE_POLICY,
  literaryPrompt,
  literaryJsonSchema,
  validateLiteraryProfile,
  type ProfileEvidence,
} from "../features/fore/literary-profile";
import type { CoveEnv } from "../features/fore/api.server";
import { LITERARY_GENERATION_LIMITS } from "../features/fore/literary-profiles.server";
import { literarySourceRightsPredicate } from "./literary-prepare-outbox.server";
import { requireIsolatedDomain, type PreparationEnv } from "./literary-preparation-domain.server";
import { reserveLiteraryBudget, resolveLiteraryBudgetDb } from "./literary-budget-domain.server";
import {
  recordLiteraryAiInvocation,
  settleIsolatedLiteraryJob,
} from "./literary-job-settlement.server";

type D1 = CoveEnv["DB"];
export type IsolatedInferenceEnv = PreparationEnv & {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  FORE_CONTENT_BUDGET_MODE?: string;
  FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT?: string;
  FORE_LITERARY_AI_USAGE_TELEMETRY_ENABLED?: string;
  FORE_LITERARY_INFERENCE_PUBLISH_ENABLED?: string;
};
type Prepared = {
  id: string;
  product_id: string;
  edition_id: string;
  source_id: string;
  content_sha256: string;
  result_key: string;
  result_sha256: string;
};
type InferenceJob = {
  id: string;
  prepare_job_id: string;
  product_id: string;
  edition_id: string;
  source_id: string;
  source_sha256: string;
  profile_fingerprint: string;
  profile_revision: number;
  attempts: number;
  result_key: string | null;
  result_sha256: string | null;
};
type InferenceResult = {
  version: 1;
  preparedJobId: string;
  jobId: string;
  productId: string;
  editionId: string;
  sourceId: string;
  sourceSha256: string;
  fingerprint: string;
  revision: number;
  policy: string;
  model: string;
  profile: unknown;
};
const shaPattern = /^[0-9a-f]{64}$/;
const iso = () => new Date().toISOString();
async function sha(bytes: Uint8Array | string) {
  const owned = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const d = await crypto.subtle.digest("SHA-256", Uint8Array.from(owned).buffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function assertInferenceEnabled(env: IsolatedInferenceEnv) {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_INFERENCE_ENABLED !== "1" ||
    env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-infer" ||
    env.FORE_CONTENT_BUDGET_MODE !== "isolated" ||
    !env.BUCKET ||
    !env.AI ||
    !env.CONTENT_DB ||
    env.CONTENT_DB === env.DB
  )
    throw new Error("isolated_literary_inference_disabled");
}
async function rightsCurrent(
  db: D1,
  job: {
    product_id: string;
    edition_id: string;
    source_id: string;
    source_sha256: string;
  },
) {
  const current = await db
    .prepare(
      "SELECT c.id" + literarySourceRightsPredicate + " AND c.id=? AND c.content_hash=? LIMIT 1",
    )
    .bind(job.product_id, job.edition_id, job.source_id, job.source_sha256)
    .first<{ id: string }>();
  return !!current;
}
function preparedKey(id: string) {
  if (!shaPattern.test(id)) throw Error("invalid_prepared_id");
  return "literary/isolated-prepared-v1/" + id + ".json";
}
function inferenceKey(id: string) {
  if (!shaPattern.test(id)) throw Error("invalid_inference_id");
  return "literary/isolated-inference-v1/" + id + ".json";
}
async function verifiedJson(
  bucket: NonNullable<PreparationEnv["BUCKET"]>,
  key: string,
  expected: string,
) {
  if (!shaPattern.test(expected)) throw Error("unverified_literary_hash");
  const object = await bucket.get(key);
  if (
    !object ||
    object.size < 100 ||
    object.size > 100_000 ||
    object.customMetadata?.sha256 !== expected ||
    object.httpMetadata?.contentType !== "application/json"
  )
    throw Error("missing_or_unverified_literary_artifact");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha(bytes)) !== expected) throw Error("literary_artifact_sha_mismatch");
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
async function evidence(env: IsolatedInferenceEnv, prepared: Prepared) {
  if (prepared.result_key !== preparedKey(prepared.id) || !shaPattern.test(prepared.content_sha256))
    throw Error("untrusted_preparation_receipt");
  const payload = await verifiedJson(env.BUCKET!, prepared.result_key, prepared.result_sha256);
  if (
    payload.version !== 1 ||
    payload.productId !== prepared.product_id ||
    payload.editionId !== prepared.edition_id ||
    payload.sourceId !== prepared.source_id ||
    payload.sourceSha256 !== prepared.content_sha256 ||
    !Array.isArray(payload.selected) ||
    payload.selected.length < 1 ||
    payload.selected.length > 3
  )
    throw Error("untrusted_preparation_manifest");
  const selected: ProfileEvidence[] = payload.selected.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw Error("invalid_literary_evidence");
    const x = raw as Record<string, unknown>;
    if (
      typeof x.id !== "string" ||
      x.id.length < 1 ||
      x.id.length > 180 ||
      typeof x.text !== "string" ||
      x.text.length < 1 ||
      x.text.length > 4000 ||
      typeof x.href !== "string" ||
      x.href.length > 300 ||
      !Number.isSafeInteger(x.spineIndex) ||
      Number(x.spineIndex) < 0 ||
      !Array.isArray(x.locator) ||
      x.locator.length !== 2 ||
      !x.locator.every((v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0)
    )
      throw Error("invalid_literary_evidence");
    return { id: x.id, kind: "excerpt", text: x.text, locator: String(x.href) };
  });
  if (new Set(selected.map((x) => x.id)).size !== selected.length)
    throw Error("duplicate_literary_evidence_ids");
  return selected;
}
async function preparedReceipt(db: D1, id: string) {
  return db
    .prepare(
      "SELECT id,product_id,edition_id,source_id,content_sha256,result_key,result_sha256" +
        " FROM literary_prepare_jobs WHERE id=? AND status='done'",
    )
    .bind(id)
    .first<Prepared>();
}

/** Exactly one indexed completed-job scan, one primary profile read and one content enqueue. */
export async function seedOneIsolatedLiteraryInference(env: IsolatedInferenceEnv) {
  assertInferenceEnabled(env);
  const isolated = await requireIsolatedDomain(env);
  const cursor = await isolated
    .prepare("SELECT after_updated_at,after_id FROM literary_inference_seed_frontier WHERE id=1")
    .first<{ after_updated_at: string; after_id: string }>();
  if (!cursor) throw Error("isolated_inference_frontier_not_migrated");
  const pending = await isolated
    .prepare(
      "SELECT p.id,p.product_id,p.edition_id,p.source_id,p.content_sha256," +
        "p.result_key,p.result_sha256,p.updated_at" +
        " FROM literary_prepare_jobs p WHERE p.status='done'" +
        " AND (p.updated_at>? OR (p.updated_at=? AND p.id>?))" +
        " AND NOT EXISTS(SELECT 1 FROM literary_inference_jobs i WHERE i.prepare_job_id=p.id)" +
        " ORDER BY p.updated_at,p.id LIMIT 1",
    )
    .bind(cursor.after_updated_at, cursor.after_updated_at, cursor.after_id)
    .first<Prepared & { updated_at: string }>();
  if (!pending) {
    await isolated
      .prepare(
        "UPDATE literary_inference_seed_frontier SET after_updated_at='',after_id='' WHERE id=1",
      )
      .run();
    return { skipped: "no_prepared_evidence" };
  }
  // Fairness only: record that this candidate was examined, even if its
  // canonical rights have since been withdrawn. Never copy legal authority.
  await isolated
    .prepare("UPDATE literary_inference_seed_frontier SET after_updated_at=?,after_id=? WHERE id=1")
    .bind(pending.updated_at, pending.id)
    .run();
  if (!(await rightsCurrent(env.DB, { ...pending, source_sha256: pending.content_sha256 })))
    return { skipped: "source_or_rights_changed" };
  const profile = await env.DB.prepare(
    "SELECT fingerprint,revision FROM literary_profiles" +
      " WHERE product_id=? AND status='provisional' AND policy_version=?",
  )
    .bind(pending.product_id, PROFILE_POLICY)
    .first<{ fingerprint: string; revision: number }>();
  if (!profile || !shaPattern.test(profile.fingerprint) || !Number.isSafeInteger(profile.revision))
    return { skipped: "current_provisional_profile_unavailable" };
  const id = await sha([pending.id, profile.fingerprint, PROFILE_POLICY, PROFILE_MODEL].join(":"));
  const now = iso();
  await isolated
    .prepare(
      "INSERT OR IGNORE INTO literary_inference_jobs" +
        "(id,prepare_job_id,product_id,edition_id,source_id,source_sha256," +
        "profile_fingerprint,profile_revision,available_at,created_at,updated_at)" +
        " SELECT ?,p.id,p.product_id,p.edition_id,p.source_id,p.content_sha256,?,?,?,?,?" +
        " FROM literary_prepare_jobs p WHERE p.id=? AND p.status='done'" +
        " AND p.content_sha256=? AND p.result_sha256=?",
    )
    .bind(
      id,
      profile.fingerprint,
      profile.revision,
      now,
      now,
      now,
      pending.id,
      pending.content_sha256,
      pending.result_sha256,
    )
    .run();
  return { enqueued: id };
}

/** One inference lease; NO primary writes until separately gated canonical publisher. */
export async function runIsolatedLiteraryInferenceTick(env: IsolatedInferenceEnv) {
  assertInferenceEnabled(env);
  const isolated = await requireIsolatedDomain(env);
  const token = crypto.randomUUID(),
    now = iso();
  await isolated
    .prepare(
      "UPDATE literary_inference_jobs SET status='failed',lease_token='',lease_until=''," +
        "last_error='expired_final_attempt',updated_at=?" +
        " WHERE status='running' AND lease_until<? AND attempts>=3",
    )
    .bind(now, now)
    .run();
  const job = await isolated
    .prepare(
      "UPDATE literary_inference_jobs SET status='running',lease_token=?," +
        "lease_until=?,attempts=attempts+1,updated_at=?" +
        " WHERE id=(SELECT id FROM literary_inference_jobs WHERE" +
        " ((status='queued' AND available_at<=?) OR (status='running' AND lease_until<?))" +
        " AND attempts<3 ORDER BY available_at,id LIMIT 1)" +
        " RETURNING id,prepare_job_id,product_id,edition_id,source_id,source_sha256," +
        " profile_fingerprint,profile_revision,attempts,result_key,result_sha256",
    )
    .bind(token, new Date(Date.now() + 300000).toISOString(), now, now, now)
    .first<InferenceJob>();
  if (!job) return { skipped: "no_inference_jobs" };
  try {
    const prepared = await preparedReceipt(isolated, job.prepare_job_id);
    if (
      !prepared ||
      job.source_sha256 !== prepared.content_sha256 ||
      job.source_id !== prepared.source_id ||
      job.product_id !== prepared.product_id ||
      job.edition_id !== prepared.edition_id
    )
      throw Error("prepared_job_changed");
    const sources = await evidence(env, prepared);
    if (!(await rightsCurrent(env.DB, job))) throw Error("rights_or_source_changed");
    const key = inferenceKey(job.id);
    const existing = await env.BUCKET!.head?.(key);
    let output: InferenceResult, outputHash: string;
    if (existing) {
      outputHash = String(existing.customMetadata?.sha256 || "");
      output = (await verifiedJson(env.BUCKET!, key, outputHash)) as unknown as InferenceResult;
    } else {
      const prompt = literaryPrompt(sources);
      const units =
        prompt.system.length +
        prompt.user.length +
        LITERARY_GENERATION_LIMITS.reservedOutputCharacters;
      const day = iso().slice(0, 10);
      // Honor the same authoritative configured cap as the legacy lane,
      // rather than secretly raising (or lowering) the book-inference quota.
      const setting = await env.DB.prepare(
        "SELECT value FROM cove_runtime_config WHERE key='literary_daily_units'",
      ).first<{ value: string }>();
      const configured = Number(setting?.value ?? 2_000_000);
      const limit = Math.max(
        0,
        Math.min(100_000_000, Number.isFinite(configured) ? configured : 2_000_000),
      );
      const budgetDb = await resolveLiteraryBudgetDb(env, day);
      const reserved = await reserveLiteraryBudget(budgetDb, day, units, limit, true);
      if (!reserved) throw Error("daily_budget_exhausted");
      const raw = await env.AI!.run(PROFILE_MODEL, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: LITERARY_GENERATION_LIMITS.maxOutputTokens,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: literaryJsonSchema(sources) },
      });
      if (env.FORE_LITERARY_AI_USAGE_TELEMETRY_ENABLED === "1") {
        try {
          await recordLiteraryAiInvocation(budgetDb, job.id, PROFILE_MODEL, raw);
        } catch (err) {
          console.warn("literary_ai_usage_unavailable", String(err).slice(0, 120));
        }
      }
      const answer = raw && typeof raw === "object" && "response" in raw ? raw.response : null;
      const profile = validateLiteraryProfile(
        typeof answer === "string" ? JSON.parse(answer) : answer,
        sources,
      );
      output = {
        version: 1,
        preparedJobId: job.prepare_job_id,
        jobId: job.id,
        productId: job.product_id,
        editionId: job.edition_id,
        sourceId: job.source_id,
        sourceSha256: job.source_sha256,
        fingerprint: job.profile_fingerprint,
        revision: job.profile_revision,
        policy: PROFILE_POLICY,
        model: PROFILE_MODEL,
        profile,
      };
      const serialized = JSON.stringify(output);
      outputHash = await sha(serialized);
      if (!(await rightsCurrent(env.DB, job)))
        throw Error("rights_revoked_before_inference_receipt");
      // A timed-out lease owner may finish after its replacement has started.
      // Never overwrite a result already committed under this immutable job ID:
      // doing so would make a successful secondary D1 SHA receipt unreadable.
      const stored = await env.BUCKET!.put(key, serialized, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sha256: outputHash },
      });
      if (stored === null) {
        // Another lease holder won the atomic R2 create-if-absent race.
        // Adopt only its fully verified bytes, never the losing candidate.
        const winner = await env.BUCKET!.head?.(key);
        if (!winner) throw Error("literary_inference_r2_race_missing_winner");
        outputHash = String(winner.customMetadata?.sha256 || "");
        output = (await verifiedJson(env.BUCKET!, key, outputHash)) as unknown as InferenceResult;
      }
      // Only the worker whose conditional R2 PUT succeeded is eligible for
      // its own output-credit settlement. A losing racer must not credit based
      // on bytes different from the immutable winning artifact.
      if (stored !== null && env.FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT === "1") {
        try {
          await settleIsolatedLiteraryJob(budgetDb, {
            day,
            jobId: job.id,
            resultKey: key,
            resultSha256: outputHash,
            leaseToken: token,
            promptCharacters: prompt.system.length + prompt.user.length,
            outputCharacters: Math.max(
              JSON.stringify(profile).length,
              typeof answer === "string" ? answer.length : JSON.stringify(answer).length,
            ),
            reservedOutputCharacters: LITERARY_GENERATION_LIMITS.reservedOutputCharacters,
          });
        } catch (err) {
          // A failed/missing migration or unfunded settlement conservatively
          // leaves the original reservation fully charged.
          console.warn("literary_job_settlement_unavailable", String(err).slice(0, 120));
        }
      }
    }
    if (
      output.jobId !== job.id ||
      output.preparedJobId !== job.prepare_job_id ||
      output.productId !== job.product_id ||
      output.editionId !== job.edition_id ||
      output.sourceId !== job.source_id ||
      output.sourceSha256 !== job.source_sha256 ||
      output.fingerprint !== job.profile_fingerprint ||
      output.revision !== job.profile_revision ||
      output.policy !== PROFILE_POLICY ||
      output.model !== PROFILE_MODEL
    )
      throw Error("cached_inference_identity_mismatch");
    const updated = await isolated
      .prepare(
        "UPDATE literary_inference_jobs SET status='done',result_key=?,result_sha256=?," +
          "lease_token='',lease_until='',updated_at=?" +
          " WHERE id=? AND status='running' AND lease_token=? AND lease_until>?" +
          " RETURNING id",
      )
      .bind(key, outputHash, iso(), job.id, token, iso())
      .first<{ id: string }>();
    if (!updated) throw Error("isolated_inference_lease_lost");
    return { inferred: job.id };
  } catch (err) {
    const reason = String(err).slice(0, 140);
    const unrecoverable =
      /rights_|source_changed|artifact_sha|identity_mismatch|prepared_job_changed|untrusted_|invalid_literary/.test(
        reason,
      );
    const budget = reason.includes("daily_budget_exhausted");
    const retry = !unrecoverable && (job.attempts < 3 || budget);
    const next = budget
      ? new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString()
      : new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)).toISOString();
    await isolated
      .prepare(
        "UPDATE literary_inference_jobs SET status=?,available_at=?,attempts=attempts-?," +
          "lease_token='',lease_until='',last_error=?,updated_at=?" +
          " WHERE id=? AND lease_token=? AND status='running'",
      )
      .bind(retry ? "queued" : "failed", next, budget ? 1 : 0, reason, iso(), job.id, token)
      .run();
    return { failed: job.id, reason };
  }
}

/** Canonical-only, single indexed guarded UPDATE; no eventually consistent rights copy. */
export async function publishIsolatedLiteraryInference(env: IsolatedInferenceEnv, jobId: string) {
  if (
    env.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED !== "1" ||
    !env.CONTENT_DB ||
    env.CONTENT_DB === env.DB ||
    !env.BUCKET
  )
    throw Error("literary_inference_publication_disabled");
  if (!shaPattern.test(jobId)) throw Error("invalid_inference_id");
  const identity = await env.CONTENT_DB.prepare(
    "SELECT i.domain,i.schema_version," +
      " EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND" +
      " name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_domain_identity i WHERE i.id=1",
  ).first<{ domain: string; schema_version: number; contaminated: number }>();
  if (
    identity?.domain !== "cove-isolated-literary-budget" ||
    identity.schema_version !== 1 ||
    identity.contaminated
  )
    throw Error("literary_inference_binding_not_isolated");
  const job = await env.CONTENT_DB.prepare(
    "SELECT id,prepare_job_id,product_id,edition_id,source_id,source_sha256," +
      "profile_fingerprint,profile_revision,attempts,result_key,result_sha256" +
      " FROM literary_inference_jobs WHERE id=? AND status='done'",
  )
    .bind(jobId)
    .first<InferenceJob>();
  if (!job) return { skipped: "inference_not_ready" };
  if (job.result_key !== inferenceKey(job.id) || !job.result_sha256)
    throw Error("invalid_inference_receipt");
  const result = await verifiedJson(env.BUCKET, job.result_key, job.result_sha256);
  if (
    result.version !== 1 ||
    result.jobId !== job.id ||
    result.preparedJobId !== job.prepare_job_id ||
    result.productId !== job.product_id ||
    result.editionId !== job.edition_id ||
    result.sourceId !== job.source_id ||
    result.sourceSha256 !== job.source_sha256 ||
    result.fingerprint !== job.profile_fingerprint ||
    result.revision !== job.profile_revision ||
    result.policy !== PROFILE_POLICY ||
    result.model !== PROFILE_MODEL
  )
    throw Error("untrusted_inference_manifest");
  const prepared = await preparedReceipt(env.CONTENT_DB, job.prepare_job_id);
  if (
    !prepared ||
    prepared.source_id !== job.source_id ||
    prepared.content_sha256 !== job.source_sha256
  )
    throw Error("missing_preparation_provenance");
  const sources = await evidence(env, prepared);
  const profile = validateLiteraryProfile(result.profile, sources);
  const now = iso();
  // A single primary indexed write verifies source authority and deny precedence
  // within the mutation; mismatching revisions and expired grants fail closed.
  const written = await env.DB.prepare(
    "UPDATE literary_profiles SET profile_json=?,status='analyzed'," +
      "coverage='isolated_samples',revision=revision+1,updated_at=?" +
      " WHERE product_id=? AND fingerprint=? AND revision=?" +
      " AND status='provisional' AND policy_version=?" +
      " AND EXISTS(SELECT 1" +
      literarySourceRightsPredicate +
      " AND c.id=? AND c.content_hash=?) RETURNING product_id",
  )
    .bind(
      JSON.stringify(profile),
      now,
      job.product_id,
      job.profile_fingerprint,
      job.profile_revision,
      PROFILE_POLICY,
      job.product_id,
      job.edition_id,
      job.source_id,
      job.source_sha256,
    )
    .first<{ product_id: string }>();
  return written
    ? { published: written.product_id }
    : { skipped: "rights_source_or_version_changed" };
}
