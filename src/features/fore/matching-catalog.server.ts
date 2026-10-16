import type { CoveEnv } from "./api.server";
import { MUSIC_POLICY } from "./music-profile";
import { musicCatalogSql, musicRecordingFingerprint } from "./music-profiles.server";
import {
  matchingAudioSchema,
  listeningTarget,
  retrievalMoodLabels,
  type MatchingRecording,
  type ListeningMode,
} from "./matching-engine";
import type { LiteraryProfile } from "./literary-profile";

const metadataSql = `json_object('attribution',COALESCE((SELECT attribution_text FROM soundtrack_recordings WHERE id=live.id),(SELECT attribution_text FROM soundtrack_external_recordings WHERE id=live.id)), 'license',COALESCE((SELECT license_statement FROM soundtrack_recordings WHERE id=live.id),(SELECT license_statement FROM soundtrack_external_recordings WHERE id=live.id)), 'licenseUrl',COALESCE((SELECT license_url FROM soundtrack_recordings WHERE id=live.id),(SELECT license_url FROM soundtrack_external_recordings WHERE id=live.id)))`;
// Gate before shortlisting, so revoked/territorially blocked rows cannot crowd out playable music.
const eligibleIndexSql = `EXISTS(SELECT 1 FROM music_profiles p WHERE p.recording_id=a.recording_id AND p.status='analyzed' AND p.policy=? AND p.fingerprint=a.fingerprint) AND (
 EXISTS(SELECT 1 FROM soundtrack_recordings r WHERE r.id=a.recording_id AND r.status='ready' AND r.quality_status='passed' AND r.source_snapshot_key IS NOT NULL AND r.storage_key IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(r.allowed_territories_json) THEN r.allowed_territories_json ELSE '[]' END) j WHERE j.value IN (?,'*')))
 OR EXISTS(SELECT 1 FROM soundtrack_external_recordings r WHERE r.id=a.recording_id AND r.status='ready' AND r.storage_key IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(r.territories_json) THEN r.territories_json ELSE '[]' END) j WHERE j.value IN (?,'*'))))`;
export async function loadMatchingRecordings(
  env: CoveEnv,
  territory: string,
  profile: LiteraryProfile,
  mode: ListeningMode,
  onlyIds?: string[],
) {
  const total =
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM matching_audio_index").first<{
        count: number;
      }>()
    )?.count ?? 0;
  let ids: string[],
    retrieval = "exhaustive";
  if (onlyIds) ids = [...new Set(onlyIds)].slice(0, 80);
  else if (total <= 600)
    ids = (
      await env.DB.prepare(
        "SELECT recording_id FROM matching_audio_index ORDER BY recording_id",
      ).all<{ recording_id: string }>()
    ).results.map((r) => r.recording_id);
  else {
    retrieval = "indexed_energy_and_mood_shortlist";
    const target = listeningTarget(profile, mode);
    const tags = retrievalMoodLabels(target.moods);
    const nearest = await env.DB.prepare(
      `SELECT a.recording_id FROM matching_audio_index a WHERE ${eligibleIndexSql} AND a.energy BETWEEN ? AND ? ORDER BY ABS(a.energy-?),a.recording_id LIMIT 400`,
    )
      .bind(
        MUSIC_POLICY,
        territory,
        territory,
        Math.max(0, target.energy - 0.25),
        target.maxEnergy,
        target.energy,
      )
      .all<{ recording_id: string }>();
    const mood = tags.length
      ? await env.DB.prepare(
          `SELECT DISTINCT t.recording_id FROM matching_audio_tags t JOIN matching_audio_index a ON a.recording_id=t.recording_id WHERE ${eligibleIndexSql} AND t.kind='mood' AND t.tag IN (${tags.map(() => "?").join(",")}) AND a.energy<=? ORDER BY ABS(a.energy-?),t.recording_id LIMIT 200`,
        )
          .bind(MUSIC_POLICY, territory, territory, ...tags, target.maxEnergy, target.energy)
          .all<{ recording_id: string }>()
      : { results: [] };
    ids = [...new Set([...nearest.results, ...mood.results].map((r) => r.recording_id))];
  }
  const recordings: MatchingRecording[] = [];
  const rejected = { stale: 0, invalid: 0 };
  for (let n = 0; n < ids.length; n += 70) {
    const batch = ids.slice(n, n + 70);
    if (!batch.length) continue;
    const rows = (
      await env.DB.prepare(
        `SELECT live.*,a.fingerprint matching_fingerprint,a.compact_json,${metadataSql} presentation_json FROM (${musicCatalogSql}) live JOIN music_profiles p ON p.recording_id=live.id AND p.status='analyzed' AND p.policy=? JOIN matching_audio_index a ON a.recording_id=p.recording_id AND a.fingerprint=p.fingerprint WHERE live.id IN (${batch.map(() => "?").join(",")}) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(live.allowed_territories_json) THEN live.allowed_territories_json ELSE '[]' END) t WHERE t.value IN (?,'*')) ORDER BY live.id`,
      )
        .bind(MUSIC_POLICY, ...batch, territory)
        .all<{
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
          matching_fingerprint: string;
          compact_json: string;
          presentation_json: string;
        }>()
    ).results;
    for (const row of rows) {
      const { matching_fingerprint, compact_json, presentation_json, ...live } = row;
      if ((await musicRecordingFingerprint(live)) !== matching_fingerprint) {
        rejected.stale++;
        continue;
      }
      try {
        const parsed = matchingAudioSchema.safeParse(JSON.parse(compact_json));
        if (!parsed.success) {
          rejected.invalid++;
          continue;
        }
        const qa = JSON.parse(live.quality_report_json);
        if (parsed.data.sourceSha1 !== live.source_sha1 || qa.sha256 !== parsed.data.sha256) {
          rejected.invalid++;
          continue;
        }
        const context = JSON.parse(live.context_json),
          presentation = JSON.parse(presentation_json);
        recordings.push({
          id: live.id,
          fingerprint: matching_fingerprint,
          title: live.title,
          composer: live.composer,
          performer: live.performer,
          period: live.period,
          instruments: JSON.parse(live.instruments_json),
          moods: JSON.parse(live.moods_json),
          hasVocals: live.has_vocals === null ? null : !!live.has_vocals,
          compositionYears: context.compositionYears ?? [null, null],
          reconstruction:
            context.reconstruction === null || context.reconstruction === undefined
              ? null
              : !!context.reconstruction,
          audio: parsed.data,
          attribution: presentation.attribution,
          license: presentation.license,
          licenseUrl: presentation.licenseUrl,
          sourcePage: live.source_page_url,
          audioUrl: `/api/fore/soundtracks/recordings/${live.id}/audio`,
          profileUrl: `/api/fore/soundtracks/recordings/${live.id}/profile`,
        });
      } catch {
        rejected.invalid++;
      }
    }
  }
  return {
    recordings,
    retrieval: {
      method: onlyIds ? "explicit_recordings" : retrieval,
      indexedProfiles: total,
      retrieved: ids.length,
      liveEligible: recordings.length,
      exhaustive: !onlyIds && total <= 600,
      rejected,
    },
  };
}
export function presentMatchingRecording(r: MatchingRecording) {
  return {
    id: r.id,
    title: r.title,
    performer: r.performer,
    composer: r.composer,
    period: r.period,
    attribution: r.attribution,
    license: r.license,
    licenseUrl: r.licenseUrl,
    sourcePage: r.sourcePage,
    durationSeconds: r.audio.durationSeconds,
    audioUrl: r.audioUrl,
    profileUrl: r.profileUrl,
    modifications: "Original recording: no modifications.",
    fingerprint: r.fingerprint,
  };
}
