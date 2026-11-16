/**
 * Bounded, low-rate scheduling for protected READ-ONLY primary D1 API queries.
 *
 * The caller MUST validate each SQL statement and D1 changed_db/changes=0.
 * This module retries ONLY HTTP 429 for the exact same read-only request;
 * it never retries authorization errors, transport errors or other statuses.
 * Respect Retry-After (seconds or HTTP-date) or STOP if it exceeds the
 * remaining retry budget. No credentials, product identifiers, SQL or
 * response bodies are logged. No write endpoint can be selected here.
 */
const MAX_HTTP_ATTEMPTS = 412;
const MIN_REQUEST_GAP_MS = 500;
const MAX_429_RESPONSES = 5;
const MAX_RETRIES_PER_QUERY = 3;
const MAX_RETRY_WAIT_MS = 180_000;
const FALLBACK_RETRY_DELAYS_MS = [20_000, 40_000, 80_000];

export function retryAfterDelayMs(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : Number.POSITIVE_INFINITY;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : 0;
}

export function createProtectedD1ReadThrottle({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onThrottle = () => {},
  maxAttempts = MAX_HTTP_ATTEMPTS,
  max429Responses = MAX_429_RESPONSES,
  maxRetryWaitMs = MAX_RETRY_WAIT_MS,
  minRequestGapMs = MIN_REQUEST_GAP_MS,
} = {}) {
  let attempts = 0;
  let throttled = 0;
  let waitedOn429Ms = 0;
  let nextStartMs = Number.NEGATIVE_INFINITY;
  const stats = () => ({
    httpAttempts: attempts,
    rateLimitedResponses: throttled,
    rateLimitWaitMs: waitedOn429Ms,
  });

  async function request(send) {
    if (typeof send !== 'function') throw Error('rights_spot_audit_query_blocked');
    for (let retry = 0; retry <= MAX_RETRIES_PER_QUERY; retry++) {
      if (attempts >= maxAttempts) throw Error('rights_spot_audit_query_budget_exhausted');
      const pacingMs = Math.max(0, nextStartMs - now());
      if (pacingMs > 0) await sleep(pacingMs);
      nextStartMs = now() + minRequestGapMs;
      attempts++;
      // Only query SELECT statements, called by the audited readSql adapter.
      const response = await send();
      if (response?.status !== 429) return response;
      throttled++;
      try { await response.body?.cancel?.(); } catch { /* no data retained */ }
      if (retry === MAX_RETRIES_PER_QUERY || throttled > max429Responses)
        throw Error('rights_spot_audit_rate_limited');
      const retryAfterMs = retryAfterDelayMs(response.headers?.get?.('retry-after'), now());
      const delayMs = Math.max(FALLBACK_RETRY_DELAYS_MS[retry], retryAfterMs);
      if (!Number.isSafeInteger(delayMs) || delayMs > maxRetryWaitMs - waitedOn429Ms)
        throw Error('rights_spot_audit_rate_limited');
      waitedOn429Ms += delayMs;
      onThrottle({ retry: retry + 1, delayMs });
      await sleep(delayMs);
    }
    throw Error('rights_spot_audit_rate_limited');
  }

  return { request, stats };
}
