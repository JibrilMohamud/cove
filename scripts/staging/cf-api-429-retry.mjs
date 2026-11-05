/** Retry only throttled, idempotent Cove Sounds source reads and KV snapshot puts.
 * Never retry failed authorization, malformed responses, or arbitrary API writes. */
export function isRetryableSoundsRequest(resource, method) {
  if (typeof resource !== "string") return false;
  const safe =
    /^accounts\/[a-f0-9]{32}\/(?:d1\/database\/[a-f0-9-]{36}\/query|storage\/kv\/namespaces\/[a-f0-9]{32}\/values\/[^\s]+)$/i;
  if (!safe.test(resource)) return false;
  if (resource.includes("/d1/database/")) return method === "POST";
  return method === "PUT";
}
export function throttleDelayMs(retryAfter, retry) {
  const parsed = Number(retryAfter);
  const supplied = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 0;
  return Math.max(12_000 + retry * 3_000, Math.min(60_000, supplied));
}
export async function withSoundsCloudflare429Retry(
  operation,
  {
    resource,
    method,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {},
  },
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await operation();
    if (response.status !== 429 || !isRetryableSoundsRequest(resource, method) || attempt === 2)
      return response;
    const delay = throttleDelayMs(response.headers?.get?.("retry-after"), attempt);
    try {
      await response.body?.cancel?.();
    } catch {
      /* no effect on the safety gate */
    }
    onRetry({ retry: attempt + 1, delayMs: delay });
    await sleep(delay);
  }
  throw new Error("Unreachable Cloudflare 429 retry state");
}
