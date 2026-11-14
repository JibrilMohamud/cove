import type { CatalogDB } from "./catalog-model.server";
import type { RightsRecheckCandidate } from "./rights-scoped-cache-page";

const MAX_RANKED_CANDIDATES = 96;

/**
 * A FAST PATH for an anonymous, unfiltered, page-one popularity sort ONLY.
 *
 * Top-N is determined by the exact live ranking key, without any right,
 * entitlement, grant, offer, pricing or product-status assertion. Every
 * proposed product ID is then rechecked in ONE query against the ORIGINAL
 * caller-supplied primary-D1 retail eligibility predicates.
 *
 * If at least "limit" IDs pass (up to 25 for a 24-book page plus a
 * proven next-page witness), they are provably the same first page as
 * the full catalog scan: no ID after the first N can outrank one of them.
 * Otherwise return null and let the untouched full authoritative SQL run.
 * Never cache a shortlist as an authorization decision.
 */
export async function firstPagePopularRightsShortlist(
  db: CatalogDB,
  scope: RightsRecheckCandidate,
  limit: number,
): Promise<string[] | null> {
  if (scope.hasFts || scope.prefix || !Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    return null;
  // Materialize the same top-96 ranking seed inside the CURRENT primary
  // statement. This removes an entire D1 service round trip and the 96 ID
  // bindings while keeping selection and rights in one read snapshot.
  const eligible = await db
    .prepare(
      `WITH ranked AS MATERIALIZED (
        SELECT d.product_id,d.fore_bestseller_score sort_score,d.external_book_id sort_source
        FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
        ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
        LIMIT ${MAX_RANKED_CANDIDATES}
      )
      SELECT d.product_id FROM ranked wanted
      CROSS JOIN catalog_search_documents d ON d.product_id=wanted.product_id
      CROSS JOIN products p ON p.id=d.product_id
      CROSS JOIN editions e ON e.id=p.edition_id
      LEFT JOIN publishers pub ON pub.id=e.publisher_id
      WHERE ${scope.where.join(" AND ")}
      ORDER BY wanted.sort_score DESC,wanted.sort_source ASC,wanted.product_id ASC
      LIMIT ?`,
    )
    .bind(...scope.binds, limit)
    .all<{ product_id: string }>();
  const ids = eligible.results.map((row) => row.product_id);
  if (
    ids.length !== limit ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    return null;

  return ids;
}
