/**
 * Explicit opt-in for retiring the persistence gateway's canonical-D1
 * credential lookup. The expected digest must come from an independent
 * Cloudflare secret, never from a user header or D1 runtime-config row.
 *
 * A malformed opt-in or missing secret denies the request. It MUST NOT
 * return to the old DB fallback or accept a plaintext backend credential.
 */
export type IndependentBackendCredentialEnv = {
  COVE_BACKEND_TOKEN_HASH_ONLY?: string;
  FORE_BACKEND_TOKEN_SHA256?: string;
  FORE_BACKEND_TOKEN?: string;
};

function equalDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export async function verifyIndependentBackendCredential(
  request: Request,
  env: IndependentBackendCredentialEnv,
): Promise<boolean> {
  if (
    env.COVE_BACKEND_TOKEN_HASH_ONLY !== "1" ||
    Boolean(env.FORE_BACKEND_TOKEN) ||
    !/^[a-f0-9]{64}$/.test(env.FORE_BACKEND_TOKEN_SHA256 || "")
  )
    return false;

  const token = request.headers.get("x-cove-backend-token") || "";
  if (token.length < 32 || token.length > 512) return false;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const observed = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return equalDigest(env.FORE_BACKEND_TOKEN_SHA256!, observed);
}
