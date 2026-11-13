import type { CatalogDB } from "./catalog-model.server";
import {
  rightsScopedCachedPageQuery,
  type RightsRecheckCandidate,
} from "./rights-scoped-cache-page";

const MAX_RANKED_CANDIDATES = 96;

/**
 * A FAST PATH for an anonymous, unfiltered, page-one popularity sort ONLY.
 *
 * Top-N is determined by the exact live ranking key, without any right,
 * entitlement, grant, offer, pricing or product-status assertion. Every
 * proposed product ID is then rechecked in ONE query against the ORIGINAL
 * caller-supplied primary-D1 retail eligibility predicates.
 *
 * If at least "limit" IDs pass, they are provably the same first page as
 * the full catalog scan: no ID after the first N can outrank one of them.
 * Otherwise return null and let the untouched full authoritative SQL run.
 * Never cache a shortlist as an authorization decision.
 */
export async function firstPagePopularRightsShortlist(
  db: CatalogDB,
  scope: RightsRecheckCandidate,
  limit: number,
): Promise<string[] | null> {
  if (scope.hasFts || !Number.isSafeInteger(limit) || limit < 1 || limit > 24) return null;
  const ranked = await db
    .prepare(
      `SELECT d.product_id FROM catalog_search_documents d
       INDEXED BY idx_search_popular_stable
       ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
       LIMIT 96`,
    )
    .all<{ product_id: string }>();
  const ids = ranked.results.map((row) => row.product_id);
  if (
    !ids.length ||
    ids.length > MAX_RANKED_CANDIDATES ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    return null;

  // These are EXACTLY the same canonical product-status, storefront scope,
  // currency, language and current retail-rights SQL filters as runIds().
  // The recheck helper forces a bounded selected-ID seed so SQLite cannot
  // accidentally run a 50k-row popularity scan while verifying 96 IDs.
  const check = rightsScopedCachedPageQuery(scope, ids);
  const eligible = await db
    .prepare(check.sql)
    .bind(...check.binds)
    .all<{ product_id: string }>();
  const allowed = new Set(eligible.results.map((row) => row.product_id));
  const verified = ids.filter((id) => allowed.has(id));
  return verified.length >= limit ? verified.slice(0, limit) : null;
}
