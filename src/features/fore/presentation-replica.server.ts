import type { CatalogDB } from "./catalog-model.server";

/**
 * Non-authoritative presentation reads may use an unconstrained D1 session.
 * It can be served by a read replica, so results may lag the primary.
 * NEVER use this helper to authorize a retail offer, entitlement, download,
 * product-ID selection or any other action requiring current rights.
 */
export function replicaEligiblePresentationRead(db: CatalogDB): CatalogDB {
  const capable = db as CatalogDB & {
    covePrimaryOnlyReadTransport?: boolean;
    withSession?: (constraint: "first-unconstrained") => CatalogDB;
  };
  // A primary-only owner READ facade is already stricter than presentation
  // requires. Preserve it; its refusal of replicas is not an unavailable DB.
  if (capable.covePrimaryOnlyReadTransport === true) return db;
  return typeof capable.withSession === "function"
    ? capable.withSession("first-unconstrained")
    : db;
}
