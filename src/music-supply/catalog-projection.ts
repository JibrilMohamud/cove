import type { MusicMasterManifest } from "./policy";
import { QUIET_READING_POLICY } from "../features/fore/quiet-reading-score";

/**
 * Private, non-customer catalog projection. Never creates entitlements,
 * playback URLs, or publicly serves a master. All D1 reads use MUSIC_DB.
 * A canonical publisher still must independently certify and import entries.
 */
type Db = {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
    };
  };
};
type Bucket = {
  head(key: string): Promise<{
    size: number;
    checksums?: { sha256?: ArrayBuffer | string };
  } | null>;
};
type CandidateRow = {
  id: string;
  sha256: string;
  bytes: number;
  manifest_json: string;
  storage_key: string;
  quality_key: string;
  contract_id: string;
  expires_at: string;
  evidence_sha256: string;
  evidence_key: string;
};
const sha = /^[0-9a-f]{64}$/;
const fingerprint = (value: ArrayBuffer | string | undefined) =>
  typeof value === "string"
    ? value.toLowerCase()
    : value
      ? Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")
      : "";

async function exactObject(bucket: Bucket, key: string, digest: string, bytes?: number) {
  const object = await bucket.head(key);
  return (
    !!object &&
    object.size > 0 &&
    (bytes === undefined || object.size === bytes) &&
    fingerprint(object.checksums?.sha256) === digest
  );
}

export async function privateMusicCandidates(
  db: Db,
  bucket: Bucket,
  territory: string,
  after = "",
  limit = 8,
  requireQuiet = false,
) {
  if (
    !/^[A-Z]{2}$/.test(territory) ||
    !/^[a-zA-Z0-9._:-]{0,120}$/.test(after) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 8
  )
    throw new Error("Invalid private music candidate query");
  const now = new Date().toISOString();
  const rows = (
    await db
      .prepare(
        "SELECT m.id,m.sha256,m.bytes,m.manifest_json,m.storage_key,m.quality_key," +
          " c.id contract_id,c.expires_at,c.evidence_sha256,c.evidence_key" +
          " FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE m.id>? AND m.status='quality_passed'" +
          " AND c.status='active' AND c.expires_at>?" +
          " AND m.storage_key IS NOT NULL AND m.quality_key IS NOT NULL" +
          (requireQuiet
            ? " AND EXISTS(SELECT 1 FROM music_analysis_jobs j WHERE j.master_id=m.id" +
              " AND j.policy='" +
              QUIET_READING_POLICY +
              "' AND j.status='approved'" +
              " AND j.master_sha256=m.sha256)"
            : "") +
          " AND EXISTS(SELECT 1 FROM json_each(m.manifest_json,'$.territory')" +
          " WHERE value=?) ORDER BY m.id LIMIT ?",
      )
      .bind(after, now, territory, limit)
      .all<CandidateRow>()
  ).results;
  const items: Array<{
    id: string;
    masterSha256: string;
    workKey: string;
    composer: string;
    performer: string;
    durationEligibility: "qa_passed_only";
    quietSuitability: "unverified" | "verified_private_qualification";
    expiresAt: string;
  }> = [];
  let rejectedIntegrity = 0;
  for (const r of rows) {
    const manifest = JSON.parse(r.manifest_json) as MusicMasterManifest;
    if (
      manifest.id !== r.id ||
      manifest.sha256 !== r.sha256 ||
      manifest.bytes !== r.bytes ||
      manifest.contractId !== r.contract_id ||
      !manifest.territory.includes(territory) ||
      !sha.test(r.sha256) ||
      !sha.test(r.evidence_sha256) ||
      r.storage_key !==
        "music-supply/masters/" + r.sha256 + (manifest.mime === "audio/mpeg" ? ".mp3" : ".ogg") ||
      !r.quality_key.startsWith("music-supply/quality/" + r.sha256 + "/")
    ) {
      rejectedIntegrity++;
      continue;
    }
    const parts = /^music-supply\/quality\/[0-9a-f]{64}\/([0-9a-f]{64})\.json$/.exec(r.quality_key);
    if (
      !parts ||
      !(await exactObject(bucket, r.storage_key, r.sha256, r.bytes)) ||
      !(await exactObject(bucket, r.quality_key, parts[1])) ||
      !(await exactObject(bucket, r.evidence_key, r.evidence_sha256))
    ) {
      rejectedIntegrity++;
      continue;
    }
    // Every record is fenced against revocation/expiry after the initial
    // page query. The future canonical publisher must recheck at commit time.
    const current = await db
      .prepare(
        "SELECT 1 valid FROM music_masters m JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE m.id=? AND m.status='quality_passed' AND m.sha256=?" +
          " AND m.storage_key=? AND m.quality_key=? AND c.status='active' AND c.expires_at>?" +
          (requireQuiet
            ? " AND EXISTS(SELECT 1 FROM music_analysis_jobs j WHERE j.master_id=m.id" +
              " AND j.policy='" +
              QUIET_READING_POLICY +
              "' AND j.status='approved'" +
              " AND j.master_sha256=m.sha256)"
            : ""),
      )
      .bind(r.id, r.sha256, r.storage_key, r.quality_key, new Date().toISOString())
      .first();
    if (!current) {
      rejectedIntegrity++;
      continue;
    }
    items.push({
      id: r.id,
      masterSha256: r.sha256,
      workKey: manifest.workKey,
      composer: manifest.composer,
      performer: manifest.performer,
      durationEligibility: "qa_passed_only",
      quietSuitability: requireQuiet ? "verified_private_qualification" : "unverified",
      expiresAt: r.expires_at,
    });
  }
  return {
    scope: "isolated_qualified_nonpublic",
    territory,
    items,
    rejectedIntegrity,
    nextCursor: rows.length ? rows[rows.length - 1].id : after,
    maybeMore: rows.length === limit,
    disclaimer:
      "No customer playback authority. Canonical rights and measured quiet suitability remain independent gates.",
  };
}
