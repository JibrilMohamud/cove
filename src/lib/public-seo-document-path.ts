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
