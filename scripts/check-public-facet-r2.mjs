import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
assert.match(search, /!!env\.COVE_PUBLIC_PRESENTATION_CACHE/);
assert.match(search, /refreshPublicFacetProjection\(presentationStore, cacheKey/);
assert.match(search, /d1Facets\(db, input, expression, undefined, undefined, presentationStore\)/);
assert.match(search, /if \(!facetState\.pending && !presentationStore\)/);
assert.match(search, /if \(!presentationStore\) \{\s*try \{\s*await writeCatalogCache/);
assert.doesNotMatch(search, /refreshLeasedSearchFacets\(/);
assert.match(search, /COVE_PUBLIC_PRESENTATION_CACHE\?: PresentationR2Bucket/);

const bundle = await build({
  entryPoints: ["src/features/fore/search-presentation-r2.server.ts"],
  platform: "neutral",
  format: "esm",
  bundle: true,
  write: false,
});
const { readPublicFacetProjection, refreshPublicFacetProjection } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
class FakeR2 {
  data = new Map();
  sequence = 0;
  async get(key) {
    const item = this.data.get(key);
    return item ? { etag: item.etag, size: item.body.length, text: async () => item.body } : null;
  }
  async put(key, value, options) {
    const current = this.data.get(key);
    const condition = options?.onlyIf || {};
    if (condition.etagDoesNotMatch === "*" && current) return null;
    if (condition.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    const item = { etag: "etag-" + ++this.sequence, body: value };
    this.data.set(key, item);
    return { etag: item.etag };
  }
}
const key = "search-facets:v2:" + "a".repeat(64);
const otherKey = "search-facets:v2:" + "b".repeat(64);
const facets = {
  categories: [{ value: "Fiction", count: 42 }],
  languages: [{ value: "en", count: 42 }],
  formats: [{ value: "EPUB", count: 42 }],
  publishers: [],
  series: [],
  availability: [{ value: "available", count: 42 }],
  price: { currency: "USD", min: 0, max: 1200 },
};
const r2 = new FakeR2();
let now = 1_000_000;
const clock = () => now;
assert.equal(await readPublicFacetProjection(r2, key, now), null);

let release;
const gate = new Promise((resolve) => (release = resolve));
let begun;
const started = new Promise((resolve) => (begun = resolve));
let computed = 0;
const workers = Array.from({ length: 16 }, () =>
  refreshPublicFacetProjection(
    r2,
    key,
    async () => {
      computed++;
      begun();
      await gate;
      return facets;
    },
    clock,
  ),
);
await started;
release();
const results = await Promise.all(workers);
assert.equal(computed, 1, "16 simultaneous miss requests must compute one facet aggregate");
assert.equal(results.filter(Boolean).length, 1, "R2 conditional lease has one owner");
assert.deepEqual(await readPublicFacetProjection(r2, key, now), facets);
assert.equal(await refreshPublicFacetProjection(r2, key, async () => facets, clock), false);
assert.equal(await readPublicFacetProjection(r2, otherKey, now), null);
assert.equal(r2.data.size, 1, "A facet cache may not cross market-scoped hash keys");

// When a slow worker loses its lease, it cannot overwrite the new owner's
// globally visible result, even if it finishes last.
now += 600_001;
let unlockSlow;
const slowGate = new Promise((resolve) => (unlockSlow = resolve));
let signalSlow;
const slowStarted = new Promise((resolve) => (signalSlow = resolve));
const late = refreshPublicFacetProjection(
  r2,
  key,
  async () => {
    signalSlow();
    await slowGate;
    return { ...facets, categories: [{ value: "STALE", count: 1 }] };
  },
  clock,
);
await slowStarted;
now += 45_001;
assert.equal(
  await refreshPublicFacetProjection(
    r2,
    key,
    async () => ({ ...facets, categories: [{ value: "NEW", count: 1 }] }),
    clock,
  ),
  true,
);
unlockSlow();
assert.equal(await late, false, "Expired lease may not overwrite the new R2 etag");
assert.equal((await readPublicFacetProjection(r2, key, now)).categories[0].value, "NEW");

// Failure must unlock without publishing an unverified facet response.
await assert.rejects(
  refreshPublicFacetProjection(
    r2,
    otherKey,
    async () => {
      throw new Error("primary D1 unhealthy");
    },
    clock,
  ),
  /primary D1 unhealthy/,
);
assert.equal(await readPublicFacetProjection(r2, otherKey, now), null);
assert.equal(
  await refreshPublicFacetProjection(r2, otherKey, async () => facets, clock),
  true,
  "A failed probe must not block an independent later attempt",
);
await assert.rejects(
  refreshPublicFacetProjection(r2, "private:account-token", async () => facets, clock),
  /Invalid public presentation cache key/,
);
assert.equal(await readPublicFacetProjection(r2, otherKey, now + 600_001), null);
assert.equal(
  await refreshPublicFacetProjection(
    r2,
    otherKey,
    async () => ({ ...facets, categories: [{ value: "bad", count: -1 }] }),
    () => now + 600_001,
  ).catch(() => false),
  false,
);
console.log(
  "PASS: isolated R2 public facets CAS, 16-way cold lease, stale-owner fencing, expiry, market partition and zero primary-D1 cache writes",
);
