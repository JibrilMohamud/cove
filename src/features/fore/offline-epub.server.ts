import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import { issueCommercialEpubGrant } from "./delivery.server";
import { audioKeyId, base64Url, hashText, publicAudioKey } from "./offline-audio-license";

export const OFFLINE_EPUB_CONTEXT = "cove-offline-epub:v1\n";
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
export async function issueOfflineEpubLicense(
  env: CoveEnv,
  userId: string,
  raw: unknown,
  request: Request,
) {
  if (!raw || typeof raw !== "object") throw new ApiError(400, "Invalid offline request.");
  const input = raw as { productId?: unknown; deviceKey?: unknown };
  const productId = String(input.productId || "");
  const deviceKey = String(input.deviceKey || "");
  if (!/^[a-zA-Z0-9_-]{4,120}$/.test(productId) || !/^[a-zA-Z0-9-]{16,128}$/.test(deviceKey))
    throw new ApiError(400, "Register this device to save licensed books.");
  const configured = env.FORE_OFFLINE_AUDIO_SIGNING_JWK;
  if (!configured) throw new ApiError(503, "Protected offline licensing is not configured.");
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(configured);
  } catch {
    throw new ApiError(503, "Protected offline licensing is unavailable.");
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = publicAudioKey(privateJwk);
  } catch {
    throw new ApiError(503, "Offline verification key is invalid.");
  }
  const device = await env.DB
    .prepare("SELECT id FROM devices WHERE user_id=? AND device_key=? AND revoked_at IS NULL")
    .bind(userId, deviceKey)
    .first<{ id: string }>();
  if (!device)
    throw new ApiError(428, "Register this device in account settings before saving offline.");
  // Grant issuance performs the full acquisition, distribution, territory,
  // contract-offline permission, version and buyer-risk checks.
  const grant = await issueCommercialEpubGrant(
    env,
    userId,
    { productId, purpose: "offline_package", deviceId: device.id },
    request,
  );
  const issuedAt = new Date();
  const claims: OfflineEpubClaims = {
    version: 1,
    audience: "cove-offline-epub",
    userId,
    productId,
    deviceKeyHash: await hashText(deviceKey),
    assetVersionId: grant.assetVersionId,
    licenseId: grant.grantId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 48 * 3600000).toISOString(),
    keyId: await audioKeyId(publicKey),
  };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(OFFLINE_EPUB_CONTEXT + payload),
      ),
    ),
  );
  return {
    url: grant.url,
    publicKey,
    receipt: { payload, signature, keyId: claims.keyId },
    expiresAt: claims.expiresAt,
    assetVersionId: claims.assetVersionId,
  };
}
