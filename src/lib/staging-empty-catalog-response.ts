/**
 * A real-rights storefront must not report HTTP 200 when its required live
 * rights bootstrap was unavailable. The source must have emitted the explicit
 * cove_ssr_empty marker; filtered browsing intentionally renders without
 * this initial shelf and remains unaffected.
 *
 * Applies to protected staging and configured live/preview remote backends.
 * The synthetic local test site retains its existing development behavior.
 *
 * Classification is header-only. Never inspect or log book data, IP, tokens,
 * SQL or the error response body.
 */
export function liveHomeNeedsUnavailableStatus(
  request: Request,
  response: Response,
  requireVerifiedBootstrap: boolean,
): boolean {
  if (!requireVerifiedBootstrap || request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname !== "/" || url.search) return false;
  if (response.status !== 200) return false;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return false;
  return /(?:^|,)\s*cove_ssr_empty;dur=0(?:\s*,|$)/.test(
    response.headers.get("server-timing") || "",
  );
}

/**
 * Configured live and protected canary origins convert an unverified home to HTTP 503.
 * Do not lose the safe phase evidence needed to distinguish a D1 7429 overload
 * from transport, denial and deadline failures. Never copy arbitrary headers,
 * timing descriptions, exception text, SQL, identity or request attributes.
 */
export function sanitizedStagingCatalogFailureTiming(raw: string | null): string {
  const categoryNames = new Set([
    "cove_ssr_primary_d1_overload",
    "cove_ssr_primary_denied",
    "cove_ssr_primary_throttled",
    "cove_ssr_primary_limiter_unavailable",
    "cove_ssr_primary_upstream_error",
    "cove_ssr_primary_timeout",
    "cove_ssr_primary_transport_or_invalid",
    "cove_ssr_primary_invalid_bootstrap",
    "cove_ssr_read_limit",
    "cove_ssr_read_context",
    "cove_ssr_read_catalog",
    "cove_ssr_read_page",
    "cove_ssr_read_limiter_unavailable",
    "cove_ssr_read_throttled",
    "cove_ssr_read_service_overloaded",
    "cove_ssr_read_d1_resource_window",
    "cove_ssr_read_d1_queue_full",
    "cove_ssr_read_d1_queue_wait",
    "cove_ssr_read_transient_service",
    "cove_ssr_read_database",
    "cove_ssr_read_territory_mismatch",
    "cove_ssr_read_market_projection",
    "cove_ssr_read_unclassified",
    "cove_ssr_deadline",
    "cove_ssr_primary_pending",
    "cove_ssr_country_unasserted",
    "cove_ssr_alternate_not_started",
    "cove_ssr_alternate_pending",
    "cove_ssr_split_success",
  ]);
  const durationNames = new Set([
    "cove_ssr_bootstrap",
    "cove_ssr_primary_failure",
    "cove_ssr_split",
  ]);
  const evidence = ["cove_ssr_empty;dur=0"];
  const seen = new Set(["cove_ssr_empty"]);
  for (const part of (raw || "").split(",")) {
    const match = /^([a-z0-9_]+);dur=(\d+(?:\.\d{1,3})?)$/.exec(part.trim());
    if (!match || seen.has(match[1])) continue;
    const [_, name, rawDuration] = match;
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration > 12000) continue;
    if (categoryNames.has(name) && duration === 0) {
      seen.add(name);
      evidence.push(name + ";dur=0");
    } else if (durationNames.has(name)) {
      seen.add(name);
      evidence.push(name + ";dur=" + rawDuration);
    }
    if (evidence.length >= 16) break;
  }
  return evidence.join(", ");
}
