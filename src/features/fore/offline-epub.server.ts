import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import { issueCommercialEpubGrant } from "./delivery.server";
import { audioKeyId, base64Url, hashText, publicAudioKey } from "./offline-audio-license";
import {
  OFFLINE_EPUB_CONTEXT,
  OFFLINE_EPUB_MAX_MS,
  type OfflineEpubClaims,
} from "./offline-epub-crypto";

export async function offlineEpubVerificationKey(env: CoveEnv) {
  const secret = env.FORE_OFFLINE_AUDIO_SIGNING_JWK;
  if (!secret) throw new ApiError(503, "Protected offline licensing is not configured.");
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(secret);
  } catch {
    throw new ApiError(503, "Protected offline signing key is malformed.");
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = publicAudioKey(privateJwk);
    if (!privateJwk.d) throw Error("No private signing component.");
    await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new ApiError(503, "Protected offline signing key is invalid.");
  }
  return { publicKey, keyId: await audioKeyId(publicKey) };
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
  // The seven-day product limit is a ceiling, not an extension of the
  // underlying entitlement. Bind this lookup to the grant just issued for
  // this exact buyer/product; a caller-provided expiry is never trusted.
  const entitlement = await env.DB.prepare(
    "SELECT e.status,e.starts_at,e.ends_at FROM commercial_delivery_grants g JOIN entitlements e ON e.id=g.entitlement_id AND e.user_id=g.user_id AND e.product_id=g.product_id WHERE g.id=? AND g.user_id=? AND g.product_id=? AND g.status='active'",
  )
    .bind(grant.grantId, userId, productId)
    .first<{ status: string; starts_at: string | null; ends_at: string | null }>();
  const startsAt = entitlement?.starts_at == null ? null : Date.parse(entitlement.starts_at);
  const endsAt = entitlement?.ends_at == null ? null : Date.parse(entitlement.ends_at);
  if (
    !entitlement ||
    entitlement.status !== "active" ||
    (startsAt !== null && (!Number.isFinite(startsAt) || startsAt > issuedAt.getTime())) ||
    (endsAt !== null && (!Number.isFinite(endsAt) || endsAt <= issuedAt.getTime()))
  )
    throw new ApiError(403, "This entitlement cannot issue a new offline license.");
  const claims: OfflineEpubClaims = {
    version: 1,
    audience: "cove-offline-epub",
    userId,
    productId,
    deviceKeyHash: await hashText(deviceKey),
    assetVersionId: grant.assetVersionId,
    licenseId: grant.grantId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(
      Math.min(issuedAt.getTime() + OFFLINE_EPUB_MAX_MS, endsAt ?? Infinity),
    ).toISOString(),
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
    receipt: { payload, signature, keyId: claims.keyId },
    expiresAt: claims.expiresAt,
    assetVersionId: claims.assetVersionId,
  };
}
