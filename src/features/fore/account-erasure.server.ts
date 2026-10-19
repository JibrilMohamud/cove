import type { CoveEnv } from "./api.server";
import { ApiError } from "./service";
import { base64Url } from "./offline-audio-license";

export const ERASURE_SIGNATURE_CONTEXT = "cove-account-erasure:v1\n";
export async function eraseProviderIdentity(
  env: CoveEnv,
  providerId: string,
  userId: string,
  requestId: string,
) {
  if (!env.SUPABASE_URL) throw new ApiError(503, "identity_configuration_missing");
  const origin = new URL(env.SUPABASE_URL);
  if (origin.protocol !== "https:") throw new ApiError(503, "identity_configuration_invalid");
  if (env.FORE_INGESTION_SIGNING_KEY) {
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(env.FORE_INGESTION_SIGNING_KEY),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    // Bind both claims to one instant; two clock reads can create a proof
    // longer than the bridge's strict 120-second maximum.
    const issuedAt = Date.now();
    const payload = base64Url(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          audience: "cove-account-erasure",
          action: "erase",
          providerId,
          userId,
          requestId,
          issuedAt,
          expiresAt: issuedAt + 120000,
        }),
      ),
    );
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          new TextEncoder().encode(ERASURE_SIGNATURE_CONTEXT + payload),
        ),
      ),
    );
    const response = await fetch(new URL("/functions/v1/cove-account-erasure", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ApiError(503, "identity_erasure_unconfirmed");
    const result = (await response.json()) as { deleted?: boolean; providerId?: string };
    if (result.deleted !== true || result.providerId !== providerId)
      throw new ApiError(503, "identity_erasure_unconfirmed");
    return;
  }
  if (!env.SUPABASE_SECRET_KEY) throw new ApiError(503, "identity_configuration_missing");
  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
    ...(env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")
      ? {}
      : { Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` }),
  };
  const target = new URL(`/auth/v1/admin/users/${encodeURIComponent(providerId)}`, origin);
  const response = await fetch(target, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok && response.status !== 404)
    throw new ApiError(503, "identity_erasure_unconfirmed");
  const check = await fetch(target, { headers, signal: AbortSignal.timeout(10000) });
  const missing = (await check.json().catch(() => null)) as { code?: string } | null;
  if (check.status !== 404 || missing?.code !== "user_not_found")
    throw new ApiError(503, "identity_erasure_unconfirmed");
}
