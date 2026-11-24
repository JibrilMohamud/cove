/**
 * D1-unbound, QA-only HTTP gateway. It exposes no SQL, schedule, arbitrary
 * remote URL, operator secret or environment protocol. The private owner
 * independently checks the original backend credential and customer auth.
 */
type GatewayEnv = {
  COVE_CONSOLIDATED_GATEWAY_QA?: string;
  FORE_ENVIRONMENT?: string;
  COVE_SSR_STAGING?: string;
  FORE_BACKEND_TOKEN_SHA256?: string;
  BUSINESS_OWNER?: { fetch(request: Request): Promise<Response> };
};

const fail = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    if (
      env.COVE_CONSOLIDATED_GATEWAY_QA !== "1" ||
      env.FORE_ENVIRONMENT !== "staging" ||
      env.COVE_SSR_STAGING !== "1" ||
      !/^[a-f0-9]{64}$/.test(env.FORE_BACKEND_TOKEN_SHA256 || "") ||
      !env.BUSINESS_OWNER?.fetch ||
      Object.values(env).some(
        (value) =>
          value &&
          typeof value === "object" &&
          typeof (value as { prepare?: unknown }).prepare === "function",
      )
    )
      return fail(503);
    const supplied = request.headers.get("x-cove-backend-token") || "";
    if (supplied.length < 24 || supplied.length > 4096) return fail(401);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    let difference = 0;
    const expected = env.FORE_BACKEND_TOKEN_SHA256!;
    for (let i = 0; i < hash.length; i++) difference |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
    if (difference !== 0) return fail(401);
    // One hop; never retry uncertain mutations or replay a request body.
    try {
      return await env.BUSINESS_OWNER.fetch(request);
    } catch {
      return fail(503);
    }
  },
};
