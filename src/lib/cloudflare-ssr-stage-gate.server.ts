type StagingEnvironment = {
  COVE_SSR_STAGING?: string;
  COVE_SSR_STAGING_GATE_KEY?: string;
  COVE_SSR_STAGING_COMMERCE_QA?: string;
  COVE_STRIPE_SIGNED_WEBHOOK_QA_ENABLED?: string;
};

/**
 * Fail closed for every request to the temporary workers.dev staging site.
 * The 256-bit bearer token exists only as a Worker secret and as an ephemeral
 * variable in the GitHub Actions runner. No credential, query-string shortcut,
 * cookie, or public bypass is accepted.
 */
export async function rejectUnauthenticatedStagingRequest(
  request: Request,
  env: StagingEnvironment,
): Promise<Response | null> {
  if (env.COVE_SSR_STAGING !== "1") return null;
  const headers = {
    "cache-control": "no-store, max-age=0",
    "content-type": "text/plain; charset=utf-8",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
  const secret = env.COVE_SSR_STAGING_GATE_KEY;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret))
    return new Response("Staging credentials unavailable", { status: 503, headers });
  // Stripe does not send our ephemeral staging bearer. This deliberately
  // narrow, opt-in QA webhook ingress is authenticated by the original
  // stripeWebhook() HMAC verifier, which must reject any forged signature
  // BEFORE touching the isolated canonical database. This is never active
  // on production or the ordinary read-only staging Workers.
  const uri = new URL(request.url);
  const stripeQaWebhook =
    env.COVE_SSR_STAGING_COMMERCE_QA === "1" &&
    env.COVE_STRIPE_SIGNED_WEBHOOK_QA_ENABLED === "1" &&
    uri.hostname === "cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev" &&
    uri.pathname === "/api/fore/stripe/webhook" &&
    request.method === "POST" &&
    request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json" &&
    Boolean(request.headers.get("stripe-signature"));
  if (stripeQaWebhook) return null;
  const supplied = request.headers.get("authorization") || "";
  const match = /^Bearer ([a-f0-9]{64})$/.exec(supplied);
  if (!match) return new Response("Unauthorized", { status: 401, headers });
  const data = new TextEncoder();
  const [known, received] = await Promise.all([
    crypto.subtle.digest("SHA-256", data.encode(secret)),
    crypto.subtle.digest("SHA-256", data.encode(match[1])),
  ]);
  let difference = 0;
  const a = new Uint8Array(known);
  const b = new Uint8Array(received);
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference !== 0) return new Response("Unauthorized", { status: 401, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    // The real checkout/reader QA uses its *own* D1, R2, TEST Stripe, and
    // exact workers.dev hostname. Never grant writes to the read-only
    // real-catalog, capacity, capture or production Workers.
    const uri = new URL(request.url);
    const allowedQaWrite =
      env.COVE_SSR_STAGING_COMMERCE_QA === "1" &&
      uri.hostname === "cove-commerce-customer-qa-stage.cove-jibrilmohamud.workers.dev" &&
      request.method === "POST" &&
      new Set([
        "/api/fore/auth/login",
        "/api/fore/cart/item",
        "/api/fore/checkout/quote",
        "/api/fore/checkout/payment",
        "/api/fore/delivery/epub/grant",
        "/api/fore/account/device/register",
        "/api/fore/account/device/revoke",
        "/api/fore/offline-epub/license",
        "/api/fore/stripe/webhook",
        "/api/fore/admin/commerce/refund",
      ]).has(uri.pathname);
    if (!allowedQaWrite) return new Response("Read-only staging", { status: 405, headers });
  }
  return null;
}

export function stageNoStore(response: Response, stage: boolean): Response {
  if (!stage) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Every browser asset is routed through the staging auth gate first. */
export function isStagingStaticAsset(pathname: string): boolean {
  return (
    /^\/(?:_build|assets|icons|fonts|images)\//.test(pathname) ||
    /^\/(?:favicon\.ico|manifest\.webmanifest|robots\.txt|site\.webmanifest)$/.test(pathname)
  );
}
