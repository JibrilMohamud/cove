/**
 * Catalog ingestion progress is operational presentation metadata, never
 * distribution permission, product availability, price, or a search result.
 * Production reads must not add a second primary-D1 round trip after a
 * rights-checked catalog has already been computed: an overloaded optional
 * status query previously converted a valid book shelf into a 503.
 *
 * Production operator health is exposed separately by /ingestion and
 * /service-status. Do not fabricate an "idle" or "healthy" state here.
 */
export type CatalogIngestionSummary = {
  status: string;
  page: number;
  lastSuccessAt: string | null;
  totalCatalogCount: number;
};
type IngestionDB = {
  prepare(query: string): {
    first<T>(): Promise<T | null>;
  };
};

const unavailable = (): CatalogIngestionSummary => ({
  status: "unknown",
  page: 0,
  lastSuccessAt: null,
  totalCatalogCount: 0,
});

export async function optionalCatalogIngestionSummary(
  db: IngestionDB,
  environment: string | undefined,
): Promise<CatalogIngestionSummary> {
  if (environment === "production") return unavailable();
  try {
    const state = await db
      .prepare("SELECT status,page,last_success_at,total_catalog_count FROM catalog_state WHERE id=1")
      .first<{
        status: string;
        page: number;
        last_success_at: string | null;
        total_catalog_count: number;
      }>();
    if (!state) return unavailable();
    return {
      status: state.status,
      page: state.page,
      lastSuccessAt: state.last_success_at,
      totalCatalogCount: state.total_catalog_count,
    };
  } catch {
    // No exception may turn a successfully rights-authorized shelf into 503.
    // The real error remains observable from the separate operations endpoint.
    return unavailable();
  }
}
