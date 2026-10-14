import { audioKeyId, decodeBase64Url, hashText, publicAudioKey } from "./offline-audio-license";

export const OFFLINE_EPUB_CONTEXT = "cove-offline-epub:v1\n";
export const OFFLINE_EPUB_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_EPUB_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export type OfflineEpubClaims = {
  version: 1;
  audience: "cove-offline-epub";
  userId: string;
  productId: string;
  deviceKeyHash: string;
  assetVersionId: string;
  licenseId: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
};
export type SignedOfflineEpubReceipt = { payload: string; signature: string; keyId: string };
export function parseOfflineEpubClaims(receipt: SignedOfflineEpubReceipt) {
  const raw = new TextDecoder().decode(decodeBase64Url(receipt.payload));
  return JSON.parse(raw) as OfflineEpubClaims;
}
export async function verifyOfflineEpubReceipt(
  receipt: SignedOfflineEpubReceipt,
  trustedKey: JsonWebKey,
  expected: {
    userId: string;
    productId: string;
    assetVersionId: string;
    deviceKey: string;
    expiresAt: string;
    nowMs?: number;
    previousValidatedAt?: number;
  },
): Promise<OfflineEpubClaims> {
  const invalid = () =>
    new Error("Offline license is invalid or expired. Reconnect to renew access.");
  try {
    if (!expected.userId || !expected.productId || !expected.deviceKey || !receipt) throw invalid();
    const keyId = await audioKeyId(trustedKey);
    if (receipt.keyId !== keyId) throw invalid();
    const key = await crypto.subtle.importKey(
      "jwk",
      publicAudioKey(trustedKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(receipt.signature),
      new TextEncoder().encode(OFFLINE_EPUB_CONTEXT + receipt.payload),
    );
    if (!signatureValid) throw invalid();
    const claims = parseOfflineEpubClaims(receipt);
    const issued = D...[truncated]