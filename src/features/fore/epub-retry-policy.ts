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
