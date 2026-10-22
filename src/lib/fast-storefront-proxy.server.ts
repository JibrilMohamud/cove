import { signFastCountryClaim, verifiedVercelClient } from "./fast-storefront-relay.server";

export type FastStorefrontVercelEnv = {
  VERCEL_ENV?: string;
  COVE_FAST_STOREFRONT_MODE?: string;
  COVE_FAST_STOREFRONT_RELEASE_CERTIFIED?: string;
  COVE_FAST_STOREFRONT_ORIGIN?: string;
  COVE_FAST_STOREFRONT_PERCENT?: string;
  COVE_FAST_RELAY_KEY?: string;
};

export function eligibleFastHomepage(request: Request, env: FastStorefrontVercelEnv): boolean {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/") return false;
  if (new URL(request.url).search) return false;
  if (
    request.headers.has("cookie") ||
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

export async function maybeProxyFastHomepage(
  request: Request,
  env: FastStorefrontVercelEnv,
): Promise<Response | null> {
  if (!eligibleFastHomepage(request, env)) return null;
  const client = verifiedVercelClient(request);
  if (!client) return null;
  const secret = env.COVE_FAST_RELAY_KEY;
  const origin = env.COVE_FAST_STOREFRONT_ORIGIN;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret) || !origin) return null;
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
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
  )
    return null;
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
    )
      return null;
    const forwarded = new Headers(response.headers);
    forwarded.set("cache-control", "private, no-store");
    forwarded.delete("set-cookie");
    return new Response(response.body, {
      status: response.status,
      headers: forwarded,
    });
  } catch {
    return null;
  }
}
