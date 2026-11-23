import { rejectUnauthenticatedStagingRequest } from "../../src/lib/cloudflare-ssr-stage-gate.server";

type Env = {
  COVE_SSR_STAGING: string;
  COVE_SSR_STAGING_GATE_KEY: string;
  FORE_BACKEND_TOKEN: string;
  CANDIDATE: { fetch(request: Request): Promise<Response> };
};

// Disposable authenticated ingress for the isolated presentation candidate.
// No production service, D1, media, owner, secret or DNS binding is permitted.
export default {
  async fetch(request: Request, env: Env) {
    if (env.COVE_SSR_STAGING !== "1")
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    const denied = await rejectUnauthenticatedStagingRequest(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
    if (request.method !== "GET") return new Response(null, { status: 405, headers });
    if (
      !new Set(["/api/fore/catalog", "/api/fore/storefront/bootstrap", "/__cove/health"]).has(
        url.pathname,
      )
    )
      return new Response(null, { status: 404, headers });
    if (request.headers.has("cookie")) return new Response(null, { status: 403, headers });
    if (!/^[a-f0-9]{64}$/.test(env.FORE_BACKEND_TOKEN || ""))
      return new Response(null, { status: 503, headers });
    // Accept no forwarded identity, geography, public origin or backend token.
    // Use only provider-authenticated network metadata after the staging gate.
    const country = String((request as Request & { cf?: { country?: string } }).cf?.country || "");
    const ip = request.headers.get("cf-connecting-ip");
    if (!/^[A-Z]{2}$/.test(country) || !ip) return new Response(null, { status: 503, headers });
    const upstream = new Headers({
      accept: "application/json",
      "x-cove-backend-token": env.FORE_BACKEND_TOKEN,
      "x-cove-client-country": country,
      "x-cove-client-ip": ip,
      "cf-connecting-ip": ip,
    });
    const language = request.headers.get("accept-language");
    if (language) upstream.set("accept-language", language);
    const response = await env.CANDIDATE.fetch(new Request(url, { headers: upstream }));
    const resultHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) resultHeaders.set(name, value);
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  },
};
