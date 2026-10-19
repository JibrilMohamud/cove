/** A small, independent guard shared by early SSR prestart and the loader.
 * Worker territory headers have already been reconstructed from request.cf by
 * server.ts; this predicate is never allowed to infer country from browser
 * supplied headers. The LIVE primary D1 grant check still runs separately.
 */
export type AnonymousBootstrapBindings = {
  DB?: { prepare?: unknown };
  COVE_STOREFRONT_READ_LIMITER?: { limit?: unknown };
};

export function canRunAnonymousHomepageBootstrap(
  request: Request,
  env: AnonymousBootstrapBindings,
  path: "/" | "/api/fore/storefront/bootstrap",
): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname !== path || url.search) return false;
  if (typeof env.DB?.prepare !== "function") return false;
  if (typeof env.COVE_STOREFRONT_READ_LIMITER?.limit !== "function") return false;
  if (!/^[A-Z]{2}$/.test(request.headers.get("x-cove-client-country") || "")) return false;
  if (!request.headers.get("cf-connecting-ip")?.trim()) return false;
  for (const name of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ])
    if (request.headers.has(name)) return false;
  return true;
}
