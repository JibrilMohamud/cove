/** Correctly classify Cloudflare's D1 service saturation before generic D1 errors. */
export function syntheticDbFailureCategory(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
  const message = String(e?.message || "") + " " + String(e?.cause?.code || "");
  if (/overloaded|requests queued for too long|SQLITE_BUSY|database is locked|too many requests/i.test(message))
    return "database-queue-or-overload";
  if (/no such table|no such column|syntax error|SQLITE_ERROR/i.test(message))
    return "database-schema-or-statement";
  if (/D1_ERROR|D1_DATABASE/i.test(message)) return "database-other";
  if (/timeout|deadline|aborted/i.test(message)) return "dependency-timeout";
  if (e?.name === "TypeError") return "runtime-type";
  if (e?.name === "RangeError") return "runtime-range";
  return "unknown";
}
