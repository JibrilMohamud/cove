import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync(
  "src/features/fore/storefront-anonymous-bootstrap.server.ts",
  "utf8",
);
const start = source.indexOf("const pendingPresentation = new WeakMap");
const end = source.indexOf("/**\n * Cloudflare Worker-only", start);
assert.ok(start >= 0 && end > start, "Missing bounded anonymous presentation singleflight");
const isolated = source
  .slice(start, end)
  .replace(
    "function singleflightAnonymousPresentation<T>(",
    "export function singleflightAnonymousPresentation<T>(",
  );
const compiled = await transform(isolated, { loader: "ts", format: "esm" });
const { singleflightAnonymousPresentation: coalesce } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);
const db = {};
let calls = 0;
let unblock;
const deferred = new Promise((resolve) => {
  unblock = resolve;
});
const batch = Array.from({ length: 16 }, () =>
  coalesce(db, "context:US:en-US", async () => {
    calls++;
    await deferred;
    return { locale: "en-US" };
  }),
);
await Promise.resolve();
assert.equal(calls, 1, "Concurrent anonymous locale reads should have one D1 call");
unblock();
assert.equal((await Promise.all(batch)).length, 16);
const later = await coalesce(db, "context:US:en-US", async () => {
  calls++;
  return { locale: "en-US" };
});
assert.deepEqual(later, { locale: "en-US" });
assert.equal(calls, 2, "Completed presentation result must NEVER stay cached");

let countryCalls = 0;
await Promise.all([
  coalesce(db, "context:US:en-US", async () => ++countryCalls),
  coalesce(db, "context:CA:en-US", async () => ++countryCalls),
  coalesce(db, "context:US:fr-CA", async () => ++countryCalls),
  coalesce({}, "context:US:en-US", async () => ++countryCalls),
]);
assert.equal(countryCalls, 4, "No sharing across market, locale, or DB binding");

const failedDb = {};
let rejectionCalls = 0;
const failing = () =>
  coalesce(failedDb, "markets", async () => {
    rejectionCalls++;
    throw new Error("D1 unavailable");
  });
await assert.rejects(failing(), /D1 unavailable/);
await assert.rejects(failing(), /D1 unavailable/);
assert.equal(rejectionCalls, 2, "A failed D1 read must not be cached or fail open");

const longKey = "L".repeat(193);
let longCalls = 0;
await Promise.all([
  coalesce(db, longKey, async () => ++longCalls),
  coalesce(db, longKey, async () => ++longCalls),
]);
assert.equal(longCalls, 2, "Unbounded client-controlled language keys must bypass coalescing");

// These two authoritative actions must remain independent per request:
// coalescing them would hide revocation, rate-limit or global catalog changes.
assert.match(source, /timed\("catalog", firstPaintStorefrontShelf\(/);
assert.match(source, /timed\("limit", enforceFirstPaintRateLimit\(/);
assert.match(source, /if \(request\.headers\.has\(header\)\) return false;/);
console.log(
  "Anonymous presentation singleflight: concurrent, regional, locale, rejection, cleanup and rights isolation PASS",
);
