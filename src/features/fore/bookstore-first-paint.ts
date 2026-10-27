import type { CatalogResponse } from "./Store";
import type { StorefrontBootstrap } from "./storefront-bootstrap";

/**
 * A transient first-paint hint, never an entitlement or rights authority.
 * The backend builds it from fresh, territory-scoped live retail authorization;
 * the client must still reject a mismatch with its active locale and URL.
 * All purchase, book-detail and protected-media actions use independent
 * authoritative rights/entitlement checks.
 */
export function verifiedFirstPageShelf(
  bootstrap: StorefrontBootstrap,
  expected: { country: string; currency: string; locale: string; query: string },
  now = Date.now(),
): CatalogResponse {
  if (
    !bootstrap ||
    bootstrap.context?.rightsCountry !== expected.country ||
    bootstrap.context?.currency !== expected.currency ||
    bootstrap.context?.locale !== expected.locale ||
    bootstrap.catalogQuery !== expected.query ||
    !Number.isFinite(bootstrap.at) ||
    bootstrap.at > now + 5_000 ||
    now - bootstrap.at > 30_000 ||
    bootstrap.catalog?.preview !== true ||
    !Array.isArray(bootstrap.catalog.results) ||
    bootstrap.catalog.results.length > 60 ||
    !bootstrap.catalog.results.every(
      (book) => book && typeof book.productId === "string" && book.productId.length > 0,
    )
  )
    throw new Error("Cove could not verify the current Bookstore first page.");
  return bootstrap.catalog;
}
