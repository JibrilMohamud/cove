import { signFastCountryClaim, verifiedVercelClient } from "./fast-storefront-relay.server";

export type FastStorefrontVercelEnv = {
  VERCEL_ENV?: string;
  COVE_FAST_STOREFRONT_MODE?: string;
  COVE_FAST_STOREFRONT_RELEASE_CERTIFIED?: string;
  COVE_FAST_STOREFRONT_ORIGIN?: string;
  COVE_FAST_STOREFRONT_PERCENT?: string;
  COVE_FAST_RELAY_KEY?: string;
};

/**
 * Vercel Authentication may add its own preview deployment protection JWT
 * before the application sees a request. This cookie grants access to the
 * staging deployment, not to a Cove customer identity. It is never forwarded
 * to Cloudflare and is never permitted in the production canary. Any other
 * cookie (including a second cookie) keeps the established SSR/auth route.
 */
function anonymousWithOnlyPreviewProtection(request: Request, env: FastStorefrontVercelEnv) {
  const raw = request.headers.get("cookie");
  if (!raw) return true;
  if (env.VERCEL_ENV !== "preview" || env.COVE_FAST_STOREFRONT_MODE !== "preview") return false;
  const parts = raw.split(";").map((x) => x.trim());
  return (
    parts.length === 1 &&
    /^_vercel_jwt=[A-Za-z0-9._~-]{16,8192}$/.test(parts[0]) &&
    !request.headers.has("authorization")
  );
}

export function eligibleFastHomepage(request: Request, env: FastStorefrontVercelEnv): boolean {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/") return false;
  if (new URL(request.url).search) return false;
  if (
    !anonymousWithOnlyPreviewProtection(request, env) ||
    request.headers.has("authorization") ||
    request.headers.has("oai-authenticated-user-id") ||
    request.headers.has("x-fore-authenticated-user-id")
  )
    return false;
  if (env.COVE_FAST_STOREFRONT_RELEASE_CERTIFIED !== "1") return false;
  if (env.VERCEL_ENV === "preview" && env.COVE_FAST_STOREFRONT_MODE === "preview") return true;
  if (env.VERCEL_ENV !== "production" || env.COVE_FAST_STOREFRONT_MODE !== "canary") return false;
  const percent = Number(env.COVE_FAST_STOREFRONT_PERCENT);
  // Enforce release policy in code: automatic deployment can NEVER enlarge the
  // anonymous canary above 1%, even with a misconfigured production variable.
  if (!Number.isInteger(percent) || percent !== 1) return false;
  const client = verifiedVercelClient(request);
  if (!client) return false;
  // A stable bounded canary assigns at most 5/100 fingerprint buckets.
  // This is an operational eligibility check, never a legal-rights decision.
  const data = client.ip + "|" + client.country;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
  return (hash >>> 0) % 100 < percent;
}

// Preview-only, non-sensitive routing diagnostics. Never log the signing
// secret, geographic claim, IP address, auth headers, or URL query.
function reportPreviewRelay(
  env: FastStorefrontVercelEnv,
  reason: string,
  status?: number,
  diagnostic?: (reason: string) => void,
) {
  if (env.VERCEL_ENV !== "preview" || env.COVE_FAST_STOREFRONT_RELEASE_CERTIFIED !== "1") return;
  diagnostic?.(reason);
  console.info(
    JSON.stringify({ event: "cove_fast_preview_relay", reason, ...(status ? { status } : {}) }),
  );
}

export async function maybeProxyFastHomepage(
  request: Request,
  env: FastStorefrontVercelEnv,
  onPreviewDiagnostic?: (reason: string) => void,
): Promise<Response | null> {
  if (!eligibleFastHomepage(request, env)) {
    reportPreviewRelay(env, "ineligible", undefined, onPreviewDiagnostic);
    return null;
  }
  const client = verifiedVercelClient(request);
  if (!client) {
    reportPreviewRelay(env, "missing_verified_ingress", undefined, onPreviewDiagnostic);
    return null;
  }
  const secret = env.COVE_FAST_RELAY_KEY;
  const origin = env.COVE_FAST_STOREFRONT_ORIGIN;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret) || !origin) {
    reportPreviewRelay(env, "invalid_preview_configuration", undefined, onPreviewDiagnostic);
    return null;
  }
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    reportPreviewRelay(env, "invalid_preview_origin", undefined, onPreviewDiagnostic);
    return null;
  }
  // Never make a user-supplied URL into a privileged signed fetch target.
  if (
    target.protocol !== "https:" ||
    !target.hostname.startsWith("cove-fast-") ||
    !target.hostname.endsWith(".cove-jibrilmohamud.workers.dev") ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    reportPreviewRelay(env, "disallowed_preview_origin", undefined, onPreviewDiagnostic);
    return null;
  }
  const nonce = crypto.randomUUID().replace(/-/g, "");
  try {
    const headers = await signFastCountryClaim({ ...client, timestamp: Date.now(), nonce }, secret);
    const language = request.headers.get("accept-language");
    if (language && language.length <= 512) headers.set("accept-language", language);
    const response = await fetch(target.href, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(1800),
    });
    // Fail back to the unchanged SSR app if the new Worker is not healthy.
    if (
      !response.ok ||
      response.headers.get("x-cove-renderer") !== "strangler-live" ||
      !response.headers.get("content-type")?.includes("text/html")
    ) {
      reportPreviewRelay(env, "gateway_rejected", response.status, onPreviewDiagnostic);
      return null;
    }
    // Fetch transparently decodes compressed Worker bytes while leaving the
    // upstream Content-Encoding/Content-Length headers intact. Reusing those
    // headers with decoded bytes can produce a blank/broken browser document.
    // Bound and validate the anonymous HTML before forwarding success.
    const announced = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(announced) && announced > 512 * 1024) {
      reportPreviewRelay(env, "gateway_oversized", response.status, onPreviewDiagnostic);
      return null;
    }
    const html = await response.text();
    if (
      new TextEncoder().encode(html).length > 512 * 1024 ||
      !/^<!doctype html>/i.test(html.slice(0, 30)) ||
      !html.includes('id="thin-discovery-form"') ||
      !html.includes('data-rights-country="' + client.country + '"')
    ) {
      reportPreviewRelay(env, "gateway_invalid_html", response.status, onPreviewDiagnostic);
      return null;
    }
    reportPreviewRelay(env, "signed_gateway_success", response.status, onPreviewDiagnostic);
    const forwarded = new Headers(response.headers);
    forwarded.set("cache-control", "private, no-store");
    for (const name of [
      "set-cookie",
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "etag",
    ])
      forwarded.delete(name);
    return new Response(html, {
      status: response.status,
      headers: forwarded,
    });
  } catch {
    reportPreviewRelay(env, "gateway_transport_or_signing_error", undefined, onPreviewDiagnostic);
    return null;
  }
}
