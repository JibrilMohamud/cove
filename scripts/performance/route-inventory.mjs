import fs from "node:fs/promises";
import path from "node:path";
import { productionOrigin } from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(
  process.env.COVE_PUBLIC_URL || "https://cove-puce-theta.vercel.app",
);
const headers = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};
// Choose a *currently rights-cleared* book in the public market instead of
// pinning the entire route matrix to Gutenberg #1342. Still fail closed when
// books are advertised but none can actually be opened by a guest.
const bootstrapResponse = await fetch(origin + "/api/fore/storefront/bootstrap", {
  headers,
  signal: AbortSignal.timeout(25000),
});
if (!bootstrapResponse.ok) throw Error("Public catalog bootstrap cannot resolve rights-cleared books");
const bootstrap = await bootstrapResponse.json();
const candidates = (bootstrap.catalog?.results || []).slice(0, 8);
if (!candidates.length) throw Error("No real rights-cleared catalog fixture");
let book = null;
let bookId = null;
for (const item of candidates) {
  if (!item.id) continue;
  const response = await fetch(origin + "/api/fore/books/" + encodeURIComponent(item.id), {
    headers,
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) continue;
  const resolved = await response.json();
  if (!resolved?.publicProductId || !resolved?.id) continue;
  book = resolved;
  bookId = String(item.id);
  break;
}
if (!book || !bookId)
  throw Error("Rights-cleared books were advertised but none resolved for guest reading");
const dynamic = {
  "/book/$id": "/book/" + encodeURIComponent(bookId),
  "/read/$id": "/read/" + encodeURIComponent(bookId),
  "/books/$id": "/books/" + encodeURIComponent(book.publicProductId),
  "/edition/$id": "/edition/" + encodeURIComponent(book.publicEditionId || book.editionId),
  "/work/$id": "/work/" + encodeURIComponent(book.publicWorkId || book.workId),
  "/author/$id": book.authors?.[0]?.id
    ? "/author/" + encodeURIComponent(book.authors[0].slug || book.authors[0].id)
    : null,
};
const inventory = [];
for (const file of await fs.readdir("src/routes", { recursive: true })) {
  if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
  const text = await fs.readFile(path.join("src/routes", file), "utf8");
  const template = text.match(/createFileRoute\(["']([^"']+)["']\)/)?.[1];
  if (!template) continue;
  const target = template.includes("$") ? dynamic[template] : template;
  inventory.push({
    source: "src/routes/" + file,
    template,
    target: target || null,
    scope: template.startsWith("/api/")
      ? "API authorization/integration tests"
      : template.includes("$") && !target
        ? "needs owned or published fixture"
        : "guest HTTP",
  });
}
const results = [];
// Deliberately serial and bounded: this is a baseline, not a production stress test.
for (const route of inventory.filter((r) => r.scope === "guest HTTP")) {
  for (const phase of ["first-observed", "repeat"]) {
    const started = performance.now();
    try {
      const response = await fetch(origin + route.target, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      });
      const ttfbMs = performance.now() - started;
      const body = await response.arrayBuffer();
      results.push({
        template: route.template,
        route: route.target,
        phase,
        status: response.status,
        ttfbMs: Math.round(ttfbMs),
        totalMs: Math.round(performance.now() - started),
        bytes: body.byteLength,
        cache: response.headers.get("x-vercel-cache"),
        cacheControl: response.headers.get("cache-control"),
        serverTiming: (response.headers.get("server-timing") || "")
          .split(",")
          .filter((x) => /^\s*cove_[a-z_]+;dur=[\d.]+\s*$/.test(x))
          .join(","),
        expectedAuthGuard:
          route.target.startsWith("/staff/") && [401, 403].includes(response.status),
      });
    } catch (error) {
      results.push({
        template: route.template,
        route: route.target,
        phase,
        error: error.name,
        totalMs: Math.round(performance.now() - started),
      });
    }
  }
}
const report = {
  at: new Date().toISOString(),
  origin,
  boundary:
    "Guest read-only HTTP probes, not client interactivity or field Core Web Vitals. First-observed is not guaranteed empty server cache. Dynamic bearer/private routes are inventoried without guessing access tokens; real personal-library performance needs isolated fixtures.",
  inventory,
  results,
};
await fs.mkdir("artifacts/fullsite-performance", { recursive: true });
await fs.writeFile(
  "artifacts/fullsite-performance/routes-baseline.json",
  JSON.stringify(report, null, 2),
);
for (const row of results) console.log("COVE_ROUTE_SAMPLE " + JSON.stringify(row));
console.log(
  "COVE_ROUTE_SUMMARY " +
    JSON.stringify({
      inventoried: inventory.length,
      probed: results.length / 2,
      failures: results.filter((r) => r.error || r.status >= 500).length,
    }),
);
