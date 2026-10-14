import type { CatalogBook } from "./client";
import { api } from "./client";
import { getRecord, putRecord, deleteRecord, getRecords, sha256 } from "./offline";
import { offlineAccountId, putOwnedRecord } from "./offline-account";
import { audioKeyId, publicAudioKey } from "./offline-audio-license";
import { TRUSTED_OFFLINE_EPUB_PUBLIC_KEYS } from "./offline-epub-pin";
import {
  OFFLINE_EPUB_RENEW_WINDOW_MS,
  verifyOfflineEpubReceipt,
  type OfflineEpubClaims,
  type SignedOfflineEpubReceipt,
} from "./offline-epub-crypto";

type LicensedEpub = {
  id: string;
  kind: "licensed-epub";
  ownerId: string;
  title: string;
  book: CatalogBook;
  assetIds: string[];
  complete: boolean;
  receipt: SignedOfflineEpubReceipt;
  expiresAt: string;
  assetVersionId: string;
  updatedAt: string;
};
const key = (userId: string, id: string) => "epub:licensed:" + userId + ":" + id;
const trustKey = (userId: string, keyId: string) => "epub:verified-key:" + userId + ":" + keyId;
type TrustedVerificationKey = {
  id: string;
  ownerId: string;
  origin: string;
  keyId: string;
  publicKey: JsonWebKey;
  verifiedAt: string;
};
const online = () => typeof navigator !== "undefined" && navigator.onLine !== false;
const renewals = new Map<string, Promise<void>>();
const deviceKey = () => {
  try {
    return localStorage.getItem("fore.device.key") || "";
  } catch {
    return "";
  }
};
function refs(book: CatalogBook) {
  return [String(book.id), book.productId, book.publicProductId, book.sourceExternalId].filter(
    (id): id is string => !!id,
  );
}
async function provisionTrustedKey(userId: string) {
  if (!online()) throw Error("Reconnect to establish offline signing-key trust.");
  const result = await api<{ keyId: string; publicKey: JsonWebKey }>(
    "/offline-epub/verification-key",
  );
  const publicKey = publicAudioKey(result.publicKey);
  const keyId = await audioKeyId(publicKey);
  if (result.keyId !== keyId) throw Error("Cove offline signing-key mismatch.");
  const pinnedIds = await Promise.all(TRUSTED_OFFLINE_EPUB_PUBLIC_KEYS.map(audioKeyId));
  if (!pinnedIds.includes(keyId))
    throw Error("Cove offline verifier has not been pinned in this application version.");
  await putOwnedRecord("assets", {
    id: trustKey(userId, keyId),
    ownerId: userId,
    origin: window.location.origin,
    keyId,
    publicKey,
    verifiedAt: new Date().toISOString(),
  });
}
async function trustedVerificationKey(userId: string, keyId: string) {
  const saved = await getRecord<TrustedVerificationKey>("assets", trustKey(userId, keyId));
  const pinnedIds = await Promise.all(TRUSTED_OFFLINE_EPUB_PUBLIC_KEYS.map(audioKeyId));
  if (
    !saved ||
    saved.ownerId !== userId ||
    saved.origin !== window.location.origin ||
    saved.keyId !== keyId ||
    (await audioKeyId(saved.publicKey)) !== keyId ||
    !pinnedIds.includes(keyId)
  )
    throw Error("Trusted offline verification key unavailable. Reconnect to Cove.");
  return saved.publicKey;
}
async function validate(record: LicensedEpub, userId: string): Promise<OfflineEpubClaims> {
  if (!userId || offlineAccountId() !== userId || record.ownerId !== userId || !deviceKey())
    throw Error("This EPUB belongs to a different account or device.");
  const trusted = await trustedVerificationKey(userId, record.receipt.keyId);
  const clockId = "epub:clock:" + userId + ":" + record.id;
  const clock = await getRecord<{ ownerId: string; lastValidatedAt: number }>("assets", clockId);
  const claims = await verifyOfflineEpubReceipt(record.receipt, trusted, {
    userId,
    productId: String(record.book.productId || ""),
    assetVersionId: record.assetVersionId,
    expiresAt: record.expiresAt,
    deviceKey: deviceKey(),
    previousValidatedAt: clock?.lastValidatedAt,
  });
  await putOwnedRecord("assets", {
    id: clockId,
    ownerId: userId,
    lastValidatedAt: Math.max(clock?.lastValidatedAt || 0, Date.now()),
  });
  return claims;
}
export async function licensedEpubRecord(ref: string, userId = offlineAccountId()) {
  if (!userId) return null;
  const records = await getRecords<LicensedEpub>("downloads");
  for (const record of records) {
    if (
      record.kind !== "licensed-epub" ||
      !record.complete ||
      record.ownerId !== userId ||
      !refs(record.book).includes(ref)
    )
      continue;
    try {
      await validate(record, userId);
      return record;
    } catch {
      return null;
    }
  }
  return null;
}
type OfflineLicense = {
  url: string;
  receipt: SignedOfflineEpubReceipt;
  expiresAt: string;
  assetVersionId: string;
};
async function rawRecord(ref: string, userId: string) {
  return (
    (await getRecords<LicensedEpub>("downloads")).find(
      (r) =>
        r.kind === "licensed-epub" &&
        r.ownerId === userId &&
        r.complete &&
        refs(r.book).includes(ref),
    ) || null
  );
}
async function decryptRecord(record: LicensedEpub, userId: string) {
  const claims = await validate(record, userId);
  const assetId = record.assetIds.find((item) => item.includes(":blob:")) || record.id;
  const keyId = record.assetIds.find((item) => item.includes(":key:")) || record.id + ":key";
  const asset = await getRecord<{
    ownerId: string;
    iv: Uint8Array;
    ciphertext: ArrayBuffer;
    digest: string;
  }>("assets", assetId);
  const stored = await getRecord<{ ownerId: string; key: CryptoKey }>("assets", keyId);
  if (!asset || !stored || asset.ownerId !== userId || stored.ownerId !== userId)
    throw Error("The protected EPUB is incomplete.");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(asset.iv),
      additionalData: new TextEncoder().encode(claims.licenseId),
    },
    stored.key,
    asset.ciphertext,
  );
  if ((await sha256(plain)) !== asset.digest)
    throw Error("Licensed offline EPUB integrity check failed.");
  return plain;
}
async function requestLicense(book: CatalogBook, userId: string) {
  await provisionTrustedKey(userId);
  const license = await api<OfflineLicense>("/offline-epub/license", "POST", {
    productId: book.productId,
    deviceKey: deviceKey(),
  });
  const trusted = await trustedVerificationKey(userId, license.receipt.keyId);
  await verifyOfflineEpubReceipt(license.receipt, trusted, {
    userId,
    productId: String(book.productId || ""),
    assetVersionId: license.assetVersionId,
    expiresAt: license.expiresAt,
    deviceKey: deviceKey(),
  });
  return license;
}
async function storeEncrypted(
  book: CatalogBook,
  userId: string,
  license: OfflineLicense,
  bytes: ArrayBuffer,
) {
  if (bytes.byteLength > 60_000_000) throw Error("This edition exceeds offline storage limits.");
  const id = key(userId, String(book.id));
  const trusted = await trustedVerificationKey(userId, license.receipt.keyId);
  const claims = await verifyOfflineEpubReceipt(license.receipt, trusted, {
    userId,
    productId: String(book.productId || ""),
    assetVersionId: license.assetVersionId,
    expiresAt: license.expiresAt,
    deviceKey: deviceKey(),
  });
  const previous = await getRecord<LicensedEpub>("downloads", id);
  const assetId = id + ":blob:" + crypto.randomUUID();
  const keyId = id + ":key:" + crypto.randomUUID();
  const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(claims.licenseId) },
    encryptionKey,
    bytes,
  );
  try {
    await putOwnedRecord("assets", { id: keyId, ownerId: userId, key: encryptionKey });
    await putOwnedRecord("assets", {
      id: assetId,
      ownerId: userId,
      iv,
      ciphertext,
      digest: await sha256(bytes),
    });
    const record: LicensedEpub = {
      id,
      kind: "licensed-epub",
      ownerId: userId,
      title: book.title,
      book,
      receipt: license.receipt,
      expiresAt: license.expiresAt,
      assetVersionId: license.assetVersionId,
      assetIds: [assetId, keyId],
      complete: true,
      updatedAt: new Date().toISOString(),
    };
    await putOwnedRecord("downloads", record);
  } catch (error) {
    await deleteRecord("assets", assetId);
    await deleteRecord("assets", keyId);
    throw error;
  }
  // Never delete the previous licensed copy until the replacement is fully committed.
  for (const oldId of previous?.assetIds || [])
    if (oldId !== assetId && oldId !== keyId) await deleteRecord("assets", oldId);
}
export async function saveLicensedEpub(book: CatalogBook) {
  const userId = offlineAccountId();
  if (!userId || !book.productId || !deviceKey())
    throw Error("Sign in and register this device before saving a licensed edition.");
  if (!online()) throw Error("Reconnect to authorize the licensed EPUB download.");
  const license = await requestLicense(book, userId);
  const response = await fetch(license.url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw Error("The licensed EPUB could not be retrieved.");
  await storeEncrypted(book, userId, license, await response.arrayBuffer());
}
export async function renewLicensedEpub(ref: string, userId = offlineAccountId()) {
  if (!userId || offlineAccountId() !== userId || !online()) return false;
  const record = await rawRecord(ref, userId);
  if (!record) return false;
  const license = await requestLicense(record.book, userId);
  let bytes: ArrayBuffer | null = null;
  if (license.assetVersionId === record.assetVersionId) {
    try {
      bytes = await decryptRecord(record, userId);
    } catch {
      // Expired, damaged, or revoked content requires a new authorized download.
    }
  }
  if (!bytes) {
    const response = await fetch(license.url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Error("The refreshed licensed EPUB could not be retrieved.");
    bytes = await response.arrayBuffer();
  }
  await storeEncrypted(record.book, userId, license, bytes);
  return true;
}
export async function licensedEpubBytes(ref: string, userId = offlineAccountId()) {
  if (!userId) return null;
  let record = await rawRecord(ref, userId);
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= Date.now() && online()) {
    try {
      await renewLicensedEpub(ref, userId);
      record = await rawRecord(ref, userId);
    } catch {
      return null;
    }
  }
  if (!record) return null;
  try {
    const bytes = await decryptRecord(record, userId);
    if (
      online() &&
      Date.parse(record.expiresAt) - Date.now() <= OFFLINE_EPUB_RENEW_WINDOW_MS &&
      !renewals.has(record.id)
    ) {
      const promise = renewLicensedEpub(ref, userId)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => renewals.delete(record.id));
      renewals.set(record.id, promise);
    }
    return bytes;
  } catch {
    return null;
  }
}
