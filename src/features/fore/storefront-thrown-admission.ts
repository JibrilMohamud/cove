/**
 * A local Worker bootstrap can throw the verified edge limiter's ApiError
 * before producing an HTTP response. The hedged HTTP classifier otherwise
 * reports the generic "transport_or_invalid" category, making 100-RPS
 * admission failures indistinguishable from D1/network failures.
 *
 * Only exact source-controlled codes + messages classify an Error. Never
 * return or log the error message, headers, request identity, SQL or body.
 */
export function classifyThrownStorefrontAdmission(
  error: unknown,
): "throttled" | "limiter_unavailable" | null {
  if (!(error instanceof Error)) return null;
  const status = (error as Error & { status?: unknown }).status;
  if (status === 429 && error.message === "Please wait a minute before trying again.")
    return "throttled";
  if (status === 503 && error.message === "Native storefront read limiter is unavailable.")
    return "limiter_unavailable";
  return null;
}
