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
const trustKey = (userId: string, keyId: string) =>
  "epub:verified-key:" + userId + ":" + keyId;
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
async function validate(record: LicensedEpub, userId: string): Promise<OfflineEpubClaims> {
  const invalid = () =>
    new Error("Offline access expired or became invalid. Reconnect to renew the license.");
  if (!userId || offlineAccountId() !== userId || record.ownerId !== userId || !deviceKey())
    throw invalid();
  try {
    const publicKey = publicAudioKey(record.publicKey);
    if (record.receipt.keyId !== (await audioKeyId(publicKey))) throw invalid();
    const keyValue = await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyValue,
      decodeBase64Url(record.receipt.signature),
      new TextEncoder().encode(OFFLINE_EPUB_CONTEXT + record.receipt.payload),
    );
    if (!valid) throw invalid();
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(record.receipt.payload)),
    ) as OfflineEpubClaims;
    const expiry = Date.parse(claims.expiresAt);
    const issued = Date.parse(claims.issuedAt);
    if (
      claims.version !== 1 ||
      claims.audience !== "cove-offline-epub" ||
      claims.userId !== userId ||
      claims.productId !== record.book.productId ||
      claims.assetVersionId !== record.assetVersionId ||
      claims.keyId !== record.receipt.keyId ||
      claims.deviceKeyHash !== (await hashText(deviceKey())) ||
      claims.expiresAt !== record.expiresAt ||
      !Number.isFinite(issued) ||
      issued > Date.now() + 60000 ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry <= issued ||
      expiry - issued > 48 * 3600000
    )
      throw invalid();
    return claims;
  } catch {
    throw invalid();
  }
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
export async function licensedEpubBytes(ref: string, userId = offlineAccountId()) {
  const record = await licensedEpubRecord(ref, userId);
  if (!record) return null;
  const asset = await getRecord<{
    ownerId: string;
    iv: Uint8Array;
    ciphertext: ArrayBuffer;
    digest: string;
  }>("assets", record.id);
  const stored = await getRecord<{ ownerId: string; key: CryptoKey }>("assets", record.id + ":key");
  if (!asset || !stored || asset.ownerId !== userId || stored.ownerId !== userId) return null;
  const claims = await validate(record, userId);
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
    throw new Error("Licensed offline EPUB integrity check failed.");
  return plain;
}
export async function saveLicensedEpub(book: CatalogBook) {
  const ownerId = offlineAccountId();
  if (!ownerId || !book.productId || !deviceKey())
    throw new Error("Sign in and register this device before saving a licensed edition.");
  const license = await api<{
    url: string;
    publicKey: JsonWebKey;
    receipt: SignedReceipt;
    expiresAt: string;
    assetVersionId: string;
  }>("/offline-epub/license", "POST", { productId: book.productId, deviceKey: deviceKey() });
  const response = await fetch(license.url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("The licensed EPUB could not be retrieved.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 60_000_000)
    throw new Error("This edition exceeds offline storage limits.");
  const id = key(ownerId, String(book.id));
  const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(license.receipt.payload)),
  ) as OfflineEpubClaims;
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(claims.licenseId) },
    encryptionKey,
    bytes,
  );
  await putOwnedRecord("assets", { id: id + ":key", ownerId, key: encryptionKey });
  await putOwnedRecord("assets", { id, ownerId, iv, ciphertext, digest: await sha256(bytes) });
  const record: LicensedEpub = {
    id,
    kind: "licensed-epub",
    ownerId,
    title: book.title,
    book,
    receipt: license.receipt,
    publicKey: license.publicKey,
    expiresAt: license.expiresAt,
    assetVersionId: license.assetVersionId,
    assetIds: [id, id + ":key"],
    complete: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    await validate(record, ownerId);
    await putOwnedRecord("downloads", record);
  } catch (error) {
    await deleteRecord("assets", id);
    await deleteRecord("assets", id + ":key");
    throw error;
  }
}
