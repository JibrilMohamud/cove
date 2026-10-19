import type { CatalogDB } from "./catalog-model.server";

export type WindowCandidate = { where: string; binds: unknown[]; currency?: string };
export const CANDIDATE_WINDOW_SIZE = 1000;

/**
 * Presentation aggregation only: yield between bounded primary-D1 reads so a
 * full-catalog statistic cannot monopolize the single-threaded rights primary.
 * Each window still applies the original current legal predicate. These
 * numerical statistics already have a ten-minute display cache; the live
 * result IDs, prices, reader and checkout never use this multi-read snapshot.
 */
export async function readCandidateWindows<T>(
  db: CatalogDB,
  candidate: WindowCandidate,
  columns: string,
  projection: string,
  consume: (row: T) => void,
  stopped?: () => boolean,
): Promise<void> {
  if (candidate.currency) {
    const present = await db
      .prepare(
        "SELECT 1 ok FROM catalog_search_documents INDEXED BY idx_search_price WHERE currency=? LIMIT 1",
      )
      .bind(candidate.currency)
      .first();
    if (!present) return;
  }
  let cursor: string | null = null;
  for (;;) {
    if (stopped?.()) throw new Error("Catalog statistic group cancelled after a failed read");
    const scanWhere: string = cursor === null ? "" : "WHERE product_id>?";
    const row: (T & { scan_count: number; next_id: string | null }) | null = await db
      .prepare(
        `WITH scanned AS MATERIALIZED (
      SELECT product_id FROM catalog_search_documents ${scanWhere}
      ORDER BY product_id LIMIT ?
    ), candidate AS MATERIALIZED (
      SELECT ${columns} FROM scanned scan
      CROSS JOIN catalog_search_documents d ON d.product_id=scan.product_id
      CROSS JOIN products p ON p.id=d.product_id
      CROSS JOIN editions e ON e.id=p.edition_id
      LEFT JOIN publishers pub ON pub.id=e.publisher_id
      WHERE ${candidate.where}
    ) SELECT (SELECT COUNT(*) FROM scanned) scan_count,
      (SELECT MAX(product_id) FROM scanned) next_id, ${projection}`,
      )
      .bind(...(cursor === null ? [] : [cursor]), CANDIDATE_WINDOW_SIZE, ...candidate.binds)
      .first<T & { scan_count: number; next_id: string | null }>();
    if (
      !row ||
      !Number.isSafeInteger(row.scan_count) ||
      row.scan_count < 0 ||
      row.scan_count > CANDIDATE_WINDOW_SIZE
    )
      throw new Error("Incomplete catalog statistic window");
    if (row.scan_count > 0) {
      if (typeof row.next_id !== "string" || row.next_id === cursor)
        throw new Error("Catalog statistic cursor did not advance");
      consume(row);
    }
    if (row.scan_count < CANDIDATE_WINDOW_SIZE) return;
    cursor = row.next_id;
  }
}

export async function windowedCandidateCount(db: CatalogDB, candidate: WindowCandidate) {
  let count = 0;
  await readCandidateWindows<{ population_count: number }>(
    db,
    candidate,
    "d.product_id",
    "(SELECT COUNT(*) FROM candidate) population_count",
    (row) => {
      if (!Number.isSafeInteger(row.population_count) || row.population_count < 0)
        throw new Error("Invalid catalog statistic count");
      count += row.population_count;
    },
  );
  return count;
}
