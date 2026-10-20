/** Never enabled against production D1, even if a deployment flag is set.
 * Experiment: isolate the D1 request-log/rate-limit write contribution.
 * Public API abuse controls remain unchanged on production and other staging.
 */
export type SyntheticReadEnv = {
  COVE_SSR_STAGING?: string;
  COVE_PERF_DATABASE_ID?: string;
  COVE_PERF_EDGE_PUBLIC_READS?: string;
  COVE_STOREFRONT_READ_LIMITER?: unknown;
};

export function syntheticPublicReadBucket(
  env: SyntheticReadEnv,
  method: string,
  pathname: string,
  hasUser: boolean,
  bucket: string,
): boolean {
  return (
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_PERF_DATABASE_ID === "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" &&
    env.COVE_PERF_EDGE_PUBLIC_READS === "1" &&
    !hasUser &&
    method === "GET" &&
    (pathname === "/api/fore/catalog" ||
      pathname === "/api/fore/recommendations/home" ||
      pathname === "/api/fore/merchandising") &&
    (bucket === "catalog" || bucket === "recommend-home" || bucket === "merch")
  );
}

/** No raw SQL, exception text, keys, visitor identifiers, or paths in headers. */
export function syntheticFailureCategory(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
  const message = typeof e?.message === "string" ? e.message : "";
  const code = typeof e?.cause?.code === "string" ? e.cause.code : "";
  if (/no such table|no such column|SQLITE_ERROR|D1_ERROR/.test(message + code))
    return "database-schema-or-statement";
  if (/SQLITE_BUSY|D1_DATABASE|overloaded|too many requests/i.test(message + code))
    return "database-queue-or-overload";
  if (/timeout|deadline|abort/i.test(message + code)) return "dependency-timeout";
  if (e?.name === "TypeError") return "runtime-type";
  if (e?.name === "RangeError") return "runtime-range";
  return "unknown";
}
