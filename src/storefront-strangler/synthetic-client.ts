/** A protected synthetic-only stage may model distinct virtual clients while
 * exercising the unchanged per-IP rate limiter. Never use with production D1. */
export function syntheticBenchmarkClient(
  request: Request,
  env: { COVE_SSR_STAGING?: string; COVE_STRANGLER_DATABASE_ID?: string },
): Request {
  const client = request.headers.get("x-cove-perf-client");
  if (client === null) return request;
  if (
    env.COVE_SSR_STAGING !== "1" ||
    env.COVE_STRANGLER_DATABASE_ID !== "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" ||
    !/^\d{1,5}$/.test(client) ||
    Number(client) > 65535
  )
    throw new Error("Synthetic client outside isolated benchmark");
  const headers = new Headers(request.headers);
  const index = Number(client);
  headers.set("cf-connecting-ip", `198.18.${index >>> 8}.${index & 255}`);
  headers.delete("x-cove-perf-client");
  return new Request(request, { headers });
}
