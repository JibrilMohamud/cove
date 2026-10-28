import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import {
  audioKeyId,
  base64Url,
  OFFLINE_AUDIO_CONTEXT,
  publicAudioKey,
  type OfflineAudioClaims,
} from "./offline-audio-license";
import { hashText } from "./offline-audio-license";
import { now } from "./service";
import { requireStagePaidEntitlementAccess } from "../../storefront-strangler/legal-consumer-fence.server";

export async function verifyStoredAudioLicense(
  env: CoveEnv,
  userId: string,
  productId: string,
  licenseId: string,
  token: string,
  manifestHash: string,
  territory: string,
) {
  if (!userId) throw new ApiError(401, "Sign in to verify offline audio access.");
  const current = await env.DB.prepare(
    "SELECT l.id,l.expires_at,l.manifest_hash,l.entitlement_id FROM audio_offline_licenses l JOIN devices d ON d.id=l.device_id AND d.user_id=l.user_id JOIN entitlements e ON e.id=l.entitlement_id AND e.user_id=l.user_id AND e.product_id=l.product_id WHERE l.id=? AND l.user_id=? AND l.product_id=? AND l.token_hash=? AND l.status='active' AND l.expires_at>? AND d.revoked_at IS NULL AND e.entitlement_type='purchase' AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?)",
  )
    .bind(licenseId, userId, productId, await hashText(token), now(), now(), now())
    .first<{ id: string; expires_at: string; manifest_hash: string; entitlement_id: string }>();
  if (!current || current.manifest_hash !== manifestHash)
    throw new ApiError(
      403,
      "This offline license is no longer active. Save the recording again if access is available.",
    );
  await requireStagePaidEntitlementAccess(env, {
    entitlementId: current.entitlement_id,
    userId,
    productId,
    territory,
    channel: "retail",
  });
  return { valid: true, expiresAt: current.expires_at };
}

/** Use a dedicated key when provisioned; existing P-256 deployment signing key bootstraps this purpose. */
export async function signOfflineAudioLicense(
  env: CoveEnv,
  input: Omit<OfflineAudioClaims, "keyId" | "version" | "audience">,
) {
  const raw = env.FORE_OFFLINE_AUDIO_SIGNING_JWK || env.FORE_INGESTION_SIGNING_KEY;
  if (!raw) throw new ApiError(503, "Offline audio signing is not configured.");
  let privateKey: JsonWebKey;
  try {
    privateKey = JSON.parse(raw);
  } catch {
    throw new ApiError(503, "Offline audio signing is unavailable.");
  }
  const verificationKey = publicAudioKey(privateKey),
    keyId = await audioKeyId(verificationKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const claims: OfflineAudioClaims = {
    ...input,
    keyId,
    version: 1,
    audience: "cove-offline-audio",
  };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new TextEncoder().encode(OFFLINE_AUDIO_CONTEXT + payload),
      ),
    ),
  );
  return { receipt: { payload, signature, keyId }, verificationKey };
}
