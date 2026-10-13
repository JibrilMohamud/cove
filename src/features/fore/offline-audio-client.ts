import type { AudioEdition, AudioTrack } from "./domain";
import { getRecord, putRecord, removeDownload, sha256 } from "./offline";
import { offlineAccountId, putOwnedRecord } from "./offline-account";
import { verifyOfflineAudioLicense, type OfflineAudioLicense } from "./offline-audio-license";

export type LicensedAudioDownload = {
  id: string;
  ownerId: string;
  edition: AudioEdition;
  kind: "audio";
  title: string;
  assetIds: string[];
  keyId: string;
  bytes: number;
  complete: boolean;
  updatedAt: string;
  commercialLicense: OfflineAudioLicense;
};
export const licensedAudioDownloadKey = (editionId: string, userId: string) =>
  `audio:licensed:${userId}:${editionId}`;
export function licensedAudioAssetKey(edition: AudioEdition, track: AudioTrack, userId: string) {
  if (!userId) throw new Error("Sign in before opening licensed offline audio.");
  return `audio:licensed:${userId}:${edition.id}:${track.id}:${track.sha256}`;
}
export function currentAudioDeviceKey() {
  try {
    return localStorage.getItem("fore.device.key") || "";
  } catch {
    return "";
  }
}
export async function storedLicensedAudio(editionId: string, userId = offlineAccountId()) {
  if (!userId) return null;
  return (
    (await getRecord<LicensedAudioDownload>(
      "downloads",
      licensedAudioDownloadKey(editionId, userId),
    ).catch(() => null)) || null
  );
}
export async function validateLicensedDownload(
  record: LicensedAudioDownload,
  userId: string,
  edition = record.edition,
) {
  if (
    !userId ||
    userId !== offlineAccountId() ||
    record.ownerId !== userId ||
    !record.edition.commercial ||
    record.id !== licensedAudioDownloadKey(edition.id, userId)
  )
    throw new Error("This offline recording belongs to a different account.");
  const trusted = await getRecord<{ key: JsonWebKey }>(
    "assets",
    `audio-verification-key:${record.commercialLicense?.receipt?.keyId}`,
  );
  if (!trusted) throw new Error("Reconnect to verify this offline recording.");
  const clockId = `offline-audio-clock:${userId}:${edition.id}:${record.commercialLicense.licenseId}`;
  const clock = await getRecord<{ lastValidatedAt: number }>("assets", clockId);
  if (clock?.lastValidatedAt && Date.now() + 60000 < clock.lastValidatedAt)
    throw new Error("Your device clock changed. Reconnect to renew offline access.");
  const claims = await verifyOfflineAudioLicense(record.commercialLicense, trusted.key, {
    userId,
    deviceKey: currentAudioDeviceKey(),
    edition,
  });
  await putOwnedRecord("assets", {
    id: clockId,
    ownerId: userId,
    lastValidatedAt: Math.max(clock?.lastValidatedAt || 0, Date.now()),
  });
  return claims;
}
export async function openLicensedAudio(editionId: string, userId = offlineAccountId()) {
  const record = await storedLicensedAudio(editionId, userId);
  if (!record)
    throw new Error("No licensed offline copy is available for this account. Reconnect to Cove.");
  try {
    await validateLicensedDownload(record, userId);
  } catch (error) {
    await removeDownload(record.id);
    throw error;
  }
  return record.edition;
}
export async function encryptAudioTrack(
  blob: Blob,
  key: CryptoKey,
  assetId: string,
  licenseId: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${assetId}\n${licenseId}`) },
    key,
    await blob.arrayBuffer(),
  );
  return { ciphertext, iv, mime: blob.type };
}
export async function licensedAudioBlob(
  edition: AudioEdition,
  track: AudioTrack,
  userId = offlineAccountId(),
) {
  const record = await storedLicensedAudio(edition.id, userId);
  if (!record) return null;
  try {
    const claims = await validateLicensedDownload(record, userId, edition);
    const id = licensedAudioAssetKey(edition, track, userId);
    const [asset, storedKey] = await Promise.all([
      getRecord<{
        ownerId: string;
        licenseId: string;
        ciphertext: ArrayBuffer;
        iv: Uint8Array;
        mime: string;
      }>("assets", id),
      getRecord<{ ownerId: string; key: CryptoKey }>("assets", record.keyId),
    ]);
    if (!asset) return null;
    if (
      !storedKey ||
      storedKey.ownerId !== userId ||
      asset.ownerId !== userId ||
      asset.licenseId !== claims.licenseId
    )
      throw new Error("This offline audio cache is invalid. Save the recording again.");
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(asset.iv),
        additionalData: new TextEncoder().encode(`${id}\n${claims.licenseId}`),
      },
      storedKey.key,
      asset.ciphertext,
    );
    if (!track.sha256 || (await sha256(bytes)) !== track.sha256)
      throw new Error("Offline audio integrity check failed. Save the recording again.");
    return new Blob([bytes], { type: asset.mime || track.mime });
  } catch (error) {
    await removeDownload(record.id);
    throw error;
  }
}
export async function pinAudioVerificationKey(license: OfflineAudioLicense) {
  // Call only with the authenticated HTTPS issuance response, never a locally imported key.
  await putRecord("assets", {
    id: `audio-verification-key:${license.receipt.keyId}`,
    key: license.verificationKey,
  });
}
