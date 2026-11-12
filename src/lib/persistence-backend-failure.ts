export type BackendFailureSource = "worker-api" | "worker-early" | "edge-or-runtime";

/** Only known backend-issued evidence is trusted for low-cardinality logs.
 * This classifier cannot authorize a fallback or expose response contents.
 */
export function backendFailureSource(headers: Headers): BackendFailureSource {
  const provenance = headers.get("x-cove-persistence");
  const cacheState = headers.get("x-cove-backend-cache");
  if (provenance !== "d1-r2" || !["HIT", "MISS", "BYPASS"].includes(cacheState || ""))
    return "edge-or-runtime";
  const phases = headers.get("server-timing") || "";
  return /(?:^|,)\s*cove_api;dur=\d+(?:\.\d+)?(?:,|$)/.test(phases) ? "worker-api" : "worker-early";
}

/** Only numeric phase presence is inspected. Never log the raw Server-Timing
 * header: it can include extensions that are not approved for public logs.
 */
export function backendFailurePhase(headers: Headers): "post-context" | "pre-context" | "untraced" {
  if (backendFailureSource(headers) !== "worker-api") return "untraced";
  const timing = headers.get("server-timing") || "";
  if (/(?:^|,)\s*cove_context;dur=\d+(?:\.\d+)?(?:,|$)/.test(timing)) return "post-context";
  if (/(?:^|,)\s*cove_auth;dur=\d+(?:\.\d+)?(?:,|$)/.test(timing)) return "pre-context";
  return "untraced";
}

export type BackendFailureCategory =
  | "catalog-rights"
  | "market-configuration"
  | "locale-configuration"
  | "rate-limit"
  | "handler-exception"
  | "other";

/** Classification is read-only, never returned to the browser and cannot
 * authorize a fallback. Whitelisted exact messages only; no raw error,
 * request URLs, identity, cookies, response headers or secrets reach logs.
 */
export async function backendFailureCategory(response: Response): Promise<BackendFailureCategory> {
  if (
    response.status < 500 ||
    backendFailureSource(response.headers) !== "worker-api" ||
    !response.headers.get("content-type")?.includes("application/json") ||
    Number(response.headers.get("content-length") || 0) > 1024
  )
    return "other";
  try {
    const value: unknown = await response.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return "other";
    const message = (value as { error?: unknown }).error;
    if (
      message === "The catalog is temporarily unavailable while Cove verifies distribution rights."
    )
      return "catalog-rights";
    if (message === "No active Cove storefront market is configured.")
      return "market-configuration";
    if (message === "This storefront has no active locale configured.")
      return "locale-configuration";
    if (
      message === "Unable to verify anonymous request for rate limiting." ||
      message === "Native storefront read limiter is unavailable." ||
      message === "Please wait a minute before trying again."
    )
      return "rate-limit";
    if (message === "This content could not be loaded. Please try again.")
      return "handler-exception";
  } catch {
    // Even a malformed or unreadable error response cannot modify deny behavior.
  }
  return "other";
}
