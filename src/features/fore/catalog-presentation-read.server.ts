import type { CatalogDB } from "./catalog-model.server";

/** A new request-local session for aggregate display numbers only.
 * No session or promise is retained or shared. Actual book IDs, retail
 * offers, entitlements and legal access decisions remain on the primary.
 * Replica lag can affect the same numerical labels that already have a
 * ten-minute cache. Cache reads/writes and all actual book access remain on
 * the caller's primary DB. Local adapters retain their existing behavior. */
export function catalogPresentationReadDb(db: CatalogDB): CatalogDB {
  const capable = db as CatalogDB & {
    withSession?: (constraint: "first-unconstrained") => CatalogDB;
  };
  return typeof capable.withSession === "function"
    ? capable.withSession("first-unconstrained")
    : db;
}
