/**
 * Recheck the small, previously selected cached result page against the
 * CURRENT primary D1 territorial-rights view. Candidate IDs are untrusted;
 * they never grant availability, ownership, access, or cacheable rights.
 *
 * For ordinary non-FTS pages, start from these bound IDs. SQLite otherwise
 * chooses the global popularity index, reading the entire 55k+ catalog just
 * to revalidate a dozen cached IDs. CROSS JOIN fixes the small-seed scan
 * before the full legal-rights EXISTS in part.where.
 *
 * FTS pages keep their original FTS-matched query plan, ranking and binds.
 */
export type RightsRecheckCandidate = {
  prefix: string;
  from: string;
  where: string[];
  binds: unknown[];
  hasFts: boolean;
};

export function rightsScopedCachedPageQuery(
  part: RightsRecheckCandidate,
  ids: string[],
): { sql: string; binds: unknown[] } {
  if (!ids.length || ids.length > 100)
    throw new Error("Invalid bounded cached rights recheck page");
  const where = part.where.join(" AND ");
  if (part.hasFts) {
    return {
      sql: `${part.prefix} SELECT d.product_id FROM ${part.from} WHERE ${where} AND d.product_id IN (${ids.map(() => "?").join(",")})`,
      binds: [...part.binds, ...ids],
    };
  }
  return {
    sql: `WITH selected(product_id) AS MATERIALIZED (VALUES ${ids.map(() => "(?)").join(",")})
      SELECT d.product_id FROM selected wanted
      CROSS JOIN catalog_search_documents d ON d.product_id=wanted.product_id
      CROSS JOIN products p ON p.id=d.product_id
      CROSS JOIN editions e ON e.id=p.edition_id
      LEFT JOIN publishers pub ON pub.id=e.publisher_id
      WHERE ${where}`,
    binds: [...ids, ...part.binds],
  };
}
