/* eslint-disable prettier/prettier -- Security-sensitive fixed vocabulary beside strict browser telemetry. */
/**
 * Browser navigation failures used to discard the exact protected-SSR
 * Server-Timing categories. Preserve only an enumerated failure class, never
 * raw error text, headers, SQL, book data or the staging bearer credential.
 * This is observational: every non-200 remains a HARD browser-gate failure.
 */
const known503 = [
  ["cove_ssr_read_d1_resource_window", "d1-resource-window"],
  ["cove_ssr_read_d1_queue_full", "d1-queue-full"],
  ["cove_ssr_read_d1_queue_wait", "d1-queue-wait"],
  ["cove_ssr_primary_d1_overload", "primary-d1-overload"],
  ["cove_ssr_read_limiter_unavailable", "read-limiter-unavailable"],
  ["cove_ssr_read_throttled", "read-throttled"],
  ["cove_ssr_read_service_overloaded", "service-overloaded"],
  ["cove_ssr_read_transient_service", "transient-service"],
  ["cove_ssr_read_database", "database"],
  ["cove_ssr_read_territory_mismatch", "territory-mismatch"],
  ["cove_ssr_read_market_projection", "market-projection"],
  ["cove_ssr_primary_timeout", "primary-timeout"],
  ["cove_ssr_primary_denied", "primary-denied"],
  ["cove_ssr_primary_throttled", "primary-throttled"],
  ["cove_ssr_primary_limiter_unavailable", "primary-limiter-unavailable"],
  ["cove_ssr_primary_upstream_error", "primary-upstream-error"],
  ["cove_ssr_primary_transport_or_invalid", "primary-transport-or-invalid"],
  ["cove_ssr_primary_invalid_bootstrap", "invalid-bootstrap"],
  ["cove_ssr_read_limit", "rate-limit"],
  ["cove_ssr_read_context", "context-read"],
  ["cove_ssr_read_catalog", "catalog-read"],
  ["cove_ssr_read_page", "page-read"],
  ["cove_ssr_read_unclassified", "read-unclassified"],
  ["cove_ssr_deadline", "deadline"],
  ["cove_ssr_primary_pending", "primary-pending"],
  ["cove_ssr_country_unasserted", "country-unasserted"],
  ["cove_ssr_alternate_pending", "alternate-pending"],
  ["cove_ssr_alternate_not_started", "alternate-not-started"],
  ["cove_ssr_empty", "empty-unverified-catalog"],
];
/** Ordered by the most actionable root cause: generic empty is last. */
export function classifyProtectedSsrNavigation(status, serverTiming) {
  if (status === 200) return null;
  if (status === null) return "no-navigation-response";
  if (status === 401 || status === 403) return "authorization-denied";
  if (status === 429) return "rate-limited";
  if (status !== 503) return status >= 500 ? "other-server-error" : "unexpected-http-status";
  const observed = new Set();
  for (const piece of typeof serverTiming === "string" ? serverTiming.split(",") : []) {
    const match = /^([a-z0-9_]+);dur=0(?:\.0+)?$/.exec(piece.trim());
    if (match) observed.add(match[1]);
  }
  for (const [timing, category] of known503) if (observed.has(timing)) return category;
  return "unclassified-503";
}
