/**
 * Identifies Cloudflare D1's documented 7429 per-database overload response.
 * Only a boolean decision crosses this boundary: never log SQL, exception
 * messages, access tokens or upstream response bodies from a failed request.
 */
export function isPrimaryD1Overload(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const outer = error as { message?: unknown; code?: unknown; cause?: unknown };
  const cause =
    outer.cause && typeof outer.cause === "object"
      ? (outer.cause as { message?: unknown; code?: unknown })
      : null;
  if ([outer.code, cause?.code].some((value) => value === 7429 || value === "7429"))
    return true;
  return [outer.message, cause?.message].some(
    (value) =>
      typeof value === "string" &&
      (/\b7429\b/.test(value) ||
        /\btoo many requests to the same database\b/i.test(value) ||
        /\bD1_ERROR\b.{0,90}\boverload(?:ed)?\b/i.test(value)),
  );
}
