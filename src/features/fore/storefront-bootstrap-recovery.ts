import type { StorefrontBootstrap } from "./storefront-bootstrap";

/** Reconstruct only from the normal live rights-scoped API endpoints.
 * No cached foreign territory, US seed catalogue, or stale product IDs.
 * Each request inherits the same visitor headers and one shared deadline.
 */
export async function recoverStorefrontBootstrap(
  source: Request,
  fetchApi: (request: Request) => Promise<Response>,
  requireRemoteBackend = false,
): Promise<string | null> {
  if (source.signal.aborted) return null;
  const origin = new URL(source.url).origin;
  async function read<T>(path: string): Promise<T> {
    const url = new URL(path, origin);
    const response = await fetchApi(
      new Request(url, { headers: source.headers, signal: source.signal }),
    );
    if (!response.ok) throw new Error("Storefront recovery endpoint unavailable");
    // Production may NOT use Vercel's bundled US-only catalog fallback when
    // the actual rights authority is temporarily unreachable.
    if (requireRemoteBackend && response.headers.get("x-cove-persistence") !== "remote-d1-r2")
      throw new Error("Storefront recovery requires live rights authority");
    return (await response.json()) as T;
  }
  try {
    const [context, page] = await Promise.all([
      read<StorefrontBootstrap["context"]>("/api/fore/storefront/context"),
      read<StorefrontBootstrap["page"]>("/api/fore/storefront/page?path=%2F"),
    ]);
    if (
      !/^[A-Z]{2}$/.test(context?.rightsCountry || "") ||
      !/^[a-z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(context?.locale || "") ||
      !/^[A-Z]{3}$/.test(context?.currency || "") ||
      !Array.isArray(context?.availableMarkets) ||
      !page ||
      typeof page !== "object" ||
      !page.query ||
      typeof page.query !== "object" ||
      ("redirectTo" in page && Boolean(page.redirectTo))
    )
      return null;
    const catalogQuery = new URLSearchParams({
      search: "",
      sort: "popular",
      page: "1",
      currency: context.currency,
    }).toString();
    const catalog = await read<StorefrontBootstrap["catalog"]>("/api/fore/catalog?" + catalogQuery);
    if (
      !Array.isArray(catalog?.results) ||
      catalog.results.length === 0 ||
      typeof catalog.count !== "number" ||
      !catalog.results.every((book) => book && typeof book.productId === "string")
    )
      return null;
    const value: StorefrontBootstrap = {
      context,
      page,
      catalog,
      catalogQuery,
      at: Date.now(),
    };
    return JSON.stringify(value);
  } catch {
    // Recovery must fail closed if any independent live check is unavailable.
    return null;
  }
}
