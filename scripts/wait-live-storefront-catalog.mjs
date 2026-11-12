import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { productionOrigin } from "./check-production-storefront-performance.mjs";

export async function catalogReadinessFailure(response) {
  if (response.status !== 200) return "http-unavailable";
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
    return "non-json-response";
  if (response.headers.get("x-cove-persistence") !== "remote-d1-r2")
    return "missing-live-backend-proof";
  if (!/\\bno-store\\b/i.test(response.headers.get("cache-control") || ""))
    return "unsafe-cache-policy";

  let data;
  try {
    data = await response.json();
  } catch {
    return "invalid-json";
  }
  if (
    !Array.isArray(data?.results) ||
    data.results.length < 1 ||
    !data.results.every(
      (book) =>
        book &&
        typeof book.productId === "string" &&
        book.productId.length > 0 &&
        typeof book.title === "string" &&
        book.title.length > 0,
    )
  )
    return "missing-authorized-books";
  return null;
}

/**
 * Vercel can finish promoting a frontend while its Cloudflare backend still
 * returns 503 for real catalog reads. A narrow owner-DO health handshake does
 * not prove API/catalog availability. Test the actual guest public route.
 *
 * Do not log response bodies, headers, book titles, IP, cookies or tokens.
 * This is a readiness prerequisite, not a cached shelf, performance sample
 * or replacement for geographic cold/100-RPS acceptance.
 */
export async function waitForLiveCatalog({
  origin,
  fetcher = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 5,
}) {
  const base = productionOrigin(origin);
  assert.ok(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 8);
  const url = base + "/api/fore/catalog?search=&sort=popular&page=1&currency=USD";
  let last = "network-unavailable";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json", "Cache-Control": "no-store" },
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      });
      last = await catalogReadinessFailure(response);
      if (last === null) return { ready: true, attempts: attempt + 1 };
    } catch {
      // Do not print arbitrary network exception text or URL.
      last = "network-unavailable";
    }
    if (attempt < attempts - 1) await pause(Math.min(5_000, 1_000 * (attempt + 1)));
  }
  throw new Error("Production guest catalog unavailable after bounded retries (" + last + ").");
}

async function main() {
  const origin = process.env.COVE_PUBLIC_URL || "https://cove-puce-theta.vercel.app";
  const result = await waitForLiveCatalog({ origin });
  console.log(
    "Live production guest catalog, backend provenance and no-store gate: PASS (" +
      result.attempts +
      " attempt(s)).",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
