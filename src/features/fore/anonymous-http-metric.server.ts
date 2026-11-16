/** Anonymous aggregate request telemetry is not a transactional event.
 * Never use this for recommendations, orders, rights decisions, detailed
 * error/security logs, identity requests or content grants. A public 5xx
 * emits a fixed category counter ONLY; D1 security/error auditing remains.
 */
export type IsolatedMetricsEnv = {
  COVE_SSR_STAGING?: string;
  FORE_ENVIRONMENT?: string;
  COVE_PUBLIC_ANON_HTTP_TELEMETRY?: string;
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
/**
 * Attribution is deliberately coarse. These three names are owned by the
 * Worker, not derived from requests or exception text. Only finite numeric
 * measurements from known stages may leave the request in Analytics Engine.
 * "unattributed" means no one stage explains at least half the elapsed time;
 * it is NOT a guess that SQL, Cloudflare transport or an external API failed.
 */
const ANONYMOUS_PHASES = ["auth", "context", "identity"] as const;
const SLOW_MS = 800;

function recordAnonymousAnomalyPhase(
  sink: NonNullable<IsolatedMetricsEnv["OPS_ANALYTICS"]>,
  path: string,
  status: number,
  durationMs: number,
  stages: Readonly<Record<string, number>> | undefined,
) {
  if (!stages || (status < 500 && !(status >= 200 && status < 300 && durationMs >= SLOW_MS)))
    return;
  const elapsed = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  let top: (typeof ANONYMOUS_PHASES)[number] | "unattributed" = "unattributed";
  let largest = 0;
  for (const phase of ANONYMOUS_PHASES) {
    const value = stages[phase];
    if (Number.isFinite(value) && value > largest && value >= 0) {
      largest = Math.min(value, 300_000);
      top = phase;
    }
  }
  if (largest < elapsed / 2) top = "unattributed";
  try {
    sink.writeDataPoint({
      blobs: ["public-api-anomaly-phase", path, top],
      doubles: [status, elapsed, largest],
      indexes: ["public-anomaly"],
    });
  } catch {
    // Never substitute a metric for the original primary-D1 audit, and never
    // let an independent analytics failure change a customer response.
  }
}

/** True means a best-effort, non-PII metric was handled by independent
 * analytics; it MUST NOT cause a synchronous write to primary D1.
 * The sink is opt-in for isolated staging or the exact canonical production
 * backend, with no PII, query, IP or product IDs. A missing/failed sink does
 * not redirect eligible performance aggregates back into the D1 hot path.
 */
export function emitIsolatedAnonymousHttpMetric(
  env: IsolatedMetricsEnv,
  request: Request,
  response: Response,
  actorKind: string,
  durationMs: number,
  stages?: Readonly<Record<string, number>>,
): boolean {
  // Production must opt in independently from staging. Identity-bearing,
  // commercial, detailed failure and rights audit events are never sent; a
  // 5xx only emits a nonidentifying fixed-category metric and is audited
  // through the existing D1 path.
  const allowedEnvironment =
    env.COVE_SSR_STAGING === "1" ||
    (env.FORE_ENVIRONMENT === "production" && env.COVE_PUBLIC_ANON_HTTP_TELEMETRY === "1");
  if (
    !allowedEnvironment ||
    env.COVE_OPS_TELEMETRY_MODE !== "analytics-engine" ||
    typeof env.OPS_ANALYTICS?.writeDataPoint !== "function" ||
    request.method !== "GET" ||
    actorKind !== "anonymous" ||
    request.headers.has("cookie") ||
    request.headers.has("authorization") ||
    request.headers.has("oai-authenticated-user-id") ||
    request.headers.has("x-fore-authenticated-user-id")
  )
    return false;
  const path = new URL(request.url).pathname;
  if (!PUBLIC_READ_PATHS.has(path)) return false;
  // Separate failure COUNT observability from legal/security auditing.
  // Only a fixed route, status and duration enter Analytics Engine. This
  // branch MUST return false so the existing durable D1 error/security
  // audit path is neither bypassed nor silently reclassified as success.
  if (response.status >= 500 && response.status <= 599) {
    try {
      env.OPS_ANALYTICS.writeDataPoint({
        blobs: ["public-api-failure", path, "5xx"],
        doubles: [response.status, Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0],
        indexes: ["public-failure"],
      });
    } catch {
      // The observability sink cannot create an extra D1 write or alter the
      // original 5xx response. The pre-existing durable audit still runs.
    }
    recordAnonymousAnomalyPhase(env.OPS_ANALYTICS, path, response.status, durationMs, stages);
    return false;
  }
  if (response.status < 200 || response.status >= 300) return false;
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
  recordAnonymousAnomalyPhase(env.OPS_ANALYTICS, path, response.status, durationMs, stages);
  return true;
}
