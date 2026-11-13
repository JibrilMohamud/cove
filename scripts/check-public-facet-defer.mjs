import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const publicCache = fs.readFileSync("src/features/fore/public-api-cache.server.ts", "utf8");
const store = fs.readFileSync("src/features/fore/Store.tsx", "utf8");
assert.match(search, /FORE_ASYNC_CATALOG_FACETS === "1"/);
assert.match(search, /!userId &&/);
assert.match(search, /input\.sort === "popular" &&\s*input\.page === 1/);
assert.match(search, /input\.subscription === undefined && input\.library === undefined/);
assert.match(search, /facetsPending: facetState\.pending/);
assert.match(search, /facetState\.pending\s*\?\s*null/);
assert.match(search, /if \(!facetState\.pending\) \{/);
assert.match(search, /for \(const work of deferredFacets \|\| \[\]\)/);
assert.match(search, /refreshLeasedSearchFacets\(db, cacheKey/);
assert.match(api, /catalog\(env, url, searchUserId, storefrontTerritory, execution\)/);
assert.match(api, /facetsPending: result\.facetsPending === true/);
assert.match(publicCache, /path === "\/api\/fore\/catalog" && data\.facetsPending === true/);
assert.match(
  store,
  /refetchInterval: \(query\) => \(query\.state\.data\?\.facetsPending \? 5_000 : false\)/,
);

// Execute the real distributed D1 lease under concurrent visitor traffic.
const bundle = await build({
  entryPoints: ["src/features/fore/search-facet-refresh-lease.server.ts"],
  platform: "neutral",
  format: "esm",
  bundle: true,
  write: false,
});
const { refreshLeasedSearchFacets } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  "CREATE TABLE api_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER NOT NULL)",
);
const db = {
  prepare(sql) {
    return {
      bind(...params) {
        return {
          async first() {
            return sqlite.prepare(sql).get(...params) || null;
          },
          async run() {
            return sqlite.prepare(sql).run(...params);
          },
        };
      },
    };
  },
};
let now = Date.now();
const clock = () => now;
const key = "search-facets:v2:" + "a".repeat(64);
let unlock;
const gate = new Promise((resolve) => {
  unlock = resolve;
});
let started;
const starting = new Promise((resolve) => {
  started = resolve;
});
let queries = 0;
const jobs = Array.from({ length: 16 }, () =>
  refreshLeasedSearchFacets(
    db,
    key,
    async () => {
      queries += 1;
      started();
      await gate;
    },
    clock,
  ),
);
await starting;
unlock();
const values = await Promise.all(jobs);
assert.equal(queries, 1, "16 simultaneous cold misses must run one SQL aggregate");
assert.equal(values.filter(Boolean).length, 1, "Exactly one lease owner can compute");
assert.equal(
  sqlite.prepare("SELECT COUNT(*) n FROM api_cache").get().n,
  0,
  "No completed lease may remain",
);

// Ownership survives expiration: an expired worker cannot release the new lock.
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
let begunFirst;
const firstStarted = new Promise((resolve) => {
  begunFirst = resolve;
});
const staleOwner = refreshLeasedSearchFacets(
  db,
  key,
  async () => {
    begunFirst();
    await firstGate;
  },
  clock,
);
await firstStarted;
now += 45_001;
let releaseSecond;
const secondGate = new Promise((resolve) => {
  releaseSecond = resolve;
});
let begunSecond;
const secondStarted = new Promise((resolve) => {
  begunSecond = resolve;
});
const currentOwner = refreshLeasedSearchFacets(
  db,
  key,
  async () => {
    begunSecond();
    await secondGate;
  },
  clock,
);
await secondStarted;
releaseFirst();
await staleOwner;
assert.equal(
  sqlite.prepare("SELECT COUNT(*) n FROM api_cache").get().n,
  1,
  "Expired worker must not delete replacement owner's lease",
);
releaseSecond();
await currentOwner;
assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM api_cache").get().n, 0);

await assert.rejects(
  refreshLeasedSearchFacets(db, "private:secret", async () => {}, clock),
  /Invalid public facet cache key/,
);
sqlite.close();
console.log(
  "PASS: public facet deferral is opt-in and display-only; 16-way lease, takeover and noncacheable shells preserve live rights and totals",
);
