import type { AudioEdition } from "./domain";

export const OFFLINE_AUDIO_CONTEXT = "cove-offline-audio:v1\n";
export type OfflineAudioClaims = {
  version: 1;
  audience: "cove-offline-audio";
  keyId: string;
  licenseId: string;
  userId: string;
  productId: string;
  editionId: string;
  deviceId: string;
  deviceKeyHash: string;
  tokenHash: string;
  manifestHash: string;
  issuedAt: string;
  expiresAt: string;
};
export type OfflineAudioLicense = {
  licenseId: string;
  token: string;
  expiresAt: string;
  manifestHash: string;
  receipt: { payload: string; signature: string; keyId: string };
  verificationKey: JsonWebKey;
};
export function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192)
    throw new Error("Invalid offline receipt.");
  const text = atob(
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
export async function hashText(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function publicAudioKey(key: JsonWebKey): JsonWebKey {
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y)
    throw new Error("Invalid offline verification key.");
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y };
}
export const audioKeyId = (key: JsonWebKey) => hashText(JSON.stringify(publicAudioKey(key)));
export const audioManifestHash = (edition: Pick<AudioEdition, "tracks">) =>
  hashText(JSON.stringify(edition.tracks.map((track) => [track.id, track.sha256])));

/** Verify signature before trusting any permission, expiry, or metadata field. */
export async function verifyOfflineAudioLicense(
  license: OfflineAudioLicense,
  trustedKey: JsonWebKey,
  expected: { userId: string; deviceKey: string; edition: AudioEdition; nowMs?: number },
): Promise<OfflineAudioClaims> {
  const invalid = () =>
    new Error("This offline recording needs renewed access. Reconnect and save it again.");
  try {
    if (
      !expected.edition.tracks.length ||
      expected.edition.tracks.some((track) => !/^[a-f0-9]{64}$/.test(track.sha256 || ""))
    )
      throw invalid();
    if (!license.receipt || !license.token || !expected.userId || !expected.deviceKey)
      throw invalid();
    const keyId = await audioKeyId(trustedKey);
    if (license.receipt.keyId !== keyId) throw invalid();
    const key = await crypto.subtle.importKey(
      "jwk",
      publicAudioKey(trustedKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(license.receipt.signature),
      new TextEncoder().encode(OFFLINE_AUDIO_CONTEXT + license.receipt.payload),
    );
    if (!valid) throw invalid();
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(license.receipt.payload)),
    ) as OfflineAudioClaims;
    const nowMs = expected.nowMs ?? Date.now(),
      issued = Date.parse(claims.issuedAt),
      expires = Date.parse(claims.expiresAt);
    if (
      claims.version !== 1 ||
      claims.audience !== "cove-offline-audio" ||
      claims.keyId !== keyId ||
      claims.userId !== expected.userId ||
      claims.editionId !== expected.edition.id ||
      claims.productId !== expected.edition.productId ||
      claims.licenseId !== license.licenseId ||
      !claims.deviceId ||
      claims.deviceKeyHash !== (await hashText(expected.deviceKey)) ||
      claims.tokenHash !== (await hashText(license.token)) ||
      claims.manifestHash !== (await audioManifestHash(expected.edition)) ||
      claims.manifestHash !== license.manifestHash ||
      claims.expiresAt !== license.expiresAt ||
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      issued > nowMs + 60_000 ||
      expires <= nowMs ||
      expires <= issued ||
      expires - issued > 30 * 86400000
    )
      throw invalid();
    return claims;
  } catch {
    throw invalid();
  }
}
