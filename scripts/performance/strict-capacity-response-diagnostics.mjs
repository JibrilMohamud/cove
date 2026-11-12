import { visibleServerBookCount } from "../check-production-storefront-performance.mjs";

/**
 * Return one known, privacy-safe failure category. Never return source HTML,
 * response headers, location, tokens, client addresses or error messages.
 * This is a diagnostic companion, NOT a replacement for validateHtml().
 */
export function capacityHtmlFailureKind(status, contentType, html) {
  if (status !== 200) return "unexpected-http-status";
  if (!contentType.toLowerCase().includes("text/html")) return "unexpected-media-type";
  if (html.length > 4_000_000) return "html-safety-limit";
  if (visibleServerBookCount(html) < 1) return "missing-ssr-book-cards";
  return null;
}
