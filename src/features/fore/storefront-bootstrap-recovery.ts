import type { StorefrontBootstrap } from "./storefront-bootstrap";

/**
 * Route recovery through a separate same-origin API function only when the
 * direct Worker gateway is configured. This changes network isolation, NOT
 * authority: the caller still requires live backend provenance and territory.
 */
export function storefrontRecoveryTransport(
  direct: (request: Request) => Promise<Response>,
  sameOrigin: (request: Request) => Promise<Response>,
  requireRemoteBackend: boolean,
): (request: Request) => Promise<Response> {
  if (!requireRemoteBackend) return direct;
  return (request) => sameOrigin(new Request(request, { redirect: "manual", cache: "no-store" }));
}

/** Reconstruct only from the normal live rights-scoped API endpoints.
 * No cached foreign territory, US seed catalogue, or stale product IDs.
 * Each request inherits the same visitor headers and one shared deadline.
 */
export async function recoverStorefrontBootstrap(
  source: Request,
  fetchApi: (request: Request) => Promise<Response>,
  requireRemoteBackend = false,
  verifyOriginalTerritory = false,
): Promise<string | null> {
  if (source.signal.aborted) return null;
  // A secondary Vercel invocation may geo-locate the SERVER rather than the
  // original visitor. Only use that independent path when the incoming request
  // has an original platform-country assertion, and verify it again below.
  const sourceCountry = source.headers.get("x-vercel-ip-country")?.trim().toUpperCase() || "";
  if (verifyOriginalTerritory && !/^[A-Z]{2}$/.test(sourceCountry)) return null;
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
      (verifyOriginalTerritory && context.rightsCountry !== sourceCountry) ||
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
