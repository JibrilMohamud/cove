import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = mkdtempSync(join(tmpdir(), "cove-bookstore-first-"));
try {
  const out = join(temp, "first.mjs");
  await build({
    entryPoints: ["src/features/fore/bookstore-first-paint.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "silent",
  });
  const { verifiedFirstPageShelf } = await import(pathToFileURL(out).href);
  const now = Date.now();
  const query = "search=&sort=popular&page=1&currency=USD";
  const expected = { country: "US", currency: "USD", locale: "en-US", query };
  const shelf = {
    context: { rightsCountry: "US", currency: "USD", locale: "en-US" },
    catalogQuery: query,
    at: now,
    catalog: { preview: true, results: [{ productId: "prd_public_123" }] },
  };
  assert.equal(verifiedFirstPageShelf(shelf, expected, now), shelf.catalog);
  for (const incorrect of [
    { context: { ...shelf.context, rightsCountry: "CA" } },
    { context: { ...shelf.context, currency: "CAD" } },
    { context: { ...shelf.context, locale: "fr-CA" } },
    { catalogQuery: "search=&sort=popular&page=2&currency=USD" },
    { at: now - 60_000 },
    { at: now + 20_000 },
    { catalog: { ...shelf.catalog, preview: false } },
    { catalog: { ...shelf.catalog, results: [{ productId: "" }] } },
    {
      catalog: {
        ...shelf.catalog,
        results: Array.from({ length: 61 }, (_, i) => ({ productId: "prd_" + i })),
      },
    },
  ])
    assert.throws(() => verifiedFirstPageShelf({ ...shelf, ...incorrect }, expected, now));
  assert.throws(() => verifiedFirstPageShelf(shelf, { ...expected, query: "q=search" }, now));
  const store = readFileSync("src/features/fore/Store.tsx", "utf8");
  assert.match(
    store,
    /enabled:\s*!fastAnonymousHome \|\|\s*!!matchingInitial\?\.catalog \|\|\s*!!fastPreview \|\|\s*fastShelf\.isError \|\|\s*catalogFallbackReady/,
  );
  assert.match(store, /placeholderData: fastAnonymousHome \? fastPreview : undefined/);
  assert.match(store, /fastAnonymousHome && !matchingInitial\?\.catalog/);
  assert.match(store, /landingPath === "\/"/);
  assert.match(store, /landingPath === "\/store"/);
  assert.match(store, /setTimeout\(\(\) => setCatalogFallbackReady\(true\), 800\)/);
  assert.match(store, /sort === "popular"/);
  assert.match(store, /enabled: home && !!visitor && books\.length > 0/);
  assert.match(store, /queryFn: \(\{ signal \}\) => api\("\/catalog\?" \+ params/);
  // Fast preview cannot authorize purchases. Existing retail and media
  // handlers must remain separate, and the full catalog is still requested.
  assert.doesNotMatch(
    readFileSync("src/features/fore/bookstore-first-paint.ts", "utf8"),
    /\b(?:INSERT|UPDATE|DELETE|sessionStorage|localStorage|grantAccess|publishEntitlement)\s*\(/i,
  );
  console.log(
    "PASS: first-page live shelf is country/currency/locale/query-scoped, fresh, preview-only; rich catalog remains authoritative",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
