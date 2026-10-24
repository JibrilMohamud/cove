/**
 * Commercial licensing policy for the detached music data plane.
 * A source contract is reviewed ONCE; each immutable exact master must still
 * carry an explicitly covered performer, composition, territory and checksum.
 *
 * Acoustic suitability is completely independent of rights authorization.
 * This module NEVER activates public playback or modifies Cove primary D1.
 */
export type MusicSupplyContract = {
  id: string;
  provider: string;
  status: "pending" | "active" | "revoked";
  licensedOrigin: string;
  territories: string[];
  expiresAt: string;
  evidenceKey: string;
  evidenceSha256: string;
  commercialStreaming: boolean;
  masterRights: boolean;
  performanceRights: boolean;
  compositionRights: boolean;
  arrangementRights: boolean;
  lyricsRights: boolean;
};

export type MusicMasterManifest = {
  id: string;
  contractId: string;
  title: string;
  composer: string;
  performer: string;
  workKey: string;
  sha256: string;
  bytes: number;
  mime: "audio/mpeg" | "audio/ogg";
  territory: string[];
  hasVocals: boolean | null;
  sourceUrl: string;
  sourceLicenseId: string;
  attribution: string;
};

const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const sha = /^[0-9a-f]{64}$/;
const country = /^[A-Z]{2}$/;
const isText = (x: unknown, maximum = 250): x is string =>
  typeof x === "string" && x.length > 1 && x.length <= maximum && x.trim() === x;
const countries = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 250 &&
  new Set(value).size === value.length &&
  value.every((x) => typeof x === "string" && country.test(x));
function url(value: unknown): string {
  if (!isText(value, 1000)) throw new Error("music_invalid_source_url");
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname.endsWith(".local") ||
    parsed.hostname.endsWith(".internal") ||
    parsed.hostname.startsWith("[") ||
    /^\\d+(?:\\.\\d+){3}$/.test(parsed.hostname)
  )
    throw new Error("music_unsafe_source_url");
  return parsed.href;
}
function iso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("music_invalid_expiry");
  return value;
}

export function validateMusicContract(value: unknown): MusicSupplyContract {
  if (!value || typeof value !== "object") throw new Error("music_invalid_contract");
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    !id.test(v.id) ||
    !isText(v.provider, 160) ||
    typeof v.licensedOrigin !== "string" ||
    !countries(v.territories) ||
    typeof v.evidenceKey !== "string" ||
    !/^music-supply\/evidence\/[a-zA-Z0-9._:-]{3,120}\/[0-9a-f]{64}\.json$/.test(v.evidenceKey) ||
    typeof v.evidenceSha256 !== "string" ||
    !sha.test(v.evidenceSha256) ||
    v.commercialStreaming !== true ||
    v.masterRights !== true ||
    v.performanceRights !== true ||
    v.compositionRights !== true ||
    v.arrangementRights !== true ||
    v.lyricsRights !== true
  )
    throw new Error("music_missing_verified_rights_layers");
  url(v.licensedOrigin);
  const expiresAt = iso(v.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("music_contract_expired");
  return {
    id: v.id,
    provider: v.provider,
    status: "pending",
    licensedOrigin: v.licensedOrigin,
    territories: v.territories,
    expiresAt,
    evidenceKey: v.evidenceKey,
    evidenceSha256: v.evidenceSha256,
    commercialStreaming: true,
    masterRights: true,
    performanceRights: true,
    compositionRights: true,
    arrangementRights: true,
    lyricsRights: true,
  } as MusicSupplyContract;
}

export function validateMusicMaster(
  value: unknown,
  contract: MusicSupplyContract,
): MusicMasterManifest {
  if (!value || typeof value !== "object") throw new Error("music_invalid_master");
  const v = value as Record<string, unknown>;
  if (contract.status !== "active" || Date.parse(contract.expiresAt) <= Date.now())
    throw new Error("music_contract_not_active");
  if (
    typeof v.id !== "string" ||
    !id.test(v.id) ||
    v.contractId !== contract.id ||
    !isText(v.title) ||
    !isText(v.composer) ||
    !isText(v.performer) ||
    !isText(v.workKey) ||
    typeof v.sha256 !== "string" ||
    !sha.test(v.sha256) ||
    !Number.isInteger(v.bytes) ||
    Number(v.bytes) < 128 ||
    Number(v.bytes) > 25 * 1024 * 1024 ||
    !["audio/mpeg", "audio/ogg"].includes(String(v.mime)) ||
    !countries(v.territory) ||
    !(v.territory as string[]).every((c) => contract.territories.includes(c)) ||
    ![true, false, null].includes(v.hasVocals as boolean | null) ||
    !isText(v.sourceLicenseId, 160) ||
    !isText(v.attribution, 1000)
  )
    throw new Error("music_master_not_covered_by_contract");
  const sourceUrl = url(v.sourceUrl);
  const source = new URL(sourceUrl);
  const origin = new URL(contract.licensedOrigin);
  if (
    source.hostname !== origin.hostname ||
    source.protocol !== origin.protocol ||
    !source.pathname.startsWith(origin.pathname)
  )
    throw new Error("music_source_outside_approved_catalog");
  return {
    id: v.id,
    contractId: contract.id,
    title: v.title,
    composer: v.composer,
    performer: v.performer,
    workKey: v.workKey,
    sha256: v.sha256,
    bytes: Number(v.bytes),
    mime: v.mime as MusicMasterManifest["mime"],
    territory: v.territory as string[],
    hasVocals: v.hasVocals as boolean | null,
    sourceUrl,
    sourceLicenseId: v.sourceLicenseId,
    attribution: v.attribution,
  };
}

export type MusicQualityAttestation = {
  sha256: string;
  bytes: number;
  decodedFully: true;
  durationSeconds: number;
  integratedLufs: number;
  truePeakDbfs: number;
  silenceRatio: number;
  clippedSampleRatio: number;
};
export function validateMusicQuality(
  value: unknown,
  sha256: string,
  bytes: number,
): MusicQualityAttestation {
  if (!value || typeof value !== "object") throw new Error("music_invalid_audio_qa");
  const v = value as Record<string, unknown>;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (
    v.sha256 !== sha256 ||
    v.bytes !== bytes ||
    v.decodedFully !== true ||
    !finite(v.durationSeconds) ||
    v.durationSeconds < 20 ||
    v.durationSeconds > 14400 ||
    !finite(v.integratedLufs) ||
    v.integratedLufs < -40 ||
    v.integratedLufs > -8 ||
    !finite(v.truePeakDbfs) ||
    v.truePeakDbfs > 0 ||
    v.truePeakDbfs < -70 ||
    !finite(v.silenceRatio) ||
    v.silenceRatio < 0 ||
    v.silenceRatio >= 0.25 ||
    !finite(v.clippedSampleRatio) ||
    v.clippedSampleRatio < 0 ||
    v.clippedSampleRatio >= 0.001
  )
    throw new Error("music_audio_quality_failed");
  return v as MusicQualityAttestation;
}

export const MUSIC_SUPPLY_MAX_BATCH = 8;
