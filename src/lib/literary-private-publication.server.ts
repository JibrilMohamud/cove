import type { CoveEnv } from "../features/fore/api.server";

type D1 = CoveEnv["DB"];
export type PrivateLiteraryPublisherEnv = {
  DB: D1;
  CONTENT_DB?: D1;
  FORE_CONTENT_PROCESSOR_ENABLED?: string;
  FORE_CONTENT_PREPARE_ENABLED?: string;
  FORE_CONTENT_INFERENCE_ENABLED?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: string;
  FORE_LITERARY_AUTOPUBLISH_ENABLED?: string;
  FORE_LITERARY_INFERENCE_PUBLISH_TOKEN?: string;
  FORE_LITERARY_INFERENCE_BACKEND_TOKEN?: string;
  LITERARY_PUBLISHER?: { fetch(request: Request): Promise<Response> };
};
type Job = {
  id: string;
  product_id: string;
  profile_fingerprint: string;
  profile_revision: number;
  publication_attempts: number;
};
type Profile = {
  fingerprint: string;
  revision: number;
  status: string;
  coverage: string;
};
const ownerSql = "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'";
const nowIso = () => new Date().toISOString();
const retrySeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.min(6, attempts));

async function currentOwner(db: D1) {
  const row = await db.prepare(ownerSql).first<{ value: string }>();
  return row?.value || "legacy";
}

/**
 * One replay-safe isolated inference publication per tick. A done inference
 * row itself is the durable intent: failure between inference completion and
 * the next cron cannot lose the publication. One leased secondary claim and
 * one guarded canonical update, with no scans of the primary job backlog.
 */
export async function publishOnePrivateLiteraryInference(env: PrivateLiteraryPublisherEnv) {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_INFERENCE_ENABLED !== "1" ||
    env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-infer" ||
    env.FORE_LITERARY_AUTOPUBLISH_ENABLED !== "1"
  )
    return { skipped: "private_publication_disabled" };
  const pub = env.LITERARY_PUBLISHER;
  const token = env.FORE_LITERARY_INFERENCE_PUBLISH_TOKEN || "";
  const backendToken = env.FORE_LITERARY_INFERENCE_BACKEND_TOKEN || "";
  if (
    !pub ||
    token.length < 40 ||
    token.length > 256 ||
    backendToken.length < 40 ||
    backendToken.length > 256 ||
    token === backendToken
  )
    return { skipped: "private_publisher_not_bound" };
  if (!env.CONTENT_DB || env.CONTENT_DB === env.DB) throw Error("publication_binding_not_isolated");
  if ((await currentOwner(env.DB)) !== "isolated")
    return { skipped: "canonical_owner_not_isolated" };
  const identity = await env.CONTENT_DB.prepare(
    "SELECT domain,schema_version," +
      " EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND" +
      " name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_domain_identity WHERE id=1",
  ).first<{ domain: string; schema_version: number; contaminated: number }>();
  if (
    identity?.domain !== "cove-isolated-literary-budget" ||
    identity.schema_version !== 1 ||
    identity.contaminated
  )
    throw Error("publication_binding_not_isolated");
  const claim = crypto.randomUUID();
  const now = nowIso();
  const lease = new Date(Date.now() + 120_000).toISOString();
  const job = await env.CONTENT_DB.prepare(
    "UPDATE literary_inference_jobs SET publication_state='running'," +
      "publication_lease_token=?,publication_lease_until=?," +
      "publication_attempts=publication_attempts+1" +
      " WHERE id=(SELECT id FROM literary_inference_jobs" +
      " INDEXED BY idx_literary_inference_publication_due" +
      " WHERE status='done' AND" +
      " ((publication_state='pending' AND publication_available_at<=?) OR" +
      " (publication_state='running' AND publication_lease_until<?))" +
      " ORDER BY publication_available_at,id LIMIT 1)" +
      " RETURNING id,product_id,profile_fingerprint,profile_revision,publication_attempts",
  )
    .bind(claim, lease, now, now)
    .first<Job>();
  if (!job) return { skipped: "no_completed_inference" };
  // An ownership rollback between the initial read and the claim must not
  // send an authorized publication attempt into the primary database.
  if ((await currentOwner(env.DB)) !== "isolated")
    return { skipped: "canonical_owner_changed_after_claim" };

  async function settle(state: "published" | "held", reason: string) {
    const stamp = nowIso();
    const isolated = env.CONTENT_DB!;
    const row = await isolated
      .prepare(
        "UPDATE literary_inference_jobs SET publication_state=?," +
          "publication_lease_token='',publication_lease_until=''," +
          "publication_last_error=?,published_at=?" +
          " WHERE id=? AND publication_state='running' AND publication_lease_token=?" +
          " AND publication_lease_until>? RETURNING id",
      )
      .bind(state, reason, state === "published" ? stamp : "", job!.id, claim, stamp)
      .first<{ id: string }>();
    if (!row) throw Error("private_publication_lease_lost");
    return state === "published" ? { published: job!.id } : { held: job!.id, reason };
  }
  try {
    const response = await pub.fetch(
      new Request("https://literary-publisher.internal/v1/operator/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cove-literary-publish-token": token,
          "x-cove-literary-backend-token": backendToken,
        },
        body: JSON.stringify({ jobId: job.id }),
      }),
    );
    if (response.status !== 200) throw Error("private_publisher_status_" + response.status);
    const result = (await response.json()) as { published?: string; skipped?: string };
    if (result?.published === job.product_id) return settle("published", "");
    if (result?.skipped === "rights_source_or_version_changed") {
      // A successful primary write followed by a lost secondary ACK replays.
      // Confirm the exact profile revision before treating it as a duplicate.
      const prior = await env.DB.prepare(
        "SELECT fingerprint,revision,status,coverage FROM literary_profiles WHERE product_id=?",
      )
        .bind(job.product_id)
        .first<Profile>();
      if (
        prior?.fingerprint === job.profile_fingerprint &&
        prior.revision === job.profile_revision + 1 &&
        prior.status === "analyzed" &&
        prior.coverage === "isolated_samples"
      )
        return settle("published", "replayed_canonical_success");
      return settle("held", "rights_source_or_version_changed");
    }
    throw Error("private_publisher_not_ready");
  } catch (error) {
    const reason = String(error).slice(0, 90);
    const next = new Date(Date.now() + retrySeconds(job.publication_attempts) * 1000).toISOString();
    await env.CONTENT_DB.prepare(
      "UPDATE literary_inference_jobs SET publication_state='pending'," +
        "publication_available_at=?,publication_lease_token='',publication_lease_until=''," +
        "publication_last_error=?" +
        " WHERE id=? AND publication_state='running' AND publication_lease_token=?",
    )
      .bind(next, reason, job.id, claim)
      .run();
    return { deferred: job.id, reason };
  }
}
