import { validateMusicReport } from "../features/fore/music-profile";
import { assessQuietReading, QUIET_READING_POLICY } from "../features/fore/quiet-reading-score";
import type { MusicSupplyEnv } from "./worker";
import type { MusicMasterManifest } from "./policy";

type Database = NonNullable<MusicSupplyEnv["MUSIC_DB"]>;
type Bucket = NonNullable<MusicSupplyEnv["MUSIC_BUCKET"]>;
type Job = {
  master_id: string;
  master_sha256: string;
  policy: string;
  status: string;
  attempts: number;
  lease_token: string;
  lease_until: string;
  report_key: string | null;
  report_sha256: string | null;
  bytes: number;
  mime: string;
  storage_key: string | null;
  quality_key: string | null;
  manifest_json: string;
};
const sha = /^[0-9a-f]{64}$/;
const masterId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const timestamp = () => new Date().toISOString();
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function objectHash(value: ArrayBuffer | string | undefined) {
  return typeof value === "string"
    ? value.toLowerCase()
    : value
      ? [...new Uint8Array(value)].map((n) => n.toString(16).padStart(2, "0")).join("")
      : "";
}
async function verifiedObject(bucket: Bucket, key: string, size: number, expected: string) {
  const head = await bucket.head(key);
  if (!head || head.size !== size || objectHash(head.checksums?.sha256) !== expected)
    throw new Error("music_analysis_master_integrity_failed");
}
async function storedJob(db: Database, id: string) {
  return db
    .prepare(
      "SELECT j.*,m.bytes,m.mime,m.storage_key,m.quality_key,m.manifest_json" +
        " FROM music_analysis_jobs j JOIN music_masters m ON m.id=j.master_id" +
        " WHERE j.master_id=? AND j.policy=?",
    )
    .bind(id, QUIET_READING_POLICY)
    .first<Job>();
}
async function eligibleJob(db: Database, id: string, lease: string) {
  return db
    .prepare(
      "SELECT j.*,m.bytes,m.mime,m.storage_key,m.quality_key,m.manifest_json" +
        " FROM music_analysis_jobs j JOIN music_masters m ON m.id=j.master_id" +
        " JOIN music_contracts c ON c.id=m.contract_id" +
        " WHERE j.master_id=? AND j.policy=? AND j.status='running'" +
        " AND j.lease_token=? AND j.lease_until>? AND j.master_sha256=m.sha256" +
        " AND m.status='quality_passed' AND m.quality_key IS NOT NULL" +
        " AND c.status='active' AND c.expires_at>?",
    )
    .bind(id, QUIET_READING_POLICY, lease, timestamp(), timestamp())
    .first<Job>();
}
/**
 * Isolated, separately authenticated analysis. No primary D1, customer
 * storage, playback URL or public approval is available to this component.
 */
export async function handleMusicAnalysis(
  request: Request,
  env: MusicSupplyEnv,
  analyst: boolean,
  operator: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/analysis/")) return null;
  if (env.MUSIC_ANALYSIS_ENABLED !== "1") return reply({ error: "music_analysis_disabled" }, 503);
  if (!env.MUSIC_DB || !env.MUSIC_BUCKET)
    return reply({ error: "music_analysis_unavailable" }, 503);
  const db = env.MUSIC_DB;
  const bucket = env.MUSIC_BUCKET;
  if (url.pathname === "/v1/analysis/status" && request.method === "GET") {
    if (!operator) return reply({ error: "unauthorized" }, 401);
    const rows = await db
      .prepare("SELECT status,COUNT(*) count FROM music_analysis_jobs WHERE policy=? GROUP BY status")
      .bind(QUIET_READING_POLICY)
      .all<{ status: string; count: number }>();
    return reply({ policy: QUIET_READING_POLICY, status: rows.results, customerPublished: false });
  }
  if (!analyst) return reply({ error: "music_analyst_identity_required" }, 401);
  if (url.pathname === "/v1/analysis/claim" && request.method === "POST") {
    const at = timestamp();
    const lease = crypto.randomUUID();
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    const job = await db
      .prepare(
        "UPDATE music_analysis_jobs SET status='running',attempts=attempts+1," +
          " lease_token=?,lease_until=?,updated_at=? WHERE master_id=(" +
          " SELECT j.master_id FROM music_analysis_jobs j" +
          " JOIN music_masters m ON m.id=j.master_id" +
          " JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE j.policy=? AND j.attempts<5 AND" +
          " ((j.status='queued' AND j.available_at<=?) OR" +
          " (j.status='running' AND j.lease_until<?))" +
          " AND j.master_sha256=m.sha256 AND m.status='quality_passed'" +
          " AND m.storage_key IS NOT NULL AND m.quality_key IS NOT NULL" +
          " AND c.status='active' AND c.expires_at>?" +
          " ORDER BY j.available_at,j.master_id LIMIT 1)" +
          " AND policy=? AND attempts<5 RETURNING master_id,master_sha256,lease_token",
      )
      .bind(lease, until, at, QUIET_READING_POLICY, at, at, at, QUIET_READING_POLICY)
      .first<{ master_id: string; master_sha256: string; lease_token: string }>();
    if (!job) return reply({ skipped: "no_eligible_jobs" });
    const row = await storedJob(db, job.master_id);
    if (!row) throw new Error("music_analysis_claim_missing");
    return reply({
      masterId: row.master_id,
      masterSha256: row.master_sha256,
      bytes: row.bytes,
      leaseToken: lease,
      policy: QUIET_READING_POLICY,
      attempts: row.attempts,
      expiresAt: until,
    });
  }
  const audio = /^\/v1\/analysis\/masters\/([a-zA-Z0-9._:-]{3,120})\/audio$/.exec(url.pathname);
  if (audio && request.method === "GET") {
    const lease = request.headers.get("x-cove-music-analysis-lease") || "";
    if (!/^[a-f0-9-]{36}$/.test(lease)) return reply({ error: "music_analysis_lease_required" }, 401);
    const row = await eligibleJob(db, audio[1], lease);
    if (!row || !row.storage_key) return reply({ error: "music_analysis_lease_expired" }, 409);
    await verifiedObject(bucket, row.storage_key, row.bytes, row.master_sha256);
    const object = await bucket.get(row.storage_key);
    if (!object || object.size !== row.bytes)
      return reply({ error: "music_analysis_master_missing" }, 409);
    return new Response(object.body, {
      headers: {
        "content-type": row.mime,
        "content-length": String(row.bytes),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const complete = /^\/v1\/analysis\/jobs\/([a-zA-Z0-9._:-]{3,120})\/complete$/.exec(
    url.pathname,
  );
  if (complete && request.method === "POST") {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 350_000) return reply({ error: "music_analysis_report_oversize" }, 413);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const lease = payload.leaseToken;
    if (typeof lease !== "string" || !/^[a-f0-9-]{36}$/.test(lease))
      return reply({ error: "music_analysis_lease_required" }, 401);
    const job = await eligibleJob(db, complete[1], lease);
    if (!job || !job.storage_key || !job.quality_key)
      return reply({ error: "music_analysis_stale_lease_or_rights" }, 409);
    const report = validateMusicReport(payload.report);
    if (report.sha256 !== job.master_sha256 || report.bytes !== job.bytes)
      return reply({ error: "music_analysis_wrong_master" }, 422);
    await verifiedObject(bucket, job.storage_key, job.bytes, job.master_sha256);
    const qualityObject = await bucket.get(job.quality_key);
    if (!qualityObject || qualityObject.size > 8_000)
      return reply({ error: "music_analysis_quality_evidence_missing" }, 409);
    const qualityText = await new Response(qualityObject.body).text();
    const qa = JSON.parse(qualityText) as Record<string, number | string>;
    const qualityHash = job.quality_key.match(/\/([a-f0-9]{64})\.json$/)?.[1];
    if (
      !qualityHash ||
      (await digest(qualityText)) !== qualityHash ||
      qa.sha256 !== job.master_sha256 ||
      qa.bytes !== job.bytes ||
      Math.abs(report.durationSeconds - Number(qa.durationSeconds)) > 1 ||
      Math.abs(report.loudness.integratedLufs - Number(qa.integratedLufs)) > 1 ||
      Math.abs(report.loudness.truePeakDbfs - Number(qa.truePeakDbfs)) > 1
    )
      return reply({ error: "music_analysis_qa_disagreement" }, 422);
    const manifest = JSON.parse(job.manifest_json) as MusicMasterManifest;
    const assessment = assessQuietReading(report, manifest.hasVocals);
    // Acoustic approval is explicitly opt-in and requires a corroborating,
    // pinned-model instrumental finding. Neither QA nor an AI model grants
    // streaming rights or a customer-facing publication.
    const status = assessment.suitable
      ? env.MUSIC_AUTO_QUIET_APPROVAL === "1" &&
        assessment.vocalEvidence === "instrumental_metadata_and_model" &&
        assessment.tier === "quiet_focus"
        ? "approved"
        : "needs_review"
      : assessment.tier === "distracting"
        ? "rejected"
        : "needs_review";
    const serialized = JSON.stringify({ report, assessment });
    const reportSha = await digest(serialized);
    const reportKey =
      "music-supply/analysis/" + job.master_sha256 + "/" + QUIET_READING_POLICY + "/" + reportSha + ".json";
    await bucket.put(reportKey, serialized, {
      sha256: reportSha,
      httpMetadata: { contentType: "application/json" },
    });
    await verifiedObject(bucket, reportKey, new TextEncoder().encode(serialized).length, reportSha);
    const at = timestamp();
    const eventId = "music-qualified-" + (await digest(job.master_id + ":" + QUIET_READING_POLICY));
    await db.batch([
      db.prepare(
        "UPDATE music_analysis_jobs SET status=?,report_key=?,report_sha256=?,tier=?," +
          " reasons_json=?,lease_until='',updated_at=? WHERE master_id=? AND policy=?" +
          " AND status='running' AND lease_token=? AND lease_until>?" +
          " AND master_sha256=? AND EXISTS(" +
          " SELECT 1 FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE m.id=music_analysis_jobs.master_id AND m.sha256=music_analysis_jobs.master_sha256" +
          " AND m.status='quality_passed' AND c.status='active' AND c.expires_at>?)",
      ).bind(
        status,
        reportKey,
        reportSha,
        assessment.tier,
        JSON.stringify(assessment.reasons),
        at,
        job.master_id,
        QUIET_READING_POLICY,
        lease,
        at,
        job.master_sha256,
        at,
      ),
      db.prepare(
        "INSERT OR IGNORE INTO music_publication_outbox(id,contract_id,master_id,action,payload_json,created_at)" +
          " SELECT ?,m.contract_id,m.id,'master_qualified',m.manifest_json,?" +
          " FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " JOIN music_analysis_jobs j ON j.master_id=m.id" +
          " WHERE m.id=? AND m.sha256=? AND m.status='quality_passed'" +
          " AND c.status='active' AND c.expires_at>?" +
          " AND j.policy=? AND j.status='approved' AND j.lease_token=?" +
          " AND j.report_sha256=? AND j.updated_at=?",
      ).bind(eventId, at, job.master_id, job.master_sha256, at, QUIET_READING_POLICY, lease, reportSha, at),
    ]);
    const stored = await storedJob(db, job.master_id);
    if (!stored || stored.report_sha256 !== reportSha || stored.lease_token !== lease)
      return reply({ error: "music_analysis_fenced_completion" }, 409);
    return reply({ masterId: job.master_id, status: stored.status, tier: assessment.tier, customerPublished: false }, 202);
  }
  const failed = /^\/v1\/analysis\/jobs\/([a-zA-Z0-9._:-]{3,120})\/fail$/.exec(url.pathname);
  if (failed && request.method === "POST") {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1000) return reply({ error: "music_analysis_payload_oversize" }, 413);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof value.leaseToken !== "string" || !/^[a-f0-9-]{36}$/.test(value.leaseToken))
      return reply({ error: "music_analysis_lease_required" }, 401);
    const row = await eligibleJob(db, failed[1], value.leaseToken);
    if (!row) return reply({ error: "music_analysis_stale_lease_or_rights" }, 409);
    const retrySeconds = Math.min(3600, Math.pow(2, row.attempts) * 30);
    const available = new Date(Date.now() + retrySeconds * 1000).toISOString();
    await db.prepare(
      "UPDATE music_analysis_jobs SET status=?,available_at=?,lease_token='',lease_until=''," +
        " last_error=?,updated_at=? WHERE master_id=? AND policy=? AND status='running'" +
        " AND lease_token=? AND lease_until>?",
    )
      .bind(
        row.attempts >= 5 ? "failed" : "queued",
        available,
        "analyzer_failed",
        timestamp(),
        row.master_id,
        QUIET_READING_POLICY,
        value.leaseToken,
        timestamp(),
      )
      .run();
    return reply({ masterId: row.master_id, status: row.attempts >= 5 ? "failed" : "queued" });
  }
  return reply({ error: "not_found" }, 404);
}
