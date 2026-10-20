import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";

export const DISCOVERY_CANDIDATE_LIMIT = 600;
/** One primary snapshot, one JSON bind, bounded ID seed; no cached legal decisions. */
export async function authorizeDiscoveryCandidates(
  db: CatalogDB,
  ids: string[],
  territory: string,
  anonymousSeriesGate = false,
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (
    unique.length > DISCOVERY_CANDIDATE_LIMIT ||
    unique.some((id) => typeof id !== "string" || !id || id.length > 180)
  )
    throw new ApiError(503, "Discovery candidate budget exceeded.");
  if (!/^[A-Z]{2}$/.test(territory)) throw new ApiError(400, "Invalid discovery territory.");
  if (!unique.length) return new Set();
  const database = db as CatalogDB & { withSession?: (constraint: "first-primary") => CatalogDB };
  // A new primary-anchored session per authorization, never a shared/bookmarked replica session.
  const primary = database.withSession ? database.withSession("first-primary") : db;
  const result = await primary
    .prepare(
      `WITH selected(product_id) AS MATERIALIZED (
      SELECT value FROM json_each(?)
    ) SELECT p.id FROM selected wanted
    CROSS JOIN products p ON p.id=wanted.product_id
    CROSS JOIN editions e ON e.id=p.edition_id
    WHERE p.storefront_status='active' AND p.source_name<>'upload'
      AND e.release_status IN ('available','preorder')
      AND EXISTS(SELECT 1 FROM retail_product_availability_rows rights
        WHERE rights.product_id=p.id AND rights.territory_code=?)
      ${
        anonymousSeriesGate
          ? `AND NOT EXISTS(SELECT 1 FROM series_memberships sm
        WHERE sm.edition_id=e.id AND sm.position>1 AND EXISTS(
          SELECT 1 FROM series_memberships previous
          WHERE previous.series_id=sm.series_id AND previous.position<sm.position))`
          : ""
      }`,
    )
    .bind(JSON.stringify(unique), territory)
    .all<{ id: string }>();
  return new Set(result.results.map((row) => row.id));
}

/** Fresh display flags; edition/index booleans are never sufficient channel permission. */
export async function contextualizeDiscoveryChannels<T extends { productId?: string }>(
  db: CatalogDB,
  books: T[],
  territory: string,
): Promise<T[]> {
  const ids = [...new Set(books.map((book) => book.productId).filter((id): id is string => !!id))];
  if (!ids.length) return books;
  if (ids.length > DISCOVERY_CANDIDATE_LIMIT)
    throw new ApiError(503, "Discovery channel budget exceeded.");
  const database = db as CatalogDB & { withSession?: (constraint: "first-primary") => CatalogDB };
  const primary = database.withSession ? database.withSession("first-primary") : db;
  const result = await primary
    .prepare(
      `WITH potential AS MATERIALIZED (
    SELECT 1 FROM rights_grants INDEXED BY idx_rights_secondary_channel_potential
    WHERE status='active' AND (sales_channel IN ('subscription','library')
      OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1))) LIMIT 1
  ) SELECT product_id,sales_channel FROM product_channel_availability
    WHERE EXISTS(SELECT 1 FROM potential) AND territory_code=?
    AND sales_channel IN ('subscription','library') AND product_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(territory, JSON.stringify(ids))
    .all<{ product_id: string; sales_channel: string }>();
  const allowed = new Set(result.results.map((row) => `${row.product_id}:${row.sales_channel}`));
  return books.map((book) => ({
    ...book,
    subscriptionEligible: allowed.has(`${book.productId}:subscription`),
    libraryEligible: allowed.has(`${book.productId}:library`),
  }));
}
