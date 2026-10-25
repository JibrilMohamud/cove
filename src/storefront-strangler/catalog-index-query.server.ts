/* eslint-disable prettier/prettier -- Keep bounded FTS query and source trust checks adjacent. */
// Private, advisory candidate discovery. Must never be exposed as a legal or
// purchase decision. Serving code must independently recheck PRIMARY D1.
type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};
type DB = { prepare(sql: string): Statement };
export type CatalogQueryEnv = {
  CATALOG_INDEX_DB: DB;
  COVE_CATALOG_SEARCH_ENABLED?: string;
};
export function catalogSearchExpression(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 160) throw Error("invalid_catalog_query");
  const terms = raw.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  if (terms.length < 1 || terms.length > 8) throw Error("invalid_catalog_query");
  return terms.map((t) => '"' + t.slice(0, 48) + '"').join(" AND ");
}
export async function queryIsolatedCatalogIndex(
  env: CatalogQueryEnv,
  input: { query?: unknown; page?: unknown; limit?: unknown },
) {
  if (env.COVE_CATALOG_SEARCH_ENABLED !== "1")
    throw Error("catalog_search_disabled");
  const page = Number(input.page ?? 1), limit = Number(input.limit ?? 24);
  if (!Number.isInteger(page) || page < 1 || page > 10 ||
      !Number.isInteger(limit) || limit < 1 || limit > 64)
    throw Error("invalid_catalog_page");
  const expression = catalogSearchExpression(input.query);
  const identity = await env.CATALOG_INDEX_DB.prepare(
    "SELECT domain,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','entitlements','orders','payment_orders')) contaminated FROM catalog_index_identity WHERE id=1"
  ).first<{ domain: string; contaminated: number }>();
  if (identity?.domain !== "cove-independent-catalog-index" || identity.contaminated)
    throw Error("catalog_search_domain_not_isolated");
  const results = await env.CATALOG_INDEX_DB.prepare(
    `SELECT catalog_index_fts.product_id FROM catalog_index_fts
    JOIN catalog_index_documents d ON d.rowid=catalog_index_fts.rowid
    WHERE catalog_index_fts MATCH ? AND d.visible=1
    ORDER BY bm25(catalog_index_fts),catalog_index_fts.rowid LIMIT ? OFFSET ?`,
  ).bind(expression, limit + 1, (page - 1) * limit)
    .all<{ product_id: string }>();
  const ids = results.results.slice(0, limit).map((r) => r.product_id);
  if (ids.some((x) => !/^prd_gutenberg_[a-z0-9_]{1,120}$/.test(x)) ||
      new Set(ids).size !== ids.length) throw Error("catalog_search_invalid_index");
  return {
    schema: "cove.catalog.candidates.v1",
    ids,
    hasMore: results.results.length > limit,
    // This is deliberately NOT a count of rights-eligible books.
    // Consumers cannot surface it as legal availability.
    authoritative: false,
  };
}
