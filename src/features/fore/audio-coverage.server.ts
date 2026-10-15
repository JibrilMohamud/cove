import type { CoveEnv } from "./api.server";
import type { AudioEdition } from "./domain";
import { audioCoverage } from "./audio-coverage";

/** Recheck storage independently of discovery/job completion, without per-visitor
 * object-store fanout. Checks are pinned to both current file hashes and expire.
 */
export async function verifyAudioStorage(env: CoveEnv, limit = 24) {
  if (!env.BUCKET?.head) return { checked: 0 };
  const cutoff = new Date(Date.now() - 86400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT e.id edition_id,e.epub_sha256,json_extract(t.value,'$.id') track_id,json_extract(t.value,'$.sha256') audio_sha256,a.map_sha256
     FROM audio_editions e,json_each(e.tracks_json) t
     LEFT JOIN audio_timing a ON a.edition_id=e.id AND a.track_id=json_extract(t.value,'$.id') AND a.audio_sha256=json_extract(t.value,'$.sha256') AND a.epub_sha256=e.epub_sha256
     LEFT JOIN audio_media_checks m ON m.edition_id=e.id AND m.track_id=json_extract(t.value,'$.id')
     WHERE length(json_extract(t.value,'$.sha256'))=64 AND (
       m.checked_at IS NULL OR m.checked_at<? OR m.audio_sha256<>json_extract(t.value,'$.sha256')
       OR m.epub_sha256<>COALESCE(e.epub_sha256,'') OR m.timing_sha256<>COALESCE(a.map_sha256,''))
     ORDER BY COALESCE(m.checked_at,''),e.id,json_extract(t.value,'$.id') LIMIT ?`,
  )
    .bind(cutoff, Math.max(0, Math.min(48, Math.floor(limit))))
    .all<{
      edition_id: string;
      track_id: string;
      epub_sha256: string | null;
      audio_sha256: string;
      map_sha256: string | null;
    }>();
  for (const row of rows.results) {
    const audio = await env.BUCKET.head(
      `audio/${row.edition_id}/${row.track_id}-${row.audio_sha256}`,
    );
    const timing = row.map_sha256
      ? await env.BUCKET.head(`biosync/maps/${row.map_sha256}.json`)
      : null;
    await env.DB.prepare(
      `INSERT INTO audio_media_checks(edition_id,track_id,audio_sha256,epub_sha256,timing_sha256,audio_present,timing_present,checked_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(edition_id,track_id) DO UPDATE SET audio_sha256=excluded.audio_sha256,epub_sha256=excluded.epub_sha256,timing_sha256=excluded.timing_sha256,audio_present=excluded.audio_present,timing_present=excluded.timing_present,checked_at=excluded.checked_at`,
    )
      .bind(
        row.edition_id,
        row.track_id,
        row.audio_sha256,
        row.epub_sha256 || "",
        row.map_sha256 || "",
        audio ? 1 : 0,
        timing ? 1 : 0,
        new Date().toISOString(),
      )
      .run();
  }
  return { checked: rows.results.length };
}
export async function storedAudioCoverage(env: CoveEnv, edition: AudioEdition) {
  const rows = await env.DB.prepare(
    "SELECT track_id,audio_sha256,epub_sha256,timing_sha256,audio_present,timing_present FROM audio_media_checks WHERE edition_id=? AND checked_at>=?",
  )
    .bind(edition.id, new Date(Date.now() - 86400_000).toISOString())
    .all<{
      track_id: string;
      audio_sha256: string;
      epub_sha256: string;
      timing_sha256: string;
      audio_present: number;
      timing_present: number;
    }>();
  const current = rows.results.filter((r) =>
    edition.tracks.some((t) => t.id === r.track_id && t.sha256 === r.audio_sha256),
  );
  const stored = current.filter((r) => r.audio_present === 1).map((r) => r.track_id);
  const maps =
    edition.alignment?.maps?.filter((m) =>
      current.some(
        (r) =>
          r.track_id === m.trackId &&
          r.timing_present === 1 &&
          r.epub_sha256 === edition.epubSha256 &&
          r.timing_sha256 === m.sha256,
      ),
    ) || [];
  return audioCoverage(
    { ...edition, alignment: edition.alignment ? { ...edition.alignment, maps } : null },
    stored,
  );
}
