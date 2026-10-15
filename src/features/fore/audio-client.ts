import { matchingEpub, loadTiming, timingKey } from "./biosync-client";
import { api, type CatalogBook } from "./client";
import type { AudioEdition, AudioTrack } from "./domain";
import { getRecord, putRecord, removeDownload, sha256, requestPersistentStorage } from "./offline";
import { offlineAccountId, canUseOfflineFallback, putOwnedRecord } from "./offline-account";
import { verifyOfflineAudioLicense, type OfflineAudioLicense } from "./offline-audio-license";
import {
  currentAudioDeviceKey,
  encryptAudioTrack,
  licensedAudioAssetKey,
  licensedAudioBlob,
  licensedAudioDownloadKey,
  openLicensedAudio,
  pinAudioVerificationKey,
  storedLicensedAudio,
} from "./offline-audio-client";
import { downloadZip, type ZipEntry } from "./zip-stream";
export const trackUrl = (id: string, trackId: string) =>
  `/api/fore/audio/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`;
export const audioAssetKey = (
  edition: AudioEdition,
  track: AudioTrack,
  userId = offlineAccountId(),
) =>
  edition.commercial
    ? licensedAudioAssetKey(edition, track, userId)
    : `audio:${edition.id}:${track.id}:${track.sha256 || track.url}`;
export async function loadEdition(id: string, userId = offlineAccountId()): Promise<AudioEdition> {
  try {
    const edition = await api<AudioEdition>("/audio/" + id);
    if (edition.commercial) {
      const local = await storedLicensedAudio(id, userId);
      if (local) {
        if (!edition.hasAccess || !edition.offlineEligible) await removeDownload(local.id);
        else
          try {
            await api(
              `/audio/${encodeURIComponent(id)}/offline-license/verify`,
              "POST",
              {
                licenseId: local.commercialLicense.licenseId,
                token: local.commercialLicense.token,
              },
              { timeoutMs: 10000 },
            );
          } catch (error) {
            if (!canUseOfflineFallback(error)) await removeDownload(local.id);
          }
      }
    }
    return edition;
  } catch (error) {
    if (!canUseOfflineFallback(error)) {
      const local = await storedLicensedAudio(id, userId);
      if (local) await removeDownload(local.id);
      throw error;
    }
    if (id.startsWith("ca_")) return openLicensedAudio(id, userId);
    const local = await getRecord("downloads", "audio:" + id);
    if (local?.edition && !local.edition.commercial && local.edition.id === id)
      return local.edition;
    throw error;
  }
}

function deviceIdentity() {
  const keyName = "fore.device.key";
  let key = localStorage.getItem(keyName);
  if (!key) {
    key = crypto.randomUUID() + crypto.randomUUID();
    localStorage.setItem(keyName, key);
  }
  const platform = (navigator as any).userAgentData?.platform || navigator.platform || "Web";
  const name = `${platform} browser`;
  return { deviceKey: key, name, platform: String(platform).slice(0, 80) };
}
export async function saveCommercialAudioOffline(
  edition: AudioEdition,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  if (!edition.commercial) return saveAudioOffline(edition, signal, progress);
  if (!edition.hasAccess)
    throw Error("Purchase access is required before saving this audiobook offline.");
  if (!edition.offlineEligible)
    throw Error("This audiobook's license does not permit offline listening.");
  const userId = offlineAccountId();
  if (!userId) throw Error("Sign in before saving licensed audio offline.");
  const device = await api("/account/device/register", "POST", deviceIdentity());
  const license = await api<OfflineAudioLicense>(
    `/audio/${encodeURIComponent(edition.id)}/offline-license`,
    "POST",
    {
      deviceId: device.id,
      protocolVersion: 1,
    },
  );
  await verifyOfflineAudioLicense(license, license.verificationKey, {
    userId,
    deviceKey: currentAudioDeviceKey(),
    edition,
  });
  await pinAudioVerificationKey(license);
  const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const keyId = `offline-audio-key:${userId}:${edition.id}:${license.licenseId}`;
  const existing = await storedLicensedAudio(edition.id, userId);
  if (existing) await removeDownload(existing.id);
  await putOwnedRecord("assets", { id: keyId, ownerId: userId, key: encryptionKey });
  requestPersistentStorage();
  let bytes = 0;
  const assetIds: string[] = [
    keyId,
    `offline-audio-clock:${userId}:${edition.id}:${license.licenseId}`,
  ];
  await putOwnedRecord("downloads", {
    id: licensedAudioDownloadKey(edition.id, userId),
    ownerId: userId,
    title: edition.title,
    edition,
    kind: "audio",
    bytes,
    assetIds,
    keyId,
    complete: false,
    updatedAt: new Date().toISOString(),
    commercialLicense: license,
  });
  for (let i = 0; i < edition.tracks.length; i++) {
    if (signal.aborted) throw new DOMException("Canceled", "AbortError");
    const track = edition.tracks[i];
    progress(`Saving licensed track ${i + 1} of ${edition.tracks.length}`);
    if (offlineAccountId() !== userId)
      throw Error("Your account changed. Save this recording again after signing in.");
    const response = await fetch(trackUrl(edition.id, track.id), {
      signal,
      credentials: "same-origin",
    });
    if (!response.ok) throw Error("This licensed track could not be downloaded.");
    const blob = await response.blob();
    if (track.sha256 && (await sha256(await blob.arrayBuffer())) !== track.sha256)
      throw Error("Audio integrity check failed. Please try again.");
    const key = licensedAudioAssetKey(edition, track, userId);
    if (offlineAccountId() !== userId)
      throw Error("Your account changed. Save this recording again after signing in.");
    await putOwnedRecord("assets", {
      id: key,
      ownerId: userId,
      licenseId: license.licenseId,
      ...(await encryptAudioTrack(blob, encryptionKey, key, license.licenseId)),
    });
    assetIds.push(key);
    bytes += blob.size;
    await putOwnedRecord("downloads", {
      id: licensedAudioDownloadKey(edition.id, userId),
      ownerId: userId,
      keyId,
      title: edition.title,
      edition,
      kind: "audio",
      bytes,
      assetIds,
      complete: i === edition.tracks.length - 1,
      updatedAt: new Date().toISOString(),
      commercialLicense: license,
    });
  }
}

export async function audioBlob(edition: AudioEdition, trackId: string, signal?: AbortSignal) {
  const track = edition.tracks.find((t) => t.id === trackId)!;
  if (!track) throw Error("Audio track not found.");
  if (edition.commercial) {
    if (!edition.hasAccess || !offlineAccountId())
      throw Error("Purchase access is required for this recording.");
    const local = await licensedAudioBlob(edition, track);
    if (local) return local;
  }
  const key = audioAssetKey(edition, track),
    stored = edition.commercial ? null : await getRecord("assets", key).catch(() => null);
  if (stored) return stored.blob as Blob;
  const r = await fetch(trackUrl(edition.id, trackId), { signal });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw Error(d.error || "This track could not be loaded.");
  }
  return r.blob();
}
export async function saveAudioOffline(
  edition: AudioEdition,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  if (edition.commercial) return saveCommercialAudioOffline(edition, signal, progress);
  requestPersistentStorage();
  let bytes = 0;
  const assetIds: string[] = [];
  if (edition.alignment?.version === 2) {
    progress("Saving matching text and Biosync timing…");
    const text = await matchingEpub(edition);
    bytes += text.byteLength;
    assetIds.push("epub:sha:" + edition.epubSha256);
    for (const map of edition.alignment.maps || []) {
      await loadTiming(edition, map.trackId, signal);
      assetIds.push(timingKey(map.sha256));
    }
  }

  for (let i = 0; i < edition.tracks.length; i++) {
    if (signal.aborted) throw new DOMException("Canceled", "AbortError");
    const track = edition.tracks[i];
    progress(`Saving track ${i + 1} of ${edition.tracks.length}`);
    const blob = await audioBlob(edition, track.id, signal);
    if (track.sha256 && (await sha256(await blob.arrayBuffer())) !== track.sha256)
      throw Error("Audio integrity check failed. Please try again.");
    const key = audioAssetKey(edition, track);
    await putRecord("assets", { id: key, blob });
    assetIds.push(key);
    bytes += blob.size;
    await putRecord("downloads", {
      id: "audio:" + edition.id,
      title: edition.title,
      edition,
      kind: "audio",
      bytes,
      assetIds,
      complete: i === edition.tracks.length - 1,
      updatedAt: new Date().toISOString(),
    });
  }
}
export async function downloadAudioPackage(
  edition: AudioEdition,
  book: CatalogBook | null,
  signal: AbortSignal,
  progress: (text: string) => void,
) {
  if (edition.commercial)
    throw Error("Licensed recordings cannot be exported as unrestricted archives.");
  const files: ZipEntry[] = [];
  const manifest: any = {
    format: "fore-media-package",
    version: 3,
    createdAt: new Date().toISOString(),
    privacy: {
      containsPersonalData: false,
      containsBookContent: !!book,
      containsAudioContent: true,
    },
    source: { type: "project-gutenberg", url: edition.sourceUrl, rights: edition.rights },
    book: book ? { id: String(book.id), title: book.title, file: "book.epub" } : null,
    audio: {
      ...edition,
      tracks: edition.tracks.map((t) => ({
        ...t,
        file: `audio/${t.id}.${t.mime === "audio/mpeg" ? "mp3" : t.mime === "audio/ogg" ? "ogg" : "m4a"}`,
      })),
    },
    biosync: {
      status: edition.alignment ? "requires-matching-checksums" : "unavailable",
      precision: edition.alignment?.precision || null,
      epubSha256: edition.epubSha256,
      file: edition.alignment ? "alignment.json" : null,
    },
  };
  if (book)
    files.push({
      name: "book.epub",
      open: async () => {
        const response = await fetch("/api/fore/books/" + book.id + "/download/epub", { signal });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          throw Error(
            detail?.error || "This edition cannot be exported with the audiobook package.",
          );
        }
        const bytes = await response.arrayBuffer();
        manifest.book.sha256 = await sha256(bytes);
        manifest.book.bytes = bytes.byteLength;
        if (edition.alignment && manifest.book.sha256 !== edition.epubSha256) {
          manifest.biosync.status = "edition-mismatch";
          if (edition.alignment.version === 2)
            throw Error(
              "The downloadable EPUB does not match this BioSync recording, so Cove will not create a misleading text + audio package.",
            );
        } else if (edition.alignment) manifest.biosync.status = "verified";
        return new Blob([bytes], { type: "application/epub+zip" });
      },
    });
  for (const track of manifest.audio.tracks)
    files.push({
      name: track.file,
      open: async () => {
        const local = await getRecord("assets", audioAssetKey(edition, track)).catch(() => null);
        return local?.blob || fetch(trackUrl(edition.id, track.id), { signal });
      },
    });
  const jsonFile = (name: string, value: () => unknown) =>
    files.push({
      name,
      open: async () => new Blob([JSON.stringify(value(), null, 2)], { type: "application/json" }),
    });
  if (edition.alignment) jsonFile("alignment.json", () => edition.alignment);
  for (const map of edition.alignment?.maps || [])
    files.push({
      name: `timing/${map.trackId}.json`,
      open: async () =>
        new Blob([JSON.stringify(await loadTiming(edition, map.trackId, signal))], {
          type: "application/json",
        }),
    });
  jsonFile("manifest.json", () => manifest);
  files.push({
    name: "README.txt",
    open: async () =>
      new Blob([
        "FORE MEDIA PACKAGE v3\n\nThis archive contains book/audio media, metadata, and any verified BioSync alignment selected for export. IT CONTAINS NO FORE ACCOUNT DATA: no highlights, notes, saved vocabulary, reading positions, shelves, or reading history are included.\n\nBiosync must be disabled unless EPUB and every used audio checksum match the alignment. Version 2 word maps are automatically checked against independent ASR and exact EPUB word locations. Unmatched passages have no synchronized handoff. Chapter alignment resumes at a chapter boundary; sentence alignment resumes at the start of a verified sentence. Never infer timestamps by multiplying overall book progress by recording duration. Unaligned audio still supports track-level playback bookmarks.\n\nSee manifest.json for the original source page and rights. Redistribution rights for the included media depend on the source/license. Use Cove's explicit reading-data export or private backup when you intend to archive personal reading data.\n",
      ]),
  });
  await downloadZip(
    files,
    edition.title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 70) +
      (book ? "-text-and-audio" : "-audio") +
      ".zip",
    signal,
    progress,
  );
}
