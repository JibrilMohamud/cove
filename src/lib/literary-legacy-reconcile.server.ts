import type { HandoffEnv } from "./literary-prepare-outbox.server";
import { seedLiteraryPreparationHandoff } from "./literary-prepare-outbox.server";
import { requireIsolatedDomain } from "./literary-preparation-domain.server";

export type LegacyReconcileEnv = HandoffEnv & {
  FORE_LITERARY_DRAIN_RECONCILE_ENABLED?: string;
};
type Cursor = { status: string; after_job_id: string };
type LegacyJob = {
  legacy_job_id: string;
  product_id: string;
  edition_id: string | null;
  fingerprint: string;
  current_fingerprint: string | null;
  profile_status: string | null;
};

/**
 * One legacy job per tick. The primary owner is checked before all work; the
 * independent cursor/receipt commit follows the durable rights-guarded outbox
 * write, making a lost ACK replay the exact same primary intent.
 */
export async function reconcileOneLegacyLiteraryJob(
  env: LegacyReconcileEnv,
  seed: typeof seedLiteraryPreparationHandoff = seedLiteraryPreparationHandoff,
) {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_HANDOFF_ENABLED !== "1" ||
    env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-handoff" ||
    env.FORE_LITERARY_DRAIN_RECONCILE_ENABLED !== "1"
  )
    return { skipped: "legacy_reconciliation_disabled" };
  const owner = await env.DB.prepare(
    "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
  ).first<{ value: string }>();
  if (owner?.value !== "draining") return { skipped: "legacy_owner_not_draining" };
  const isolated = await requireIsolatedDomain(env);
  const cursor = await isolated
    .prepare("SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1")
    .first<Cursor>();
  if (!cursor) throw Error("legacy_reconciliation_migration_required");
  if (cursor.status !== "armed") return { skipped: "legacy_reconciliation_not_armed" };
  const now = new Date().toISOString();
  // Refuse any handoff while a pre-fence legacy preparation, analyze claim or
  // catalog sweep still has an unexpired lease. Operators must also verify
  // actual Worker termination; lease expiry alone is insufficient proof.
  const leases = await env.DB.prepare(
    "SELECT EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1 AND lease_until>?) sweep," +
      " EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running'" +
      " AND lease_until>? LIMIT 1) running",
  )
    .bind(now, now)
    .first<{ sweep: number; running: number }>();
  if (!leases || leases.sweep || leases.running) return { skipped: "legacy_leases_not_drained" };
  // The materialized one-row unfinished-job frontier must be resolved BEFORE
  // joining profile metadata. Otherwise a long run of stale fingerprints
  // could force an unbounded primary-D1 scan looking for an eligible job.
  const job = await env.DB.prepare(
    "SELECT j.id legacy_job_id,j.product_id,j.fingerprint,p.edition_id," +
      " lp.fingerprint current_fingerprint,lp.status profile_status" +
      " FROM (SELECT id,product_id,fingerprint FROM literary_profile_jobs" +
      " INDEXED BY idx_literary_legacy_reconcile" +
      " WHERE id>? AND status IN ('queued','failed') ORDER BY id LIMIT 1) j" +
      " LEFT JOIN literary_profiles lp ON lp.product_id=j.product_id" +
      " LEFT JOIN products p ON p.id=j.product_id",
  )
    .bind(cursor.after_job_id)
    .first<LegacyJob>();
  if (!job) {
    await isolated
      .prepare(
        "UPDATE literary_legacy_reconcile_frontier SET status='complete',updated_at=?" +
          " WHERE id=1 AND status='armed' AND after_job_id=?",
      )
      .bind(now, cursor.after_job_id)
      .run();
    return { complete: true };
  }
  // If an operator changed ownership mid-tick, do not send new intents.
  const stillDraining = await env.DB.prepare(
    "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
  ).first<{ value: string }>();
  if (stillDraining?.value !== "draining") return { skipped: "legacy_owner_changed" };
  const eligible =
    job.edition_id &&
    job.current_fingerprint === job.fingerprint &&
    job.profile_status === "provisional";
  const result = eligible
    ? await seed(env, job.product_id, job.edition_id!, "draining")
    : { skipped: "legacy_profile_not_current" };
  const seeded = "outboxId" in result && typeof result.outboxId === "string";
  const disposition = seeded ? "seeded" : "held";
  const outboxId = seeded ? result.outboxId : null;
  const reason = seeded
    ? ""
    : "skipped" in result
      ? String(result.skipped).slice(0, 90)
      : "unknown";
  // D1 batch commits receipt + cursor atomically in CONTENT_DB. If interrupted
  // before this point, the idempotent primary outbox is replayed next tick.
  await isolated.batch([
    isolated
      .prepare(
        "INSERT OR IGNORE INTO literary_legacy_reconcile_receipts" +
          "(legacy_job_id,product_id,profile_fingerprint,disposition,outbox_id,reason,created_at)" +
          " VALUES(?,?,?,?,?,?,?)",
      )
      .bind(job.legacy_job_id, job.product_id, job.fingerprint, disposition, outboxId, reason, now),
    isolated
      .prepare(
        "UPDATE literary_legacy_reconcile_frontier SET after_job_id=?,updated_at=?" +
          " WHERE id=1 AND status='armed' AND after_job_id=?",
      )
      .bind(job.legacy_job_id, now, cursor.after_job_id),
  ]);
  return {
    reconciled: job.legacy_job_id,
    disposition,
    ...(seeded ? { outboxId } : { reason }),
  };
}
