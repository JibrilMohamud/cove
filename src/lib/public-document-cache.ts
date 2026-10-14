// Only invariant public shells. All account state loads privately after hydration.
// Queries (auth callbacks, bearer links, search) and authenticated requests bypass.
const shells = new Set([
  "/",
  "/store",
  "/audiobooks",
  "/terms",
  "/privacy",
  "/security",
  "/copyright",
]);
export function cachePublicDocument(request: Request, response: Response) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.search ||
    !shells.has(url.pathname) ||
    ["cookie", "authorization", "oai-authenticated-user-id"].some((h) => request.headers.has(h)) ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("text/html") ||
    response.headers.has("set-cookie") ||
    /private|no-store/i.test(response.headers.get("cache-control") || "")
  )
    return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("Vercel-CDN-Cache-Control", "public, s-maxage=300");
  return new Response(response.body, { status: response.status, headers });
}
