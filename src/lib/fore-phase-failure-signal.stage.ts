/**
 * Research-only failure-stage marker, NOT imported into the audited API.
 * Requires fresh canonical writer review before use in real requests.
 * Never captures SQL, cookies, identity, error messages or stack traces.
 */
export type PublicApiTimedStage = "context" | "catalog" | "markets" | "limit" | "page";

export async function markFailedTimedPhase<T>(
  name: PublicApiTimedStage,
  task: Promise<T>,
  timings: Record<string, number>,
): Promise<T> {
  try {
    return await task;
  } catch (error) {
    timings["fault_" + name] = 1;
    throw error;
  }
}
