import type { CoveEnv } from "./api.server";

/**
 * Staff-only editorial report. Nothing here approves a recording, modifies a
 * license, or changes the playlist serving path. Signal-energy and reading
 * distraction are computed, NOT equivalent to user-certified quietness.
 */
export const quietMusicInventoryThresholds = Object.freeze({
  measuredSignalEnergyStrictMax: 0.5,
  measuredSignalEnergyBroadMax: 0.6,
  readingDistractionBroadMax: 0.4,
});

const readyQuery = `
WITH eligible AS (
  SELECT r.id, r.composer, r.has_vocals,
         CASE WHEN json_valid(r.quality_report_json)
           THEN json_extract(r.quality_report_json, '$.durationSeconds') END duration_seconds,
         mp.status AS profile_status,
         CASE WHEN json_valid(mp.profile_json)
           THEN json_extract(mp.profile_json, '$.audioAnalysis.signal.energy') END measured_energy,
         CASE WHEN json_valid(mp.profile_json)
           THEN json_extract(mp.profile_json, '$.readingSuitability.distraction') END distraction
  FROM soundtrack_recordings r
  LEFT JOIN music_profiles mp ON mp.recording_id=r.id
  WHERE r.status='ready'
    AND r.quality_status='passed'
    AND r.storage_key IS NOT NULL
    AND r.source_snapshot_key IS NOT NULL
    AND json_valid(r.allowed_territories_json)
    AND EXISTS (
      SELECT 1 FROM json_each(r.allowed_territories_json)
      WHERE value=? OR value='*'
    )
)
SELECT COUNT(*) playable,
       COUNT(DISTINCT composer) distinct_composers,
       ROUND(COALESCE(SUM(duration_seconds),0)/60,1) playable_minutes,
       SUM(CASE WHEN has_vocals=0 AND profile_status='analyzed'
                    AND measured_energy<=? THEN 1 ELSE 0 END) strict_screen_count,
       ROUND(COALESCE(SUM(CASE WHEN has_vocals=0 AND profile_status='analyzed'
                    AND measured_energy<=? THEN duration_seconds ELSE 0 END),0)/60,1)
           strict_screen_minutes,
       SUM(CASE WHEN has_vocals=0 AND profile_status='analyzed'
                    AND measured_energy<=? AND distraction<=? THEN 1 ELSE 0 END)
           broad_screen_count,
       ROUND(COALESCE(SUM(CASE WHEN has_vocals=0 AND profile_status='analyzed'
                    AND measured_energy<=? AND distraction<=? THEN duration_seconds ELSE 0 END),0)/60,1)
           broad_screen_minutes
FROM eligible`;

const reviewQuery = `
SELECT
  SUM(CASE WHEN status='pending_review' THEN 1 ELSE 0 END) awaiting_review,
  SUM(CASE WHEN status='pending_review' AND quality_status='passed'
           THEN 1 ELSE 0 END) qa_passed_awaiting_rights_review,
  SUM(CASE WHEN status='pending_review' AND quality_status='passed'
           AND automated_triage_reason='' THEN 1 ELSE 0 END)
           qa_passed_untriaged,
  SUM(CASE WHEN status='pending_review' AND automated_triage_reason<>''
           THEN 1 ELSE 0 END) held_for_manual_triage
FROM soundtrack_recordings`;

const shortlistQuery = `
SELECT id,title,composer,performer,license_code,source_page_url
FROM soundtrack_recordings
WHERE status='pending_review' AND quality_status='passed'
  AND automated_triage_reason=''
ORDER BY id LIMIT 25`;

export function quietInventoryMarket(value: string | null): string {
  const country = value || "US";
  if (!/^[A-Z]{2}$/.test(country)) throw Error("Invalid editorial territory");
  return country;
}

export async function getQuietMusicInventory(
  db: CoveEnv["DB"],
  market = "US",
) {
  const territory = quietInventoryMarket(market);
  const t = quietMusicInventoryThresholds;
  const [ready, reviews, shortlist] = await Promise.all([
    db.prepare(readyQuery)
      .bind(
        territory,
        t.measuredSignalEnergyStrictMax,
        t.measuredSignalEnergyStrictMax,
        t.measuredSignalEnergyBroadMax,
        t.readingDistractionBroadMax,
        t.measuredSignalEnergyBroadMax,
        t.readingDistractionBroadMax,
      )
      .first(),
    db.prepare(reviewQuery).first(),
    db.prepare(shortlistQuery).all(),
  ]);
  return {
    territory,
    scope: "commons_only",
    reportOnly: true,
    thresholds: t,
    playable: ready,
    reviews,
    shortlist: shortlist.results,
    disclaimer:
      "Acoustic screening is not a human focus-suitability or legal-rights approval. " +
      "Reviewers must verify the exact master, recording and composition rights, " +
      "source revisions, attribution, quality, territory, and listening suitability.",
  };
}
