/**
 * Causal experiment only: isolate *informational* HTTP request analytics
 * from the primary synthetic D1. Every request still emits the structured
 * Worker log via recordHttpRequest; no errors, auth, rights, security,
 * purchases or production request rows are altered.
 *
 * Do not promote this flag to production: operations dashboards use the D1
 * tables and would otherwise lose successful anonymous GET samples. Before a
 * production migration, install an independent retained analytics sink and
 * update those dashboards, alerting and retention controls.
 */
export type SyntheticTelemetryEnv = {
  COVE_SSR_STAGING?: string;
  COVE_PERF_DATABASE_ID?: string;
  COVE_PERF_TELEMETRY_MODE?: string;
};

const isolatedFixture = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const publicReadRoutes = new Set([
  "/api/fore/catalog",
  "/api/fore/recommendations/home",
  "/api/fore/merchandising",
]);

export function shouldUseConsoleOnlyHttpTelemetry(
  env: SyntheticTelemetryEnv,
  request: Request,
  status: number,
  isAuthenticated: boolean,
): boolean {
  if (
    env.COVE_SSR_STAGING !== "1" ||
    env.COVE_PERF_DATABASE_ID !== isolatedFixture ||
    env.COVE_PERF_TELEMETRY_MODE !== "console-only"
  )
    return false;
  if (isAuthenticated || request.method !== "GET" || status !== 200) return false;
  if (!publicReadRoutes.has(new URL(request.url).pathname)) return false;
  // Any existing or potential identity/session hint retains durable audit
  // telemetry, even if the auth adapter did not recognize that cookie.
  for (const header of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ]) {
    if (request.headers.has(header)) return false;
  }
  return true;
}
