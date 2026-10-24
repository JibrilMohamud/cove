import { QUIET_READING_POLICY } from "../features/fore/quiet-reading-score";
import type { MusicSupplyEnv } from "./worker";

type Db = NonNullable<MusicSupplyEnv["MUSIC_DB"]>;
type Bucket = NonNullable<MusicSupplyEnv["MUSIC_BUCKET"]>;
type Row = { master_id: string; contract_id: string; master_sha256: string; lease_token: string; attempts: number; manifest_json: string; storage_key: string | null; bytes: number; sha256: string; report_sha256: string | null; report_key: string | null; status: string };
type BatchRow<T> = { results?: T[] };
const time = () => new Date().toISOString();
const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const sha = /^[0-9a-f]{64}$/;
const leasePattern = /^[a-f0-9-]{36}$/;
const reply = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });
async function body(req: Request, max = 4000): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") || 0) > max)
    throw new Error("music_execution_payload_too_large");
  if (!req.body) throw new Error("music_execution_body_required");
  const reader = req.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      throw new Error("music_execution_payload_too_large");
    }
    pieces.push(part.value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const part of pieces) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("music_execution_bad_payload");
  return value as Record<string, unknown>;
}
function fingerprint(h: ArrayBuffer | string | undefined) {
  return typeof h === "string"
    ? h.toLowerCase()
    : h
      ? [...new Uint8Array(h)].map((n) => n.toString(16).padStart(2, "0")).join("")
      : "";
}
/** Intake leases are authoritative even when an older Worker tries direct PUT. */
export async function checkIntakeLease(db: Db, master: string, sha256: string, lease: string) {
  if (!leasePattern.test(lease)) return false;
  return !!(await db.prepare(
    "SELECT 1 valid FROM music_intake_jobs j JOIN music_masters m ON m.id=j.master_id" +
      " JOIN music_contracts c ON c.id=m.contract_id" +
      " JOIN music_source_limits q ON q.contract_id=c.id" +
      " WHERE j.master_id=? AND j.master_sha256=? AND j.status='running'" +
      " AND j.lease_token=? AND j.lease_until>? AND m.status='quarantined'" +
      " AND m.sha256=j.master_sha256 AND c.status='active' AND c.expires_at>?" +
      " AND q.paused=0",
  ).bind(master, sha256, lease, time(), time()).first());
}
export async function finishIntake(db: Db, master: string, sha256: string, key: string, lease: string, size: number) {
  const now = time();
  // Both durable update and receipt share the same isolated D1 transaction.
  const results = await db.batch([
    db.prepare(
      "UPDATE music_masters SET storage_key=?,status='staged',updated_at=?" +
        " WHERE id=? AND sha256=? AND status='quarantined'" +
        " AND EXISTS(SELECT 1 FROM music_intake_jobs j WHERE j.master_id=music_masters.id" +
        " AND j.master_sha256=music_masters.sha256 AND j.status='running' AND j.lease_token=?" +
        " AND j.lease_until>?)" +
        " AND EXISTS(SELECT 1 FROM music_contracts c JOIN music_source_limits q ON q.contract_id=c.id" +
        " WHERE c.id=music_masters.contract_id AND c.status='active' AND c.expires_at>?" +
        " AND q.paused=0) RETURNING id",
    ).bind(key, now, master, sha256, lease, now, now),
    db.prepare(
      "UPDATE music_intake_jobs SET status='done',lease_until='',updated_at=?" +
        " WHERE master_id=? AND master_sha256=? AND status='running' AND lease_token=?" +
        " AND EXISTS(SELECT 1 FROM music_masters m WHERE m.id=music_intake_jobs.master_id" +
        " AND m.sha256=? AND m.status='staged' AND m.storage_key=?)",
    ).bind(now, master, sha256, lease, sha256, key),
    db.prepare(
      "INSERT OR IGNORE INTO music_stage_events(event_key,contract_id,master_id,stage,outcome,bytes_processed,recorded_at)" +
        " SELECT 'intake_done:'||j.master_id,c.id,j.master_id,'intake_complete','staged',?,?" +
        " FROM music_intake_jobs j JOIN music_contracts c ON c.id=j.contract_id" +
        " WHERE j.master_id=? AND j.master_sha256=? AND j.status='done'" +
        " AND j.lease_token=? AND j.updated_at=?",
    ).bind(size, now, master, sha256, lease, now),
  ]) as BatchRow<{ id: string }>[];
  return results[0]?.results?.[0]?.id === master;
}
export async function recordAnalysisMetrics(
  db: Db, master: string, policy: string, reportSha: string, lease: string,
  processingMs: number | null, costMicroUsd: number | null, outcome: string,
) {
  if (policy !== QUIET_READING_POLICY || !sha.test(reportSha)) return;
  await db.prepare(
    "INSERT OR IGNORE INTO music_stage_events" +
      "(event_key,contract_id,master_id,stage,outcome,processing_ms,cost_microusd,bytes_processed,recorded_at)" +
      " SELECT ?,m.contract_id,m.id,'analysis_complete',?,?,?,m.bytes,?" +
      " FROM music_masters m JOIN music_analysis_jobs j ON j.master_id=m.id" +
      " WHERE m.id=? AND j.policy=? AND j.lease_token=? AND j.report_sha256=?" +
      " AND j.status IN ('approved','needs_review','rejected')",
  ).bind(
    "analysis:" + master + ":" + policy + ":" + reportSha,
    outcome, processingMs, costMicroUsd, time(), master, policy, lease, reportSha,
  ).run();
}

export async function handleMusicExecution(
  req: Request,
  env: MusicSupplyEnv,
  roles: { operator: boolean; ingest: boolean; reviewer: boolean },
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/v1/execution/")) return null;
  if (env.MUSIC_EXECUTION_ENABLED !== "1" || env.MUSIC_ANALYSIS_ENABLED !== "1")
    return reply({ error: "music_execution_disabled" }, 503);
  if (!env.MUSIC_DB || !env.MUSIC_BUCKET) return reply({ error: "music_execution_unavailable" }, 503);
  const db = env.MUSIC_DB, bucket = env.MUSIC_BUCKET;
  const now = time();
  if (url.pathname === "/v1/execution/source-limits" && req.method === "POST") {
    if (!roles.operator) return reply({ error: "unauthorized" }, 401);
    const payload = await body(req);
    const contractId = payload.contractId;
    const limits = ["dailyIntake", "parallelIntake", "dailyAnalysis", "parallelAnalysis"] as const;
    const max = [1000, 16, 2000, 16];
    if (typeof contractId !== "string" || !id.test(contractId) ||
      typeof payload.paused !== "boolean" ||
      limits.some((v, i) => !Number.isSafeInteger(payload[v]) || Number(payload[v]) < 1 || Number(payload[v]) > max[i]))
      return reply({ error: "music_invalid_source_limits" }, 422);
    const updated = await db.prepare(
      "INSERT INTO music_source_limits(contract_id,paused,daily_intake_limit,parallel_intake_limit,daily_analysis_limit,parallel_analysis_limit,updated_at)" +
        " SELECT id,?,?,?,?,?,? FROM music_contracts WHERE id=? AND status='active' AND expires_at>?" +
        " ON CONFLICT(contract_id) DO UPDATE SET paused=excluded.paused," +
        " daily_intake_limit=excluded.daily_intake_limit,parallel_intake_limit=excluded.parallel_intake_limit," +
        " daily_analysis_limit=excluded.daily_analysis_limit,parallel_analysis_limit=excluded.parallel_analysis_limit," +
        " updated_at=excluded.updated_at RETURNING contract_id",
    ).bind(payload.paused ? 1 : 0, payload.dailyIntake, payload.parallelIntake,
      payload.dailyAnalysis, payload.parallelAnalysis, now, contractId, now).first<{ contract_id: string }>();
    return updated ? reply({ contractId, paused: payload.paused, updated: true }) :
      reply({ error: "music_source_not_active" }, 409);
  }
  if (url.pathname === "/v1/execution/intake/claim" && req.method === "POST") {
    if (!roles.ingest) return reply({ error: "music_ingest_identity_required" }, 401);
    const token = crypto.randomUUID(), until = new Date(Date.now() + 12 * 60_000).toISOString();
    const day = new Date(Date.now() - 24 * 3600_000).toISOString();
    const result = await db.batch([
      db.prepare(
        "INSERT OR IGNORE INTO music_intake_jobs(master_id,contract_id,master_sha256,available_at,updated_at)" +
          " SELECT m.id,m.contract_id,m.sha256,?,? FROM music_masters m" +
          " JOIN music_contracts c ON c.id=m.contract_id" +
          " JOIN music_source_limits q ON q.contract_id=c.id" +
          " WHERE m.status='quarantined' AND c.status='active' AND c.expires_at>?" +
          " AND q.paused=0 ORDER BY m.id LIMIT 32",
      ).bind(now, now, now),
      db.prepare(
        "UPDATE music_intake_jobs SET status='running',attempts=attempts+1," +
          " lease_token=?,lease_until=?,updated_at=? WHERE master_id=(" +
          " SELECT j.master_id FROM music_intake_jobs j" +
          " JOIN music_masters m ON m.id=j.master_id" +
          " JOIN music_contracts c ON c.id=j.contract_id" +
          " JOIN music_source_limits q ON q.contract_id=c.id" +
          " WHERE m.id=j.master_id AND m.sha256=j.master_sha256 AND m.status='quarantined'" +
          " AND c.status='active' AND c.expires_at>? AND q.paused=0" +
          " AND j.attempts<5 AND ((j.status='queued' AND j.available_at<=?)" +
          " OR (j.status='running' AND j.lease_until<?))" +
          " AND (SELECT COUNT(*) FROM music_intake_jobs x WHERE x.contract_id=j.contract_id" +
          " AND x.status='running' AND x.lease_until>?)<q.parallel_intake_limit" +
          " AND (SELECT COUNT(*) FROM music_stage_events e WHERE e.contract_id=j.contract_id" +
          " AND e.stage='intake_claim' AND e.recorded_at>=?)<q.daily_intake_limit" +
          " ORDER BY j.available_at,j.master_id LIMIT 1)" +
          " AND attempts<5 RETURNING master_id,master_sha256,contract_id,lease_token,attempts",
      ).bind(token, until, now, now, now, now, now, day),
      db.prepare(
        "INSERT INTO music_stage_events(event_key,contract_id,master_id,stage,outcome,recorded_at)" +
          " SELECT ?,j.contract_id,j.master_id,'intake_claim','leased',?" +
          " FROM music_intake_jobs j WHERE j.lease_token=? AND j.status='running' AND j.updated_at=?",
      ).bind("intake_claim:" + token, now, token, now),
    ]) as BatchRow<{ master_id: string; master_sha256: string; contract_id: string; lease_token: string; attempts: number }>[];
    const claimed = result[1]?.results?.[0];
    if (!claimed) return reply({ skipped: "source_caps_or_no_jobs" });
    const row = await db.prepare("SELECT manifest_json FROM music_masters WHERE id=? AND sha256=? AND status='quarantined'")
      .bind(claimed.master_id, claimed.master_sha256).first<{ manifest_json: string }>();
    if (!row) return reply({ error: "music_intake_stale_claim" }, 409);
    return reply({ masterId: claimed.master_id, contractId: claimed.contract_id,
      masterSha256: claimed.master_sha256, leaseToken: token, attempts: claimed.attempts,
      expiresAt: until, manifest: JSON.parse(row.manifest_json) });
  }
  if (url.pathname === "/v1/execution/intake/fail" && req.method === "POST") {
    if (!roles.ingest) return reply({ error: "music_ingest_identity_required" }, 401);
    const payload = await body(req, 1000);
    if (typeof payload.masterId !== "string" || !id.test(payload.masterId) ||
      typeof payload.leaseToken !== "string" || !leasePattern.test(payload.leaseToken))
      return reply({ error: "music_invalid_intake_failure" }, 422);
    const row = await db.prepare(
      "UPDATE music_intake_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END," +
        " available_at=?,lease_until='',lease_token='',last_error='source_transfer_failed',updated_at=?" +
        " WHERE master_id=? AND lease_token=? AND status='running' AND lease_until>?" +
        " RETURNING status",
    ).bind(new Date(Date.now() + 60_000).toISOString(), now, payload.masterId, payload.leaseToken, now)
      .first<{ status: string }>();
    return row ? reply({ masterId: payload.masterId, status: row.status }) :
      reply({ error: "music_intake_stale_lease" }, 409);
  }
  if (url.pathname === "/v1/execution/review" && req.method === "GET") {
    if (!roles.operator && !roles.reviewer) return reply({ error: "unauthorized" }, 401);
    const rows = await db.prepare(
      "SELECT j.master_id,j.master_sha256,j.report_sha256,j.tier,j.reasons_json," +
        " m.manifest_json FROM music_analysis_jobs j" +
        " JOIN music_masters m ON m.id=j.master_id JOIN music_contracts c ON c.id=m.contract_id" +
        " WHERE j.policy=? AND j.status='needs_review' AND j.report_sha256 IS NOT NULL" +
        " AND m.sha256=j.master_sha256 AND m.status='quality_passed'" +
        " AND c.status='active' AND c.expires_at>?" +
        " ORDER BY j.updated_at,j.master_id LIMIT 25",
    ).bind(QUIET_READING_POLICY, now).all<{ master_id: string; master_sha256: string; report_sha256: string; tier: string; reasons_json: string; manifest_json: string }>();
    return reply({ status: "needs_review", items: rows.results.map((r) => ({
      masterId: r.master_id, masterSha256: r.master_sha256, reportSha256: r.report_sha256,
      tier: r.tier, reasons: JSON.parse(r.reasons_json), manifest: JSON.parse(r.manifest_json),
    })), customerPublished: false });
  }
  const reviewAudio = /^\/v1\/execution\/review\/([a-zA-Z0-9._:-]{3,120})\/audio$/.exec(url.pathname);
  if (reviewAudio && req.method === "GET") {
    if (!roles.reviewer) return reply({ error: "music_reviewer_identity_required" }, 401);
    const r = await db.prepare(
      "SELECT m.storage_key,m.bytes,m.mime,m.sha256 FROM music_masters m" +
        " JOIN music_analysis_jobs j ON j.master_id=m.id JOIN music_contracts c ON c.id=m.contract_id" +
        " WHERE m.id=? AND m.sha256=j.master_sha256 AND m.status='quality_passed'" +
        " AND j.policy=? AND j.status='needs_review' AND c.status='active' AND c.expires_at>?",
    ).bind(reviewAudio[1], QUIET_READING_POLICY, now)
      .first<{ storage_key: string | null; bytes: number; mime: string; sha256: string }>();
    if (!r?.storage_key) return reply({ error: "music_review_audio_unavailable" }, 404);
    const head = await bucket.head(r.storage_key);
    if (!head || head.size !== r.bytes || fingerprint(head.checksums?.sha256) !== r.sha256)
      return reply({ error: "music_review_audio_integrity_failed" }, 409);
    const object = await bucket.get(r.storage_key);
    if (!object || object.size !== r.bytes) return reply({ error: "music_review_audio_unavailable" }, 404);
    return new Response(object.body, { headers: {
      "content-type": r.mime, "content-length": String(r.bytes),
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  }
  const review = /^\/v1\/execution\/review\/([a-zA-Z0-9._:-]{3,120})$/.exec(url.pathname);
  if (review && req.method === "POST") {
    if (!roles.reviewer) return reply({ error: "music_reviewer_identity_required" }, 401);
    const value = await body(req, 2500);
    if (typeof value.masterSha256 !== "string" || !sha.test(value.masterSha256) ||
      typeof value.reportSha256 !== "string" || !sha.test(value.reportSha256) ||
      !["approve","reject"].includes(String(value.decision)) ||
      value.heardFullMaster !== true ||
      typeof value.reviewerId !== "string" || !/^[a-zA-Z0-9._:-]{4,80}$/.test(value.reviewerId) ||
      typeof value.rationale !== "string" || value.rationale.length < 30 || value.rationale.length > 1000)
      return reply({ error: "music_review_attestation_required" }, 422);
    const newStatus = value.decision === "approve" ? "approved" : "rejected";
    const eventId = "music-qualified-review-" + review[1] + "-" + QUIET_READING_POLICY;
    const results = await db.batch([
      db.prepare(
        "UPDATE music_analysis_jobs SET status=?,lease_until='',updated_at=?" +
          " WHERE master_id=? AND policy=? AND status='needs_review'" +
          " AND master_sha256=? AND report_sha256=?" +
          " AND EXISTS(SELECT 1 FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE m.id=music_analysis_jobs.master_id AND m.sha256=music_analysis_jobs.master_sha256" +
          " AND m.status='quality_passed' AND c.status='active' AND c.expires_at>?)" +
          " RETURNING master_id",
      ).bind(newStatus, now, review[1], QUIET_READING_POLICY, value.masterSha256, value.reportSha256, now),
      db.prepare(
        "INSERT OR IGNORE INTO music_human_reviews" +
          "(master_id,policy,master_sha256,report_sha256,decision,reviewer_id,rationale,reviewed_at)" +
          " SELECT j.master_id,j.policy,j.master_sha256,j.report_sha256,?,?,?,?" +
          " FROM music_analysis_jobs j WHERE j.master_id=? AND j.policy=? AND j.status=?" +
          " AND j.master_sha256=? AND j.report_sha256=? AND j.updated_at=?",
      ).bind(value.decision, value.reviewerId, value.rationale, now, review[1], QUIET_READING_POLICY,
        newStatus, value.masterSha256, value.reportSha256, now),
      db.prepare(
        "INSERT OR IGNORE INTO music_stage_events(event_key,contract_id,master_id,stage,outcome,recorded_at)" +
          " SELECT ?,m.contract_id,m.id,?,?,? FROM music_masters m" +
          " JOIN music_human_reviews h ON h.master_id=m.id" +
          " WHERE m.id=? AND h.policy=? AND h.master_sha256=? AND h.report_sha256=?" +
          " AND h.reviewed_at=?",
      ).bind("review:" + review[1] + ":" + QUIET_READING_POLICY, newStatus === "approved" ? "human_approved" : "human_rejected",
        newStatus, now, review[1], QUIET_READING_POLICY, value.masterSha256, value.reportSha256, now),
      db.prepare(
        "INSERT OR IGNORE INTO music_publication_outbox(id,contract_id,master_id,action,payload_json,created_at)" +
          " SELECT ?,m.contract_id,m.id,'master_qualified',m.manifest_json,?" +
          " FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " JOIN music_analysis_jobs j ON j.master_id=m.id" +
          " JOIN music_human_reviews h ON h.master_id=m.id" +
          " WHERE m.id=? AND m.sha256=? AND m.status='quality_passed'" +
          " AND c.status='active' AND c.expires_at>?" +
          " AND j.policy=? AND j.status='approved' AND j.report_sha256=?" +
          " AND h.policy=j.policy AND h.decision='approve' AND h.report_sha256=j.report_sha256",
      ).bind(eventId, now, review[1], value.masterSha256, now, QUIET_READING_POLICY, value.reportSha256),
    ]) as BatchRow<{master_id:string}>[];
    return results[0]?.results?.[0]?.master_id === review[1] ?
      reply({ masterId: review[1], status: newStatus, customerPublished: false }, 202) :
      reply({ error: "music_review_stale_or_already_decided" }, 409);
  }
  if (url.pathname === "/v1/execution/metrics" && req.method === "GET") {
    if (!roles.operator) return reply({ error: "unauthorized" }, 401);
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const stages = await db.prepare(
      "SELECT stage,outcome,COUNT(*) jobs,COALESCE(SUM(processing_ms),0) processing_ms," +
        " SUM(cost_microusd) known_cost_microusd," +
        " SUM(CASE WHEN cost_microusd IS NULL THEN 1 ELSE 0 END) unpriced_jobs," +
        " SUM(bytes_processed) bytes_processed" +
        " FROM music_stage_events WHERE recorded_at>=? GROUP BY stage,outcome ORDER BY stage,outcome",
    ).bind(since).all();
    const backlog = await db.prepare(
      "SELECT 'intake' kind,status,COUNT(*) count FROM music_intake_jobs GROUP BY status" +
        " UNION ALL SELECT 'analysis' kind,status,COUNT(*) count FROM music_analysis_jobs GROUP BY status",
    ).bind().all();
    const sources = await db.prepare(
      "SELECT q.contract_id,q.paused,q.daily_intake_limit,q.parallel_intake_limit," +
        " q.daily_analysis_limit,q.parallel_analysis_limit," +
        " (SELECT COUNT(*) FROM music_stage_events e WHERE e.contract_id=q.contract_id" +
        " AND e.stage='intake_claim' AND e.recorded_at>=?) intake_claims_24h," +
        " (SELECT COUNT(*) FROM music_stage_events e WHERE e.contract_id=q.contract_id" +
        " AND e.stage='analysis_claim' AND e.recorded_at>=?) analysis_claims_24h" +
        " FROM music_source_limits q ORDER BY q.contract_id LIMIT 100",
    ).bind(since, since).all();
    return reply({
      period: { start: since, end: now }, stages: stages.results,
      backlog: backlog.results, sources: sources.results,
      note: "Only explicitly attested cost is priced; unpriced jobs are not counted as free.",
    });
  }
  return reply({ error: "not_found" }, 404);
}
