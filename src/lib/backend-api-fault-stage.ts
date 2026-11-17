/**
 * Non-authorizing, privacy-safe failure attribution for persistence API paths.
 * Only a fixed numeric Server-Timing flag is recorded, never exception text,
 * SQL, credentials, identities, URLs, or request/response bodies.
 */
export type BackendApiFaultStage = "auth_handle" | "identity" | "catalog" | "taxonomy";

export async function markBackendFaultStage<T>(
  stage: BackendApiFaultStage,
  action: () => Promise<T> | T,
  timings: Record<string, number>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    timings["fault_" + stage] = 1;
    throw error;
  }
}
