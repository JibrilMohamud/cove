/** Pure, bootstrap-only formatter for the known "/" path.
 *
 * Do not import taxonomy.server.ts for an anonymous first paint: its
 * taxonomy administration/counts/Zod dependencies are unused when formatting
 * an already-retrieved root-page row. Keep the output contract equivalent to
 * formatGenericStorefrontPageRecord("/", row). No entitlement is cached.
 */
export function formatHomepageFirstPaintPage(record: Record<string, unknown> | null) {
  if (!record)
    return {
      path: "/",
      pageType: "home",
      title: "Bookstore",
      heading: "Find your next great read.",
      eyebrow: "THE BOOKSTORE",
      description: "Stories to get lost in. Ideas to carry with you.",
      seoTitle: "Cove — Bookstore & Reading Room",
      seoDescription: "Discover ebooks, read online, and build your reading life.",
      noindex: false,
      canonical: "/",
      query: {},
    };

  let query: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(record.query_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      query = parsed as Record<string, unknown>;
  } catch {
    // Legacy canonical formatter also falls back to an empty query object.
  }

  return {
    path: String(record.path),
    pageType: String(record.page_type),
    title: String(record.title),
    heading: String(record.heading),
    eyebrow: String(record.eyebrow || "THE BOOKSTORE"),
    description: String(record.description || ""),
    seoTitle: String(record.seo_title || record.title),
    seoDescription: String(record.seo_description || record.description || ""),
    noindex: !!record.noindex,
    canonical: String(record.path),
    query,
  };
}
