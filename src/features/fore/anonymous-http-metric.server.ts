/** Anonymous aggregate request performance is not a transactional event.
 * Never use this for recommendations attribution, orders, rights decisions,
 * error/security logs, identity requests or content grants.
 */
export type IsolatedMetricsEnv = {
  COVE_SSR_STAGING?: string;
  COVE_OPS_TELEMETRY_MODE?: string;
  OPS_ANALYTICS?: {
    writeDataPoint(point: { blobs: string[]; doubles: number[]; indexes: string[] }): void;
  };
};

const PUBLIC_READ_PATHS = new Set([
  "/api/fore/catalog",
  "/api/fore/storefront/bootstrap",
  "/api/fore/storefront/context",
  "/api/fore/storefront/page",
  "/api/fore/taxonomy",
  "/api/fore/search/suggest",
]);

/** True means a best-effort, non-PII metric was handled by independent
 * analytics; it MUST NOT cause a synchronous write to primary D1.
 * The sink is opt-in, stage-only, with no PII, query, IP or product IDs.
 */
export function emitIsolatedAnonymousHttpMetric(
  env: IsolatedMetricsEnv,
  request: Request,
  response: Response,
  actorKind: string,
  durationMs: number,
): boolean {
  if (
    env.COVE_SSR_STAGING !== "1" ||
    env.COVE_OPS_TELEMETRY_MODE !== "analytics-engine" ||
    typeof env.OPS_ANALYTICS?.writeDataPoint !== "function" ||
    request.method !== "GET" ||
    actorKind !== "anonymous" ||
    response.status < 200 ||
    response.status >= 300 ||
    request.headers.has("cookie") ||
    request.headers.has("authorization") ||
    request.headers.has("oai-authenticated-user-id") ||
    request.headers.has("x-fore-authenticated-user-id")
  )
    return false;
  const path = new URL(request.url).pathname;
  if (!PUBLIC_READ_PATHS.has(path)) return false;
  try {
    env.OPS_ANALYTICS.writeDataPoint({
      blobs: ["public-api-read", path, "GET"],
      doubles: [response.status, Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0],
      indexes: ["public-read"],
    });
  } catch {
    // A best-effort performance aggregate failing must not redirect traffic
    // to primary D1, accidentally amplifying an analytics outage. This
    // warning is kept in ordinary Worker logs; errors stay on the D1 path.
    console.warn("Isolated anonymous performance aggregate unavailable");
  }
  return true;
}
