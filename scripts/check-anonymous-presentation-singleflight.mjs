import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const file = "src/features/fore/anonymous-presentation-singleflight.server.ts";
const { outputFiles } = await build({
  entryPoints: [file],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
});
const { createAnonymousPresentationSingleflight } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
);
const singleflight = createAnonymousPresentationSingleflight(2);
let work = 0;
let finish = () => {};
const pending = new Promise((resolve) => {
  finish = resolve;
});
const a = singleflight('["US","en-US"]', async () => {
  work++;
  await pending;
  return { rightsCountry: "US", locale: "en-US" };
});
const same = singleflight('["US","en-US"]', async () => {
  work++;
  throw Error("Duplicate locale query must not begin");
});
const other = singleflight('["CA","fr-CA"]', async () => {
  work++;
  return { rightsCountry: "CA", locale: "fr-CA" };
});
assert.strictEqual(a, same, "Concurrent same-country/language must share only pending promise");
const alternate = await other;
assert.equal(alternate.rightsCountry, "CA");
finish();
const answer = await a;
assert.equal(answer.rightsCountry, "US");
assert.equal(work, 2);
const updated = await singleflight('["US","en-US"]', async () => {
  work++;
  return { rightsCountry: "US", locale: "changed-now" };
});
assert.equal(updated.locale, "changed-now", "No stale TTL after settlement");
assert.equal(work, 3, "Every new post-settle request rechecks presentation metadata");

// Saturation cannot block distinct visitors; fallback starts independently.
// Error must be visible to all waiters and immediately evicted for retry.
let release = () => {};
const stuck = new Promise((resolve) => {
  release = resolve;
});
const first = singleflight("full-a", async () => stuck);
const second = singleflight("full-b", async () => stuck);
let saturated = 0;
await singleflight("full-c", async () => {
  saturated++;
  return 1;
});
assert.equal(saturated, 1);
release(1);
await Promise.all([first, second]);

let failures = 0;
const fail = () =>
  singleflight("fail", async () => {
    failures++;
    throw Error("transient D1");
  });
const [rejectedA, rejectedB] = await Promise.allSettled([fail(), fail()]);
assert.equal(rejectedA.status, "rejected");
assert.equal(rejectedB.status, "rejected");
assert.equal(failures, 1);
await assert.rejects(fail(), /transient D1/);
assert.equal(failures, 2, "Failures must not remain cached");

// Identity boundary must never admit cookies, users or canonical product
// grants. Each browser request still requires a live rights-checked catalog.
const bootstrap = fs.readFileSync(
  "src/features/fore/storefront-anonymous-bootstrap.server.ts",
  "utf8",
);
assert.match(bootstrap, /canUseLeanAnonymousBootstrap\(request, env\)/);
assert.match(bootstrap, /request\.headers\.has\(header\)/);
assert.match(bootstrap, /pendingAnonymousPresentation\(presentationKey/);
assert.match(bootstrap, /firstPaintStorefrontShelf\(env, null, trustedCountry, d1Metrics\)/);
assert.match(bootstrap, /Promise\.all\(\[/);
assert.doesNotMatch(bootstrap, /\b(?:rights|catalog)Cache\.set\(/);
console.log("Anonymous presentation coalescing: no TTL, isolation, retry, rights checked PASS");
