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
  /** Ephemeral, stage-only 256-bit access gate, not an application user. */
  COVE_SSR_STAGING_GATE_KEY?: string;
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
  // The protected synthetic CORE receives the staging bearer header even
  // though it is not an application identity. Permit ONLY the exact verified
  // stage gate token, never a user bearer or service credential.
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const gate = env.COVE_SSR_STAGING_GATE_KEY;
    if (!gate || !/^[a-f0-9]{64}$/.test(gate) || authorization !== `Bearer ${gate}`) return false;
  }
  // Any other potential identity/session hint retains durable telemetry.
  for (const header of [
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ]) {
    if (request.headers.has(header)) return false;
  }
  return true;
}
