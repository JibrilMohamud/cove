/** Signed offline EPUB receipts are usable for at most seven 24-hour days. */
export const OFFLINE_EPUB_LICENSE_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_EPUB_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_EPUB_RENEWAL_RETRY_MS = 60 * 60 * 1000;
export const OFFLINE_EPUB_CONTEXT = "cove-offline-epub:v1\n";

/** The browser clock is advisory. An expired receipt must never open offline. */
export function validOfflineEpubWindow(issued: number, expires: number, current: number) {
  return (
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    Number.isFinite(current) &&
    issued <= current + 60_000 &&
    expires > current &&
    expires > issued &&
    expires - issued <= OFFLINE_EPUB_LICENSE_MS
  );
}
export function shouldRenewOfflineEpub(expires: number, current: number) {
  return Number.isFinite(expires) && current >= expires - OFFLINE_EPUB_RENEWAL_WINDOW_MS;
}
