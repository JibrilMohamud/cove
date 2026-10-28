// An assets-less Worker is the only public entry to protected SSR staging.
// Cloudflare Static Assets on the upstream Worker can be served without
// invoking its script; this gateway MUST NOT declare any [assets] binding.
// Keep it independent from production storefront and commerce credentials.
const denied = (status, message) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });

async function validBearer(header, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || "")) return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header || "");
  if (!match) return false;
  const encoder = new TextEncoder();
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
  ]);
  const left = new Uint8Array(expected);
  const right = new Uint8Array(supplied);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const gatewayStartedAt = performance.now();
    const hostname = new URL(request.url).hostname;
    if (
      !env.COVE_STAGING_INGRESS_HOST ||
      (hostname !== env.COVE_STAGING_INGRESS_HOST && hostname !== env.COVE_STAGING_CANARY_HOST)
    )
      return denied(404, "Not found");
    if (!/^[a-f0-9]{64}$/.test(env.COVE_SSR_STAGING_GATE_KEY || ""))
      return denied(503, "Staging credentials unavailable");
    if (!(await validBearer(request.headers.get("authorization"), env.COVE_SSR_STAGING_GATE_KEY)))
      return denied(401, "Unauthorized");
    if (request.method !== "GET" && request.method !== "HEAD")
      return denied(405, "Read-only staging");
    if (!env.STAGING || typeof env.STAGING.fetch !== "function")
      return denied(503, "Staging service unavailable");
    try {
      // No network fetch to an arbitrary URL, no stale or anonymous fallback.
      // This service binding can reach the protected native SSR/asset Worker,
      // but ONLY after the gateway validates the exact ephemeral bearer.
      const upstream = await env.STAGING.fetch(request);
      const headers = new Headers(upstream.headers);
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      // Diagnostic only. The underlying SSR cove_total excludes this gate,
      // so the measured Cloudflare/network residual can now be separated
      // from authentication, service-binding and downstream execution.
      headers.append(
        "server-timing",
        "cove_gateway;dur=" + Math.max(0, performance.now() - gatewayStartedAt).toFixed(1),
      );
      // Never forward a public redirect (e.g. auth/asset link) without a
      // security review of its exact destination and credential behavior.
      if (upstream.status >= 300 && upstream.status < 400)
        return denied(502, "Staging redirect denied");
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return denied(503, "Staging unavailable");
    }
  },
};
