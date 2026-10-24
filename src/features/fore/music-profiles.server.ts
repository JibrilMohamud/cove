import { assessQuietReading } from "./quiet-reading-score";
import type { CoveEnv } from "./api.server";
import type { CoveIdentity } from "./auth.server";
import { ApiError, json, readBody } from "./service";
import { requireStaffPermission } from "./moderation.server";
import { requireServiceScope } from "./privileged-access.server";
import { MUSIC_POLICY, validateMusicReport } from "./music-profile";

type Recording = {
  id: string;
  title: string;
  performer: string;
  composer: string;
  period: string;
  instruments_json: string;
  moods_json: string;
  energy: number | null;
  has_vocals: number | null;
  source_sha1: string;
  source_size: number;
  storage_key: string;
  quality_report_json: string;
  source_page_url: string;
  allowed_territories_json: string;
  context_json: string;
};
const catalogSql = `SELECT r.*,COALESCE((SELECT json_object('compositionYears',json_array(c.composition_start_year,c.composition_end_year),'recordingYears',json_array(c.recording_start_year,c.recording_end_year),'reconstruction',c.reconstruction,'evokedEras',json(c.evoked_eras_json),'geography',json(c.geography_json),'evidence',json(c.evidence_json)) FROM soundtrack_context c WHERE c.recording_id=r.id),'{}') context_json FROM (
 SELECT id,title,performer,composer,period,instruments_json,moods_json,energy,has_vocals,source_sha1,source_size,storage_key,quality_report_json,source_page_url,allowed_territories_json FROM soundtrack_recordings WHERE status='ready' AND quality_status='passed' AND source_snapshot_key IS NOT NULL AND storage_key IS NOT NULL
 UNION ALL SELECT id,title,performer,composer,period,instruments_json,moods_json,energy,has_vocals,source_file_sha1 source_sha1,source_size,storage_key,quality_report_json,source_page_url,territories_json allowed_territories_json FROM soundtrack_external_recordings WHERE status='ready' AND storage_key IS NOT NULL
) r`;
const timestamp = () => new Date().toISOString();
const hash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const fingerprint = (r: Recording) => hash(JSON.stringify({ policy: MUSIC_POLICY, recording: r }));
function provisional(r: Recording) {
  return {
    provenance: {
      composer: r.composer,
      performer: r.performer,
      stylePeriod: r.period,
      sourcePage: r.source_page_url,
      ...JSON.parse(r.context_json),
      historicalReliability: "source_declared_not_independently_verified",
    },
    catalog: {
      instruments: JSON.parse(r.instruments_json),
      moods: JSON.parse(r.moods_json),
      energy: r.energy,
      vocals: r.has_vocals === null ? null : !!r.has_vocals,
    },
    audioAnalysis: null,
    limitations: [
      "Catalog tags are declarations, not measured sound.",
      "Unknown composition/recording dates remain unknown.",
    ],
  };
}
export async function seedMusicProfiles(env: CoveEnv, limit = 40) {
  const now = timestamp(),
    token = crypto.randomUUID();
  const state = await env.DB.prepare(
    "UPDATE music_profile_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING cursor",
  )
    .bind(token, new Date(Date.now() + 120000).toISOString(), now)
    .first<{ cursor: string }>();
  if (!state) return { skipped: "seed_lease" };
  try {
    const rows = (
      await env.DB.prepare(catalogSql + " WHERE r.id>? ORDER BY r.id LIMIT ?")
        .bind(state.cursor, Math.min(100, Math.max(1, limit)))
        .all<Recording>()
    ).results;
    for (const row of rows) {
      const pin = await fingerprint(row);
      const current = await env.DB.prepare(
        "SELECT fingerprint FROM music_profiles WHERE recording_id=?",
      )
        .bind(row.id)
        .first<{ fingerprint: string }>();
      if (current?.fingerprint === pin) continue;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO music_profiles(recording_id,fingerprint,policy,status,profile_json,updated_at) VALUES(?,?,?,'provisional',?,?) ON CONFLICT(recording_id) DO UPDATE SET fingerprint=excluded.fingerprint,policy=excluded.policy,status='provisional',profile_json=excluded.profile_json,updated_at=excluded.updated_at",
        ).bind(row.id, pin, MUSIC_POLICY, JSON.stringify(provisional(row)), now),
        env.DB.prepare(
          "INSERT INTO music_profile_jobs(recording_id,fingerprint,status,available_at,updated_at) VALUES(?,?,'queued',?,?) ON CONFLICT(recording_id) DO UPDATE SET fingerprint=excluded.fingerprint,status='queued',attempts=0,available_at=excluded.available_at,lease_token='',lease_until='',last_error='',updated_at=excluded.updated_at",
        ).bind(row.id, pin, now, now),
      ]);
    }
    await env.DB.prepare("UPDATE music_profile_state SET cursor=? WHERE id=1 AND lease_token=?")
      .bind(rows.at(-1)?.id || "", token)
      .run();
    return { scanned: rows.length };
  } finally {
    await env.DB.prepare(
      "UPDATE music_profile_state SET lease_until='' WHERE id=1 AND lease_token=?",
    )
      .bind(token)
      .run();
  }
}
export async function handleMusicProfiles(
  request: Request,
  env: CoveEnv,
  path: string,
  territory: string,
  identity: CoveIdentity | null = null,
): Promise<Response | null> {
  const match = /^\/soundtracks\/recordings\/((?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36}))\/profile$/.exec(
    path,
  );
  const admin = path.startsWith("/admin/music-profiles");
  if (!match && !admin) return null;
  const find = (id: string) =>
    env.DB.prepare(catalogSql + " WHERE r.id=?")
      .bind(id)
      .first<Recording>();
  if (match && request.method === "GET") {
    const r = await find(match[1]);
    if (
      !r ||
      !JSON.parse(r.allowed_territories_json).some((t: string) => t === territory || t === "*")
    )
      throw new ApiError(404, "Recording unavailable");
    const pin = await fingerprint(r);
    const current = await env.DB.prepare(
      "SELECT * FROM music_profiles WHERE recording_id=? AND fingerprint=?",
    )
      .bind(r.id, pin)
      .first<{ status: string; profile_json: string; updated_at: string }>();
    return json({
      recordingId: r.id,
      policy: MUSIC_POLICY,
      fingerprint: pin,
      status: current?.status || "pending",
      updatedAt: current?.updated_at || null,
      profile: current ? JSON.parse(current.profile_json) : provisional(r),
    });
  }
  if (!admin) return null;
  let actor: string;
  if (identity) {
    await requireStaffPermission(env.DB, identity, "soundtracks.review", request);
    actor = "staff:" + identity.id;
  } else {
    const principal = await requireServiceScope(env.DB, request, "soundtracks.review");
    actor = "service:" + principal.principalId;
  }
  // Optional one-profile-at-a-time migration of previously analyzed masters.
  // Never dispatches audio/AI work or touches a public playback entitlement.
  // It is authenticated, opt-in, and permanently bounded to one D1 write.
  if (path === "/admin/music-profiles/rescore-quiet" && request.method === "POST") {
    await readBody(request, 1000);
    if (
      (env as CoveEnv & { FORE_QUIET_READING_RESCORE_ENABLED?: string })
        .FORE_QUIET_READING_RESCORE_ENABLED !== "1"
    )
      return json({ skipped: "disabled" });
    const row = await env.DB.prepare(
      "SELECT mp.recording_id,mp.fingerprint,mp.profile_json,r.has_vocals,r.source_sha1" +
        " FROM music_profiles mp JOIN soundtrack_recordings r ON r.id=mp.recording_id" +
        " WHERE mp.status='analyzed' AND r.status='ready' AND r.quality_status='passed'" +
        " AND r.storage_key IS NOT NULL AND r.source_snapshot_key IS NOT NULL" +
        " AND (CASE WHEN json_valid(mp.profile_json) THEN" +
        " json_extract(mp.profile_json,'$.quietReading.policy') ELSE NULL END) IS NULL" +
        " ORDER BY mp.recording_id LIMIT 1",
    ).first<{
      recording_id: string;
      fingerprint: string;
      profile_json: string;
      has_vocals: number | null;
      source_sha1: string;
    }>();
    if (!row) return json({ skipped: "nothing_due" });
    const old = JSON.parse(row.profile_json) as { audioAnalysis?: unknown };
    const report = validateMusicReport(old.audioAnalysis);
    if (report.sourceSha1 !== row.source_sha1)
      return json({ skipped: "master_changed", recordingId: row.recording_id });
    const quietReading = assessQuietReading(report, row.has_vocals === null ? null : Boolean(row.has_vocals));
    const at = timestamp();
    const updated = (await env.DB.prepare(
      "UPDATE music_profiles SET profile_json=json_set(profile_json,'$.quietReading',json(?)),updated_at=?" +
        " WHERE recording_id=? AND fingerprint=? AND status='analyzed'" +
        " AND (CASE WHEN json_valid(profile_json) THEN json_extract(profile_json,'$.quietReading.policy') ELSE NULL END) IS NULL" +
        " AND EXISTS(SELECT 1 FROM soundtrack_recordings r WHERE r.id=music_profiles.recording_id" +
        " AND r.status='ready' AND r.quality_status='passed' AND r.source_sha1=?" +
        " AND r.storage_key IS NOT NULL AND r.source_snapshot_key IS NOT NULL)",
    )
      .bind(
        JSON.stringify(quietReading),
        at,
        row.recording_id,
        row.fingerprint,
        row.source_sha1,
      )
      .run()) as { meta?: { changes?: number } };
    return json({
      updated: Number(updated.meta?.changes || 0) === 1,
      recordingId: row.recording_id,
      tier: quietReading.tier,
      actor,
    });
  }
  if (path === "/admin/music-profiles/status" && request.method === "GET")
    return json({
      profiles: (
        await env.DB.prepare(
          "SELECT status,COUNT(*) count FROM music_profiles GROUP BY status",
        ).all()
      ).results,
      jobs: (
        await env.DB.prepare(
          "SELECT status,COUNT(*) count FROM music_profile_jobs GROUP BY status",
        ).all()
      ).results,
    });
  if (path === "/admin/music-profiles/seed" && request.method === "POST") {
    await readBody(request, 1000);
    return json(await seedMusicProfiles(env));
  }
  if (path === "/admin/music-profiles/claim" && request.method === "POST") {
    await readBody(request, 1000);
    const now = timestamp(),
      token = crypto.randomUUID();
    await env.DB.prepare(
      "UPDATE music_profile_jobs SET status='failed',last_error='expired_max_attempts' WHERE status='running' AND lease_until<? AND attempts>=5",
    )
      .bind(now)
      .run();
    // Rights withdrawals invalidate outstanding claims immediately. Do not
    // repeatedly select a revoked master (or obsolete external delivery) and
    // return HTTP 409 to the entire scheduled audio batch. Keep historical
    // reports for audit, but never offer revoked audio to any analyzer.
    const eligibleRecording = `(
      EXISTS(SELECT 1 FROM soundtrack_recordings r WHERE r.id=music_profile_jobs.recording_id AND r.status='ready' AND r.quality_status='passed' AND r.storage_key IS NOT NULL AND r.source_snapshot_key IS NOT NULL)
      OR EXISTS(SELECT 1 FROM soundtrack_external_recordings e WHERE e.id=music_profile_jobs.recording_id AND e.status='ready' AND e.storage_key IS NOT NULL)
    )`;
    await env.DB.prepare(
      `UPDATE music_profile_jobs SET status='failed',last_error='recording_not_published',lease_token='',lease_until='',updated_at=? WHERE status IN ('queued','running') AND NOT ${eligibleRecording}`,
    )
      .bind(now)
      .run();
    // Quiet, explicitly instrumental originals already published with a
    // verified master get first analysis when a batch arrives. This changes
    // scheduling ONLY; title tags never stand in for measured audio energy,
    // master fingerprints or commercial-use rights.
    const job = await env.DB.prepare(
      `UPDATE music_profile_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE recording_id=(SELECT j.recording_id FROM music_profile_jobs j WHERE ((j.status='queued' AND j.available_at<=?) OR (j.status='running' AND j.lease_until<?)) AND j.attempts<5 ORDER BY CASE WHEN EXISTS(SELECT 1 FROM soundtrack_recordings r WHERE r.id=j.recording_id AND r.status='ready' AND r.quality_status='passed' AND r.storage_key IS NOT NULL AND r.has_vocals=0 AND (lower(r.title) LIKE '%adagio%' OR lower(r.title) LIKE '%nocturne%' OR lower(r.title) LIKE '%lento%' OR lower(r.title) LIKE '%berceuse%' OR lower(r.title) LIKE '%lullaby%' OR lower(r.title) LIKE '%sarabande%' OR lower(r.title) LIKE '%gnossienne%' OR lower(r.title) LIKE '%gymnop%' OR lower(r.title) LIKE '%larghetto%' OR lower(r.title) LIKE '%largo%')) THEN 0 ELSE 1 END,j.available_at,j.recording_id LIMIT 1) RETURNING recording_id,fingerprint`,
    )
      .bind(token, new Date(Date.now() + 1800000).toISOString(), now, now, now)
      .first<{ recording_id: string; fingerprint: string }>();
    if (!job) return json({ skipped: "no_jobs" });
    const r = await find(job.recording_id);
    if (!r || (await fingerprint(r)) !== job.fingerprint) {
      // A simultaneous rights withdrawal or master change must not abort
      // the rest of this bounded batch or leave a repeatedly leased ghost.
      await env.DB.prepare(
        "UPDATE music_profile_jobs SET status='failed',last_error='stale_recording_fingerprint',lease_token='',lease_until='',updated_at=? WHERE recording_id=? AND fingerprint=? AND lease_token=? AND status='running'",
      )
        .bind(timestamp(), job.recording_id, job.fingerprint, token)
        .run();
      return json({ skipped: "stale_recording" });
    }
    return json({
      recordingId: r.id,
      fingerprint: job.fingerprint,
      leaseToken: token,
      policy: MUSIC_POLICY,
      sourceSha1: r.source_sha1,
      bytes: r.source_size,
      audioUrl: `/api/fore/soundtracks/recordings/${r.id}/audio`,
    });
  }
  if (path === "/admin/music-profiles/complete" && request.method === "POST") {
    const body = (await readBody(request, 450000)) as {
      recordingId: string;
      fingerprint: string;
      leaseToken: string;
      report: unknown;
    };
    const r = await find(body.recordingId);
    if (!r || (await fingerprint(r)) !== body.fingerprint)
      throw new ApiError(409, "Audio or catalog changed");
    const job = await env.DB.prepare(
      "SELECT recording_id FROM music_profile_jobs WHERE recording_id=? AND fingerprint=? AND lease_token=? AND status='running' AND lease_until>?",
    )
      .bind(r.id, body.fingerprint, body.leaseToken, timestamp())
      .first();
    if (!job) throw new ApiError(409, "Audio analysis lease lost");
    let report;
    try {
      report = validateMusicReport(body.report);
    } catch (error) {
      console.warn("music_profile_validation_failed", r.id, String(error).slice(0, 500));
      throw new ApiError(422, "Invalid or incomplete audio measurements");
    }
    const qa = JSON.parse(r.quality_report_json);
    if (
      report.sourceSha1 !== r.source_sha1 ||
      report.bytes !== r.source_size ||
      (qa.sha256 && qa.sha256 !== report.sha256) ||
      Math.abs(report.durationSeconds - qa.durationSeconds) > 0.5
    )
      throw new ApiError(409, "Measurements describe another master");
    if (!env.BUCKET) throw new ApiError(503, "Evidence storage unavailable");
    const master = await env.BUCKET.head?.(r.storage_key);
    if (!master || master.size !== report.bytes)
      throw new ApiError(503, "Verified original master is unavailable");
    const key = `music/profiles/${MUSIC_POLICY}/${r.id}/${body.fingerprint}/${body.leaseToken}.json`;
    await env.BUCKET.put(key, JSON.stringify(report), {
      httpMetadata: { contentType: "application/json" },
    });
    const quietReading = assessQuietReading(report, r.has_vocals === null ? null : Boolean(r.has_vocals));
    const profile = {
      ...provisional(r),
      audioAnalysis: report,
      quietReading,
      analysisCoverage: {
        fullSignal: true,
        semantic: report.semantics ? "sampled" : "unavailable",
        semanticFraction: report.semantics
          ? Math.min(1, report.semantics.sampledSeconds / report.durationSeconds)
          : 0,
      },
      readingSuitability: {
        method: "signal_and_model_estimate",
        confidence: report.semantics ? 0.6 : 0.35,
        distraction: Math.min(
          1,
          0.4 * report.signal.energy +
            0.3 * report.signal.abruptTransitionRate +
            0.3 * (report.semantics?.dimensions.vocalPresence ?? 0.5),
        ),
        lyrics: null,
        lyricsStatus: "not_transcribed_or_verified",
        volumeVariationLu: report.loudness.loudnessRangeLu,
        abruptTransitionRate: report.signal.abruptTransitionRate,
      },
      limitations: report.limitations,
    };
    const now = timestamp();
    const guard =
      "EXISTS(SELECT 1 FROM music_profile_jobs j WHERE j.recording_id=music_profiles.recording_id AND j.fingerprint=music_profiles.fingerprint AND j.lease_token=? AND j.status='running' AND j.lease_until>?)";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE music_profiles SET status='analyzed',profile_json=?,updated_at=? WHERE recording_id=? AND fingerprint=? AND ${guard}`,
      ).bind(JSON.stringify(profile), now, r.id, body.fingerprint, body.leaseToken, now),
      env.DB.prepare(
        "INSERT OR IGNORE INTO music_profile_revisions(recording_id,fingerprint,report_key,actor,created_at) SELECT recording_id,fingerprint,?,?,? FROM music_profiles WHERE recording_id=? AND fingerprint=? AND status='analyzed' AND updated_at=?",
      ).bind(key, actor, now, r.id, body.fingerprint, now),
      env.DB.prepare(
        "UPDATE music_profile_jobs SET status='done',lease_until='',updated_at=? WHERE recording_id=? AND fingerprint=? AND lease_token=? AND status='running' AND lease_until>?",
      ).bind(now, r.id, body.fingerprint, body.leaseToken, now),
    ]);
    const committed = await env.DB.prepare(
      "SELECT recording_id FROM music_profile_jobs WHERE recording_id=? AND fingerprint=? AND lease_token=? AND status='done'",
    )
      .bind(r.id, body.fingerprint, body.leaseToken)
      .first();
    if (!committed) throw new ApiError(409, "Audio analysis claim changed during publication");
    return json({ saved: true, recordingId: r.id, fingerprint: body.fingerprint });
  }
  if (path === "/admin/music-profiles/fail" && request.method === "POST") {
    const body = (await readBody(request, 1000)) as {
      recordingId: string;
      fingerprint: string;
      leaseToken: string;
      error: string;
    };
    await env.DB.prepare(
      "UPDATE music_profile_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,last_error=?,available_at=?,lease_until='',updated_at=? WHERE recording_id=? AND fingerprint=? AND lease_token=? AND status='running'",
    )
      .bind(
        String(body.error).slice(0, 200),
        new Date(Date.now() + 3600000).toISOString(),
        timestamp(),
        body.recordingId,
        body.fingerprint,
        body.leaseToken,
      )
      .run();
    return json({ saved: true });
  }
  throw new ApiError(404, "Music profile route unavailable");
}

export { catalogSql as musicCatalogSql, fingerprint as musicRecordingFingerprint };
