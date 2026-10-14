import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import { issueCommercialEpubGrant } from "./delivery.server";
import { audioKeyId, base64Url, hashText, publicAudioKey } from "./offline-audio-license";

import { OFFLINE_EPUB_CONTEXT, OFFLINE_EPUB_LICENSE_MS } from "./offline-epub-policy";
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
function signingMaterial(env: CoveEnv) {
  if (!env.FORE_OFFLINE_AUDIO_SIGNING_JWK)
    throw new ApiError(503, "Protected offline licensing is not configured.");
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(env.FORE_OFFLINE_AUDIO_SIGNING_JWK) as JsonWebKey;
  } catch {
    throw new ApiError(503, "Protected offline licensing is unavailable.");
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = publicAudioKey(privateJwk);
  } catch {
    throw new ApiError(503, "Offline verification key is invalid.");
  }
  return { privateJwk, publicKey };
}
export async function offlineEpubVerificationKey(env: CoveEnv) {
  const { publicKey } = signingMaterial(env);
  return { key: publicKey, keyId: await audioKeyId(publicKey) };
}
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
  const { privateJwk, publicKey } = signingMaterial(env);
  const device = await env.DB.prepare(
    "SELECT id FROM devices WHERE user_id=? AND device_key=? AND revoked_at IS NULL",
  )
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
  const drm = await env.DB.prepare(
    "SELECT da.drm_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id WHERE av.id=? LIMIT 1",
  )
    .bind(grant.assetVersionId)
    .first<{ drm_status: string }>();
  const supported = new Set(["none", "drm-free", "watermark", "social-drm"]);
  if (!drm || !supported.has(String(drm.drm_status || "").toLowerCase()))
    throw new ApiError(
      403,
      "This edition requires external DRM that Cove's in-app offline reader does not support.",
    );
  const issuedAt = new Date();
  // The offline term must not outlive a time-limited entitlement.
  const entitlement = await env.DB.prepare(
    "SELECT e.ends_at FROM commercial_delivery_grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.id=? AND g.user_id=? LIMIT 1",
  )
    .bind(grant.grantId, userId)
    .first<{ ends_at: string | null }>();
  if (!entitlement) throw new ApiError(403, "The offline entitlement could not be verified.");
  const entitlementEnd = entitlement.ends_at ? Date.parse(entitlement.ends_at) : Infinity;
  if (entitlement.ends_at && !Number.isFinite(entitlementEnd))
    throw new ApiError(403, "The offline entitlement has an invalid expiry.");
  const expiry = Math.min(issuedAt.getTime() + OFFLINE_EPUB_LICENSE_MS, entitlementEnd);
  if (expiry <= issuedAt.getTime()) throw new ApiError(403, "The offline entitlement has expired.");
  const claims: OfflineEpubClaims = {
    version: 1,
    audience: "cove-offline-epub",
    userId,
    productId,
    deviceKeyHash: await hashText(deviceKey),
    assetVersionId: grant.assetVersionId,
    licenseId: grant.grantId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(expiry).toISOString(),
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
