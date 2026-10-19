import type { CatalogDB } from "./catalog-model.server";

/**
 * Each presentation-only aggregation gets a fresh, unconstrained D1 session.
 * D1 can place that read on a read replica when replication is enabled.
 *
 * This MUST NOT be used for selecting/authorizing displayed books, purchases,
 * downloads, or reading. Replica snapshots can lag the primary. Counts and
 * facet distributions are non-authoritative presentation metadata only.
 * Off by default until an isolated paired performance/rights gate passes.
 *
 * Never retain a session or pending D1 I/O between Worker requests.
 */
export function presentationReadSession(db: CatalogDB, enabled?: string): CatalogDB {
  if (enabled !== "1") return db;
  const source = db as CatalogDB & {
    withSession?: (constraint: "first-unconstrained") => CatalogDB;
  };
  return typeof source.withSession === "function"
    ? source.withSession("first-unconstrained")
    : db;
}
