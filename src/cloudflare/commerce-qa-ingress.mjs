// A separate, assets-less entrypoint for isolated customer/Stripe TEST QA.
// The SSR Worker it calls MUST keep workers_dev=false, preview_urls=false,
// no custom domains and no direct public routes. Production is unaffected.
const denied = (status, reason) =>
  new Response(reason, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const authenticatedWrites = new Set([
  "/api/fore/auth/login",
  "/api/fore/cart/item",
  "/api/fore/checkout/quote",
  "/api/fore/checkout/payment",
  "/api/fore/delivery/epub/grant",
  "/api/fore/admin/commerce/refund",
]);
const webhookPath = "/api/fore/stripe/webhook";
const keyFormat = /^[a-f0-9]{64}$/;
async function matchesSecret(header, secret) {
  if (!keyFormat.test(secret || "")) return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header || "");
  if (!match) return false;
  const text = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", text.encode(secret)),
    crypto.subtle.digest("SHA-256", text.encode(match[1])),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== env.COVE_QA_GATEWAY_HOST ||
      env.COVE_QA_GATEWAY_HOST !== "cove-commerce-qa-ingress.cove-jibrilmohamud.workers.dev"
    )
      return denied(404, "Not found");
    const key = env.COVE_SSR_STAGING_GATE_KEY;
    if (!keyFormat.test(key || "")) return denied(503, "QA gateway unavailable");
    if (!env.COMMERCE_QA || typeof env.COMMERCE_QA.fetch !== "function")
      return denied(503, "Private QA service unavailable");
    const method = request.method;
    const isWebhook = method === "POST" && url.pathname === webhookPath;
    const jsonType =
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
      "application/json";
    const signature = request.headers.get("stripe-signature") || "";
    const declared = request.headers.get("content-length");
    if (
      isWebhook &&
      env.COVE_QA_SIGNED_WEBHOOK_GATE_ENABLED === "1" &&
      jsonType &&
      signature.includes("t=") &&
      signature.includes("v1=")
    ) {
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1_048_576))
        return denied(413, "QA webhook too large");
      // The private backend MUST cryptographically verify Stripe-Signature
      // with the *corresponding TEST endpoint's* whsec before any database
      // claim or settlement. This ingress must never fake a bearer or HMAC.
    } else {
      if (!(await matchesSecret(request.headers.get("authorization"), key)))
        return denied(401, "Unauthorized");
      if (method !== "GET" && method !== "HEAD" && !authenticatedWrites.has(url.pathname))
        return denied(405, "Read-only QA route");
      if (isWebhook) return denied(405, "Webhooks require provider signature");
    }
    try {
      // Service binding, not an internet fetch; never enable an unsafe
      // workers.dev route on the underlying assets-bound application.
      const upstream = await env.COMMERCE_QA.fetch(request);
      const headers = new Headers(upstream.headers);
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = headers.get("location") || "";
        let redirect;
        try {
          redirect = new URL(location, url);
        } catch {
          return denied(502, "Unreviewed redirect denied");
        }
        if (
          redirect.protocol !== "https:" ||
          redirect.hostname !== url.hostname ||
          redirect.port !== ""
        )
          return denied(502, "Cross-origin QA redirect denied");
      }
      return new Response(method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return denied(503, "Private QA service unavailable");
    }
  },
};
