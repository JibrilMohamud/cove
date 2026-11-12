/**
 * Keep signed-in and all other search/activity limits on canonical D1.
 * Only cookie-free, unauthenticated GET catalog pages with a verified Worker
 * edge limiter may avoid the global D1 writer on each public read.
 *
 * This is an admission selection, never a bypass: the caller MUST invoke
 * the edge limiter and fail closed on unavailable/denied rate-limit service.
 * No legal rights or catalog query is cached or skipped.
 */
export function canEdgeLimitAnonymousCatalog(
  request: Request,
  userId: string | null,
  bucket: string,
  limiter: unknown,
): boolean {
  if (bucket !== "catalog" || userId !== null) return false;
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname !== "/api/fore/catalog") return false;
  if (!limiter || typeof limiter !== "object") return false;
  if (typeof (limiter as { limit?: unknown }).limit !== "function") return false;
  for (const header of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ])
    if (request.headers.has(header)) return false;
  return true;
}
