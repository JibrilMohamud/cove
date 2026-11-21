/**
 * Error reporting must NEVER mask the fail-closed customer response.
 *
 * This schedules existing non-authoritative telemetry on the Worker request
 * lifetime when available; no write or authorization call is skipped because
 * it failed. The original API failure still returns its normal error status.
 * Without waitUntil (e.g. some SSR tests), settle all failures without throw.
 *
 * No request data or exception objects are logged here.
 */
export type ErrorTelemetryJob = () => Promise<unknown> | unknown;
export type ErrorTelemetryLifetime = {
  waitUntil?: (work: Promise<unknown>) => void;
};

export function settleErrorTelemetry(
  jobs: readonly ErrorTelemetryJob[],
  lifetime?: ErrorTelemetryLifetime,
): Promise<void> | void {
  // Defer every callback so a synchronous throw is captured as a rejection.
  // All jobs run independently: an unavailable D1 error journal must never
  // prevent an external alert from being attempted (or vice versa).
  const work: Promise<void> = Promise.allSettled(
    jobs.map((job) => Promise.resolve().then(job)),
  ).then(() => undefined);

  if (lifetime?.waitUntil) {
    try {
      lifetime.waitUntil(work);
      return;
    } catch {
      // A broken execution context is not allowed to create a second 5xx.
      // Fallback waits for the settled work rather than dropping it silently.
    }
  }
  return work;
}
