import {
  canonicalBookRowsStatement,
  canonicalRowBook,
  type CatalogDB,
} from "./catalog-model.server";
import type { CatalogBook } from "./client";
import { ApiError } from "./service";

export const DISCOVERY_CANDIDATE_LIMIT = 600;
/** One primary snapshot, one JSON bind, bounded ID seed; no cached legal decisions. */
function boundedIds(ids: string[], territory: string) {
  const unique = [...new Set(ids)];
  if (
    unique.length > DISCOVERY_CANDIDATE_LIMIT ||
    unique.some((id) => typeof id !== "string" || !id || id.length > 180)
  )
    throw new ApiError(503, "Discovery candidate budget exceeded.");
  if (!/^[A-Z]{2}$/.test(territory)) throw new ApiError(400, "Invalid discovery territory.");
  return unique;
}
function freshPrimary(db: CatalogDB) {
  const database = db as CatalogDB & { withSession?: (constraint: "first-primary") => CatalogDB };
  // A new primary-anchored session per authorization, never a shared/bookmarked replica session.
  return database.withSession ? database.withSession("first-primary") : db;
}
function authorizationStatement(
  db: CatalogDB,
  unique: string[],
  territory: string,
  anonymousSeriesGate: boolean,
) {
  return db
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
    .bind(JSON.stringify(unique), territory);
}
export async function authorizeDiscoveryCandidates(
  db: CatalogDB,
  ids: string[],
  territory: string,
  anonymousSeriesGate = false,
): Promise<Set<string>> {
  const unique = boundedIds(ids, territory);
  if (!unique.length) return new Set();
  const result = await authorizationStatement(
    freshPrimary(db),
    unique,
    territory,
    anonymousSeriesGate,
  ).all<{ id: string }>();
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
  const result = await channelStatement(freshPrimary(db), ids, territory).all<{
    product_id: string;
    sales_channel: string;
  }>();
  return applyChannels(books, result.results);
}
function channelStatement(db: CatalogDB, ids: string[], territory: string) {
  return db
    .prepare(
      `WITH potential AS MATERIALIZED (
    SELECT 1 FROM rights_grants INDEXED BY idx_rights_secondary_channel_potential
    WHERE status='active' AND (sales_channel IN ('subscription','library')
      OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1))) LIMIT 1
  ) SELECT product_id,sales_channel FROM product_channel_availability
    WHERE EXISTS(SELECT 1 FROM potential) AND territory_code=?
    AND sales_channel IN ('subscription','library') AND product_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(territory, JSON.stringify(ids));
}
function applyChannels<T extends { productId?: string }>(
  books: T[],
  rows: { product_id: string; sales_channel: string }[],
): T[] {
  const allowed = new Set(rows.map((row) => `${row.product_id}:${row.sales_channel}`));
  return books.map((book) => ({
    ...book,
    subscriptionEligible: allowed.has(`${book.productId}:subscription`),
    libraryEligible: allowed.has(`${book.productId}:library`),
  }));
}

/** A single primary RPC/transaction for the final display, using the exact existing legal,
 * canonical-book and channel queries. No cached authority and no partial batch response.
 */
export async function authorizeDiscoveryDisplay(
  db: CatalogDB,
  ids: string[],
  territory: string,
  anonymousSeriesGate = false,
): Promise<Map<string, CatalogBook>> {
  const unique = boundedIds(ids, territory);
  if (unique.length > 200) throw new ApiError(503, "Discovery display budget exceeded.");
  if (!unique.length) return new Map();
  const primary = freshPrimary(db);
  const [eligibility, canonical, channels] = (await primary.batch([
    authorizationStatement(primary, unique, territory, anonymousSeriesGate),
    canonicalBookRowsStatement(primary, unique),
    channelStatement(primary, unique, territory),
  ])) as [
    { results: { id: string }[] },
    { results: unknown[] },
    { results: { product_id: string; sales_channel: string }[] },
  ];
  const allowed = new Set(eligibility.results.map((row) => row.id));
  const books = applyChannels(canonical.results.map(canonicalRowBook), channels.results).filter(
    (book) => !!book.productId && allowed.has(book.productId),
  );
  return new Map(books.map((book) => [book.productId!, book]));
}
