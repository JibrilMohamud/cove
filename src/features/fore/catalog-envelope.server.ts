import type { SearchResult } from "./search.server";

/**
 * Unmodified, canonical `/api/fore/catalog` envelope.
 *
 * This is deliberately a formatter of an AUTHORITATIVE completed search.
 * It never manufactures counts, facets, pagination or ingestion metadata
 * from an R2 list, a sparse 25th witness or an R2 expiry timestamp.
 *
 * Anonymous first-paint may provide countPending/facetsPending only when
 * the trusted search result itself includes those states.
 */
export type CanonicalCatalogEnvelope = {
  results: SearchResult["books"];
  count: number;
  next: string | null;
  cached: true;
  facets: SearchResult["facets"];
  facetsPending: boolean;
  countPending: boolean;
  search: {
    queryId: SearchResult["queryId"];
    backend: SearchResult["backend"];
    processingTimeMs: number;
    correctedQuery: string | null;
    pageSize: number;
  };
  ingestion: unknown;
};

export function canonicalCatalogEnvelope(
  url: URL,
  page: number,
  result: SearchResult,
  ingestion: unknown,
): CanonicalCatalogEnvelope {
  // Input page and result.limit are already validated by parseSearchInput,
  // but never let a direct caller fabricate an overflowing page cursor.
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(result.limit) || result.limit < 1)
    throw new Error("Invalid canonical catalog page");
  if (!Number.isSafeInteger(result.count) || result.count < 0)
    throw new Error("Invalid canonical catalog count");
  const next =
    page * result.limit < result.count
      ? "/api/fore/catalog?" +
        (() => {
          const nextParams = new URLSearchParams(url.searchParams);
          nextParams.set("page", String(page + 1));
          return nextParams.toString();
        })()
      : null;
  return {
    results: result.books,
    count: result.count,
    next,
    cached: true,
    facets: result.facets,
    facetsPending: result.facetsPending === true,
    // A countPending lower bound is not an independently verified exact count.
    countPending: result.countPending === true,
    search: {
      queryId: result.queryId,
      backend: result.backend,
      processingTimeMs: result.processingTimeMs,
      correctedQuery: result.correctedQuery || null,
      pageSize: result.limit,
    },
    ingestion,
  };
}
