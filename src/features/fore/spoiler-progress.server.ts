import { z } from "zod";
import type { CoveEnv } from "./api.server";

const cueSchema = z.object({
  trackId: z.string(),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  progress: z.number().finite().min(0).max(1),
  endProgress: z.number().finite().min(0).max(1),
});
const alignmentSchema = z.object({
  version: z.literal(1),
  verified: z.literal(true),
  cues: z.array(cueSchema).max(25000),
});
// Never equate elapsed audio fraction to ebook position. During a cue, unlock
// only its starting text position; its end becomes safe when the cue is complete.
export function progressAtVerifiedCues(
  cues: z.infer<typeof cueSchema>[],
  trackId: string,
  seconds: number,
) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  let progress = 0;
  for (const cue of cues) {
    if (
      cue.trackId !== trackId ||
      ![cue.start, cue.end, cue.progress, cue.endProgress].every(Number.isFinite) ||
      cue.start < 0 ||
      cue.progress < 0 ||
      cue.endProgress > 1 ||
      cue.end <= cue.start ||
      cue.endProgress < cue.progress ||
      seconds < cue.start
    )
      continue;
    progress = Math.max(progress, seconds >= cue.end ? cue.endProgress : cue.progress);
  }
  return progress;
}
const sourceSchema = z.object({
  assets: z
    .array(z.object({ kind: z.string(), current_version_id: z.string().nullable().optional() }))
    .optional(),
  commercialAudioManifestSha256: z.string().optional(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  ebookProductId: z.string(),
  audiobookProductId: z.string(),
  ebookAssetVersionId: z.string(),
  audioManifestSha256: z.string(),
  cues: z
    .array(
      z.object({
        chapterId: z.string(),
        startMs: z.number().min(0),
        endMs: z.number().positive(),
        progress: z.number().min(0).max(1),
        endProgress: z.number().min(0).max(1),
      }),
    )
    .max(500000),
});
async function activeSource(db: CoveEnv["DB"], productId: string) {
  const row = await db
    .prepare(
      `SELECT pv.manifest_json FROM publishing_publications pp JOIN publishing_release_lifecycles l ON l.publishing_edition_id=(SELECT edition_id FROM publishing_submission_snapshots WHERE id=pp.submission_id) JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id WHERE pp.product_id=? ORDER BY pv.version_number DESC LIMIT 1`,
    )
    .bind(productId)
    .first<{ manifest_json: string }>();
  if (!row) return null;
  try {
    return sourceSchema.parse(JSON.parse(row.manifest_json).sourceSnapshot);
  } catch {
    return null;
  }
}
export async function savedAlignedAudioProgress(
  db: CoveEnv["DB"],
  userId: string,
  ebookProductId: string,
  bucket?: CoveEnv["BUCKET"],
) {
  const progress = await alignedAudioProgress(db, { userId }, ebookProductId, bucket);
  return progress.get(userId) ?? 0;
}

export function savedGroupAlignedAudioProgress(
  db: CoveEnv["DB"],
  groupId: string,
  ebookProductId: string,
  bucket?: CoveEnv["BUCKET"],
) {
  return alignedAudioProgress(db, { groupId }, ebookProductId, bucket);
}

// Resolve all active club members together. Timing metadata is read and checked
// once per edition/link within this request; access checks stay request-scoped.
async function alignedAudioProgress(
  db: CoveEnv["DB"],
  scope: { userId: string } | { groupId: string },
  ebookProductId: string,
  bucket?: CoveEnv["BUCKET"],
) {
  const progress = new Map<string, number>();
  const scopeId = "groupId" in scope ? scope.groupId : scope.userId;
  const savedFilter =
    "groupId" in scope
      ? "user_id IN (SELECT user_id FROM reading_group_members WHERE group_id=? AND status='active')"
      : "user_id=?";
  const addProgress = (userId: string, value: number) => {
    if (Number.isFinite(value) && value >= 0 && value <= 1)
      progress.set(userId, Math.max(progress.get(userId) ?? 0, value));
  };
  const editions = (
    await db
      .prepare(
        `SELECT a.id,a.alignment_json,a.tracks_json
      FROM products p JOIN digital_assets da ON da.edition_id=p.edition_id AND da.kind='epub'
      JOIN asset_versions av ON av.id=da.current_version_id
      JOIN audio_editions a ON a.book_id IN (p.id,p.source_external_id) AND a.epub_sha256=av.sha256
      WHERE p.id=? AND p.source_name='gutenberg'`,
      )
      .bind(ebookProductId)
      .all<{ id: string; alignment_json: string | null; tracks_json: string }>()
  ).results;
  const metadata = new Map<
    string,
    {
      alignment: z.infer<typeof alignmentSchema>;
      tracks: { id: string; duration: number; sha256: string }[];
    }
  >();
  for (const edition of editions) {
    try {
      metadata.set(edition.id, {
        alignment: alignmentSchema.parse(JSON.parse(edition.alignment_json || "null")),
        tracks: z
          .array(
            z.object({
              id: z.string(),
              duration: z.number().finite().positive(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(500)
          .parse(JSON.parse(edition.tracks_json)),
      });
    } catch {
      // Word-only, stale or unverified timing cannot imply a text percentage.
    }
  }
  if (metadata.size) {
    const legacy = (
      await db
        .prepare(
          `SELECT a.id edition_id,saved.user_id,saved.track_id,saved.seconds,saved.audio_sha256
        FROM products p JOIN digital_assets da ON da.edition_id=p.edition_id AND da.kind='epub'
        JOIN asset_versions av ON av.id=da.current_version_id
        JOIN audio_editions a ON a.book_id IN (p.id,p.source_external_id) AND a.epub_sha256=av.sha256
        JOIN (SELECT user_id,edition_id,track_id,seconds,NULL epub_sha256,NULL audio_sha256 FROM playback WHERE ${savedFilter}
          UNION ALL SELECT user_id,edition_id,track_id,seconds,epub_sha256,audio_sha256 FROM biosync_positions WHERE ${savedFilter}) saved
          ON saved.edition_id=a.id AND (saved.epub_sha256 IS NULL OR saved.epub_sha256=av.sha256)
        WHERE p.id=? AND p.source_name='gutenberg'`,
        )
        .bind(scopeId, scopeId, ebookProductId)
        .all<{
          edition_id: string;
          user_id: string;
          audio_sha256: string | null;
          track_id: string;
          seconds: number;
        }>()
    ).results;
    for (const row of legacy) {
      const edition = metadata.get(row.edition_id);
      const track = edition?.tracks.find((t) => t.id === row.track_id);
      if (
        !edition ||
        !track ||
        !Number.isFinite(row.seconds) ||
        row.seconds < 0 ||
        row.seconds > track.duration + 1 ||
        (row.audio_sha256 && row.audio_sha256 !== track.sha256)
      )
        continue;
      addProgress(
        row.user_id,
        progressAtVerifiedCues(edition.alignment.cues, row.track_id, row.seconds),
      );
    }
  }
  // Commercial audio and BioSync positions share the verified immutable pair.
  // Read saved positions directly so already-recorded listening is recognized.
  if (bucket) {
    const rows = (
      await db
        .prepare(
          `SELECT l.*,p.user_id,p.chapter_id,p.seconds*1000 audio_ms FROM commercial_biosync_links l JOIN commercial_audio_playback p ON p.product_id=l.audiobook_product_id WHERE p.${savedFilter} AND l.ebook_product_id=? AND l.verification_status='verified'
      UNION ALL SELECT l.*,p.user_id,p.chapter_id,p.audio_ms FROM commercial_biosync_links l JOIN commercial_biosync_positions p ON p.biosync_link_id=l.id WHERE p.${savedFilter} AND l.ebook_product_id=? AND l.verification_status='verified'`,
        )
        .bind(scopeId, ebookProductId, scopeId, ebookProductId)
        .all<{
          id: string;
          user_id: string;
          ebook_product_id: string;
          audiobook_product_id: string;
          ebook_asset_version_id: string;
          audio_manifest_hash: string;
          timing_manifest_object_key: string;
          timing_manifest_sha256: string;
          chapter_id: string;
          audio_ms: number;
        }>()
    ).results;
    const sources = new Map<string, Promise<z.infer<typeof sourceSchema> | null>>();
    const source = (id: string) => {
      if (!sources.has(id)) sources.set(id, activeSource(db, id));
      return sources.get(id)!;
    };
    const manifests = new Map<string, Map<string, z.infer<typeof cueSchema>[]> | null>();
    for (const row of rows) {
      if (!Number.isFinite(row.audio_ms) || row.audio_ms < 0) continue;
      if (manifests.has(row.id)) {
        const manifest = manifests.get(row.id);
        if (manifest)
          addProgress(
            row.user_id,
            progressAtVerifiedCues(
              manifest.get(row.chapter_id) ?? [],
              row.chapter_id,
              row.audio_ms / 1000,
            ),
          );
        continue;
      }
      manifests.set(row.id, null);
      const [ebook, audio] = await Promise.all([
        source(row.ebook_product_id),
        source(row.audiobook_product_id),
      ]);
      if (
        !ebook?.assets?.some(
          (a) => a.kind === "manuscript" && a.current_version_id === row.ebook_asset_version_id,
        ) ||
        audio?.commercialAudioManifestSha256 !== row.audio_manifest_hash
      )
        continue;
      const object = await bucket.get(row.timing_manifest_object_key);
      if (!object || Number(object.size || 0) > 25 * 1024 * 1024) continue;
      try {
        const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== row.timing_manifest_sha256) continue;
        const manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        if (
          manifest.ebookProductId !== row.ebook_product_id ||
          manifest.audiobookProductId !== row.audiobook_product_id ||
          manifest.ebookAssetVersionId !== row.ebook_asset_version_id ||
          manifest.audioManifestSha256 !== row.audio_manifest_hash
        )
          continue;
        const chapters = new Map<string, z.infer<typeof cueSchema>[]>();
        for (const cue of manifest.cues) {
          const cues = chapters.get(cue.chapterId) ?? [];
          cues.push({
            trackId: cue.chapterId,
            start: cue.startMs / 1000,
            end: cue.endMs / 1000,
            progress: cue.progress,
            endProgress: cue.endProgress,
          });
          chapters.set(cue.chapterId, cues);
        }
        manifests.set(row.id, chapters);
        addProgress(
          row.user_id,
          progressAtVerifiedCues(
            chapters.get(row.chapter_id) ?? [],
            row.chapter_id,
            row.audio_ms / 1000,
          ),
        );
      } catch {
        /* Corrupt or unavailable timing never relaxes a spoiler gate. */
      }
    }
  }
  return progress;
}
