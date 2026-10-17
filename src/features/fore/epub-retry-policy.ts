/**
 * A scheduled ingestion tick is a bounded job, not an EPUB's retry budget.
 * Do not claim a new file when the shared deadline is about to expire.
 */
export const MIN_EPUB_DOWNLOAD_WINDOW_MS = 15_000;
export function hasEpubDownloadWindow(deadlineMs: number, nowMs = Date.now()) {
  return !Number.isFinite(deadlineMs) || deadlineMs - nowMs >= MIN_EPUB_DOWNLOAD_WINDOW_MS;
}

export function planEpubRetry(message: string, attempts: number, nowMs = Date.now()) {
  const deterministicOversize = /file is too large|epub limit is 25 mb/i.test(message);
  const persistentMissingAsset =
    /(?:epub|html) source returned 404/i.test(message) && attempts >= 3;
  // A transient network timeout can be caused by the scheduler's own deadline.
  // Allow four extra, exponentially backed-off attempts, then stop permanently.
  const transientTimeout = /(?:aborted due to timeout|timed out|timeouterror)/i.test(message);
  const maxAttempts = transientTimeout ? 12 : 8;
  const terminal = deterministicOversize || persistentMissingAsset || attempts >= maxAttempts;
  return {
    terminal,
    retryAt: terminal
      ? ""
      : new Date(
          nowMs + Math.min(24 * 60 * 60 * 1000, Math.pow(2, attempts) * 5 * 60 * 1000),
        ).toISOString(),
  };
}

/** Allocate three fresh asset attempts for every due retry, where possible.
 * Fetch each indexed frontier independently so an old retry backlog cannot
 * starve first-time storage (or vice versa). Per-item rights/claim checks stay
 * in the downloader, not in this fair scheduler.
 */
export function mixEpubFrontier<T>(pending: readonly T[], retries: readonly T[], limit: number): T[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(64, Math.floor(limit))) : 0;
  const result: T[] = [];
  let fresh = 0;
  let retry = 0;
  while (result.length < count && (fresh < pending.length || retry < retries.length)) {
    for (let n = 0; n < 3 && fresh < pending.length && result.length < count; n++) {
      result.push(pending[fresh++]);
    }
    if (retry < retries.length && result.length < count) result.push(retries[retry++]);
  }
  return result;
}
