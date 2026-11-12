/**
 * A protected native-Worker canary must not report a successful homepage when
 * its live primary-D1 rights bootstrap was unavailable. In ordinary browser
 * catalog-filter navigations an empty SSR bootstrap is intentional, so apply
 * this contract only to the exact staging GET / document.
 *
 * Classification is header-only. Never inspect or log book data, IP, tokens,
 * SQL or the error response body.
 */
export function stagingHomeNeedsUnavailableStatus(
  request: Request,
  response: Response,
  staging: boolean,
): boolean {
  if (!staging || request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname !== "/" || url.search) return false;
  if (response.status !== 200) return false;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return false;
  return /(?:^|,)\s*cove_ssr_empty;dur=0(?:\s*,|$)/.test(
    response.headers.get("server-timing") || "",
  );
}
