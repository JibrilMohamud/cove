import type { CatalogBook } from "./client";
import { api } from "./client";
import { getRecord, deleteRecord, getRecords, sha256 } from "./offline";
import { offlineAccountId, putOwnedRecord } from "./offline-account";
import { decodeBase64Url, hashText, publicAudioKey, audioKeyId } from "./offline-audio-license";
import {
  OFFLINE_EPUB_CONTEXT,
  OFFLINE_EPUB_RENEWAL_RETRY_MS,
  shouldRenewOfflineEpub,
  validOfflineEpubWindow,
} from "./offline-epub-policy";
import type { OfflineEpubClaims } from "./offline-epub.server";

type SignedReceipt = { payload: string; signature: string; keyId: string };
type LicensedEpub = {
  id: string;
  kind: "licensed-epub";
  ownerId: string;
  title: string;
  book: CatalogBook;
  assetIds: string[];
  complete: boolean;
  receipt: SignedReceipt;
  expiresAt: string;
  assetVersionId: string;
  updatedAt: string;
};
type EncryptedEpub = {
  ownerId: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  digest: string;
};
type VerificationKey = { id: string; ownerId: string; key: JsonWebKey };
const key = (userId: string, id: string) => `epub:licensed:${userId}:${id}`;
const trustKey = (ownerId: string, keyId: string) => `epub-verification-key:${ownerId}:${keyId}`;
const retryKey = (ownerId: string, id: string) => `epub-renewal-attempt:${ownerId}:${id}`;
const clockKey = (ownerId: string, id: string) => `epub-last-validated:${ownerId}:${id}`;
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
/** Trust is bootstrapped over authenticated HTTPS, not from the mutable EPUB download record. */
async function cacheTrustedKey(ownerId: string) {
  const published = await api<{ key: JsonWebKey; keyId: string }>("/offline-epub/verification-key");
  const validated = publicAudioKey(published.key);
  if ((await audioKeyId(validated)) !== published.keyId)
    throw new Error("The server's offline verification key did not match its identity.");
  if (offlineAccountId() !== ownerId)
    throw new Error("This offline download belongs to another signed-in account.");
  await putOwnedRecord("assets", {
    id: trustKey(ownerId, published.keyId),
    ownerId,
    key: validated,
  } satisfies VerificationKey);
  return published.keyId;
}
async function validate(record: LicensedEpub, userId: string): Promise<OfflineEpubClaims> {
  const invalid = () =>
    new Error("Offline access expired or became invalid. Reconnect to renew the license.");
  if (!userId || offlineAccountId() !== userId || record.ownerId !== userId || !deviceKey())
    throw invalid();
  try {
    // A key shipped alongside a cached receipt is never itself a trust anchor.
    const trusted = await getRecord<VerificationKey>(
      "assets",
      trustKey(userId, record.receipt.keyId),
    );
    if (!trusted || trusted.ownerId !== userId) throw invalid();
    const publicKey = publicAudioKey(trusted.key);
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
    const clock = await getRecord<{ ownerId: string; lastValidatedAt: number }>(
      "assets",
      clockKey(userId, record.id),
    );
    const now = Date.now();
    if (
      claims.version !== 1 ||
      claims.audience !== "cove-offline-epub" ||
      claims.userId !== userId ||
      claims.productId !== record.book.productId ||
      claims.assetVersionId !== record.assetVersionId ||
      claims.keyId !== record.receipt.keyId ||
      claims.deviceKeyHash !== (await hashText(deviceKey())) ||
      claims.expiresAt !== record.expiresAt ||
      !validOfflineEpubWindow(issued, expiry, now) ||
      (clock?.ownerId === userId &&
        Number.isFinite(clock.lastValidatedAt) &&
        now + 60_000 < clock.lastValidatedAt)
    )
      throw invalid();
    await putOwnedRecord("assets", {
      id: clockKey(userId, record.id),
      ownerId: userId,
      lastValidatedAt: Math.max(now, clock?.lastValidatedAt || 0),
    });
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
  const [encryptedId, encryptionKeyId] = record.assetIds;
  if (!encryptedId || !encryptionKeyId) return null;
  const asset = await getRecord<EncryptedEpub>("assets", encryptedId);
  const stored = await getRecord<{ ownerId: string; key: CryptoKey }>("assets", encryptionKeyId);
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
  // Return already-authorized content promptly; renew online without interrupting reading.
  if (
    typeof navigator !== "undefined" &&
    navigator.onLine &&
    shouldRenewOfflineEpub(Date.parse(record.expiresAt), Date.now())
  )
    void renewExpiringLicensedEpubs(userId);
  return plain;
}

/** Always obtains a new rights-checked grant and package; a renewal cannot extend an old receipt. */
export async function saveLicensedEpub(book: CatalogBook) {
  const ownerId = offlineAccountId();
  const registeredKey = deviceKey();
  if (!ownerId || !book.productId || !registeredKey)
    throw new Error("Sign in and register this device before saving a licensed edition.");
  const trustedKeyId = await cacheTrustedKey(ownerId);
  const license = await api<{
    url: string;
    receipt: SignedReceipt;
    expiresAt: string;
    assetVersionId: string;
  }>("/offline-epub/license", "POST", { productId: book.productId, deviceKey: registeredKey });
  if (trustedKeyId !== license.receipt.keyId)
    throw new Error("The offline signing key changed. Reconnect and retry the download.");
  const id = key(ownerId, String(book.id));
  const generation = crypto.randomUUID();
  const encryptedId = id + ":encrypted:" + generation;
  const encryptionKeyId = id + ":key:" + generation;
  let stored = false;
  try {
    const response = await fetch(license.url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("The licensed EPUB could not be retrieved.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 60_000_000)
      throw new Error("This edition exceeds offline storage limits.");
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
    const record: LicensedEpub = {
      id,
      kind: "licensed-epub",
      ownerId,
      title: book.title,
      book,
      receipt: license.receipt,
      expiresAt: license.expiresAt,
      assetVersionId: license.assetVersionId,
      assetIds: [encryptedId, encryptionKeyId],
      complete: true,
      updatedAt: new Date().toISOString(),
    };
    await putOwnedRecord("assets", { id: encryptionKeyId, ownerId, key: encryptionKey });
    await putOwnedRecord("assets", {
      id: encryptedId,
      ownerId,
      iv,
      ciphertext,
      digest: await sha256(bytes),
    });
    await validate(record, ownerId);
    const old = await getRecord<LicensedEpub>("downloads", id);
    await putOwnedRecord("downloads", record);
    stored = true;
    // Only remove an obsolete generation once the replacement is committed.
    for (const oldAssetId of old?.assetIds || [])
      if (!record.assetIds.includes(oldAssetId)) await deleteRecord("assets", oldAssetId);
    // Online re-authorization also refreshes the local clock fence.
    await putOwnedRecord("assets", {
      id: clockKey(ownerId, id),
      ownerId,
      lastValidatedAt: Date.now(),
    });
  } catch (error) {
    if (!stored) {
      await deleteRecord("assets", encryptedId);
      await deleteRecord("assets", encryptionKeyId);
    }
    throw error;
  }
}
export async function renewExpiringLicensedEpubs(userId: string) {
  if (
    !userId ||
    offlineAccountId() !== userId ||
    typeof navigator === "undefined" ||
    !navigator.onLine
  )
    return;
  const records = (await getRecords<LicensedEpub>("downloads")).filter(
    (r) => r.kind === "licensed-epub" && r.ownerId === userId && r.complete,
  );
  for (const record of records) {
    if (!shouldRenewOfflineEpub(Date.parse(record.expiresAt), Date.now())) continue;
    if (renewals.has(record.id)) continue;
    // Acquire the in-memory lock before the first asynchronous storage lookup.
    // Concurrent tab-triggered renewals in this JS context share one request.
    const promise = (async () => {
      const previous = await getRecord<{
        ownerId: string;
        lastAttemptAt: number;
        nextAttemptAt?: number;
      }>("assets", retryKey(userId, record.id));
      if (
        previous?.ownerId === userId &&
        Date.now() <
          (previous.nextAttemptAt || previous.lastAttemptAt + OFFLINE_EPUB_RENEWAL_RETRY_MS)
      )
        return;
      await putOwnedRecord("assets", {
        id: retryKey(userId, record.id),
        ownerId: userId,
        lastAttemptAt: Date.now(),
      });
      await saveLicensedEpub(record.book);
      const refreshed = await getRecord<LicensedEpub>("downloads", record.id);
      if (
        refreshed?.ownerId === userId &&
        Date.parse(refreshed.expiresAt) <= Date.parse(record.expiresAt)
      ) {
        // A loan ending inside seven days cannot be automatically extended.
        // Avoid burning a new publisher delivery grant on every hourly check.
        await putOwnedRecord("assets", {
          id: retryKey(userId, record.id),
          ownerId: userId,
          lastAttemptAt: Date.now(),
          nextAttemptAt: Date.now() + 12 * 60 * 60 * 1000,
        });
      }
    })();
    renewals.set(record.id, promise);
    try {
      await promise;
    } catch {
      // Keep the previous signed copy until it expires. A failed online
      // entitlement or rights check must never silently extend offline access.
    } finally {
      renewals.delete(record.id);
    }
  }
}
