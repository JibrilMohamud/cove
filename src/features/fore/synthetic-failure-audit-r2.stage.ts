/**
 * Staging-only A/B diagnostic: measure how much a failed anonymous catalog
 * request's *nonauthorizing HTTP metrics* contribute to D1 overload.
 *
 * Production cannot activate this path: only the synthetic D1 identity and
 * a dedicated, private stage R2 bucket are accepted. Production and protected
 * error/legal/commerce/security auditing retain their original D1 behavior.
 *
 * This minimal synthetic evidence is NOT the full production HTTP audit schema.
 * Never promote this without independently reviewed durable audit retention.
 */
export type SyntheticFailureAuditEnv = {
  COVE_SYNTHETIC_FAILURE_AUDIT_R2?: string;
  COVE_SYNTHETIC_FAILURE_AUDIT_D1_ID?: string;
  COVE_SYNTHETIC_FAILURE_AUDIT_BUCKET?: string;
  SYNTHETIC_FAILURE_AUDIT_R2?: {
    put(
      key: string,
      value: string,
      options?: { httpMetadata?: { contentType: string } },
    ): Promise<unknown>;
  };
};

const SYNTHETIC_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const SYNTHETIC_BUCKET = "cove-synthetic-http-audit-stage-20261114";

/** Isolate ONLY a 503, cookie-free, unauthorized-header-free synthetic catalog GET. */
export function syntheticFailureAuditEligible(
  env: SyntheticFailureAuditEnv,
  request: Request,
  response: Response,
  actorKind: string,
): boolean {
  return (
    env.COVE_SYNTHETIC_FAILURE_AUDIT_R2 === "1" &&
    env.COVE_SYNTHETIC_FAILURE_AUDIT_D1_ID === SYNTHETIC_DB &&
    env.COVE_SYNTHETIC_FAILURE_AUDIT_BUCKET === SYNTHETIC_BUCKET &&
    typeof env.SYNTHETIC_FAILURE_AUDIT_R2?.put === "function" &&
    request.method === "GET" &&
    new URL(request.url).pathname === "/api/fore/catalog" &&
    response.status === 503 &&
    actorKind === "anonymous" &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    !request.headers.has("oai-authenticated-user-id") &&
    !request.headers.has("x-fore-authenticated-user-id")
  );
}

/**
 * Returns true ONLY after the independent private R2 store acknowledges the
 * synthetic record. On failure the caller MUST keep the legacy D1 audit path.
 */
export async function persistSyntheticFailureAudit(
  env: SyntheticFailureAuditEnv,
  request: Request,
  response: Response,
  actorKind: string,
  durationMs: number,
): Promise<boolean> {
  if (!syntheticFailureAuditEligible(env, request, response, actorKind)) return false;
  const at = new Date().toISOString();
  const record = {
    schema: "cove.synthetic-anonymous-catalog-failure.v1",
    kind: "synthetic-stage-only",
    route: "/api/fore/catalog",
    method: "GET",
    status: 503,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    at,
  };
  const key = `synthetic-catalog-failures/${at.slice(0, 10)}/${crypto.randomUUID()}.json`;
  try {
    await env.SYNTHETIC_FAILURE_AUDIT_R2!.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });
    return true;
  } catch {
    // D1 fallback is intentional: a broken R2 sink can never erase evidence.
    console.warn("Synthetic independent 503 audit unavailable; retaining primary D1 audit.");
    return false;
  }
}
