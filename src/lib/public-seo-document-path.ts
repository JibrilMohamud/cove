/**
 * Public crawler documents are intentionally invariant across users and
 * territorial storefronts. Do not add /books, /store, /account or API paths:
 * those require current entitlements or market-specific data.
 */
export function isPublicSeoDocumentPath(path: string): boolean {
  return (
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/sitemaps/pages.xml" ||
    /^\/sitemaps\/(?:books|works|editions|authors|categories)(?:\.xml|\/[1-9][0-9]{0,4}\.xml)$/.test(
      path,
    )
  );
}

/**
 * Exactly the routes the persistence backend gateway could handle.
 * Keep this shared with the SSR dispatcher: non-API HTML (including "/")
 * must never eagerly load API/ingestion code.
 */
export function isPersistenceGatewayRoute(path: string): boolean {
  return path.startsWith("/api/fore/") || isPublicSeoDocumentPath(path);
}
