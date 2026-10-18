import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const source = fs.readFileSync("src/features/fore/taxonomy-counts-cache.server.ts", "utf8");
const caller = fs.readFileSync("src/features/fore/taxonomy.server.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const publicCache = fs.readFileSync("src/features/fore/public-api-cache.server.ts", "utf8");
const storefront = fs.readFileSync("src/features/fore/Store.tsx", "utf8");
assert.match(source, /ON CONFLICT\(key\) DO UPDATE SET\s+body=excluded.body/);
assert.match(source, /RETURNING body/);
assert.match(source, /WHERE key=\? AND body=\? AND expires_at>\?/);
assert.match(source, /DELETE FROM api_cache WHERE key=\? AND body=\?/);
assert.match(source, /MAX_STALE_MS = 3_600_000/);
assert.match(caller, /countsPending: countState.pending/);
assert.match(api, /execution\?\.waitUntil \? \(work\) => execution.waitUntil\?\.\(work\)/);
assert.match(publicCache, /path === "\/api\/fore\/taxonomy" && data.countsPending === true/);
assert.match(storefront, /countsPending\?: boolean/);
assert.match(
  storefront,
  /refetchInterval: \(query\) => \(query.state.data\?\.countsPending \? 5_000 : false\)/,
);
assert.match(storefront, /if \(!countsPending && node.count <= 0\) return null/);
assert.match(storefront, /countsPending \|\| child.count > 0/);
assert.match(storefront, /countsPending \|\| n.count > 0/);
assert.match(storefront, /aria-label=\{countsPending \? "Count updating" : undefined\}/);

const output = await build({
  entryPoints: ["src/features/fore/taxonomy-counts-cache.server.ts"],
  platform: "neutral",
  format: "esm",
  bundle: true,
  write: false,
});
const { presentationTaxonomyCounts } = await import(
  "data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64")
);

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  "CREATE TABLE api_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER NOT NULL)",
);
let writes = 0;
const db = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    return {
      bind(...params) {
        return {
          async first() {
            return statement.get(...params) || null;
          },
          async run() {
            const result = statement.run(...params);
            if (sql.includes("INSERT INTO api_cache")) writes += result.changes;
            return result;
          },
        };
      },
    };
  },
  async batch(statements) {
    for (const statement of statements) await statement.run();
  },
};
let now = Date.now();
const clock = () => now;
const jobs = [];
const defer = (job) => jobs.push(job);
let expensiveCalls = 0;
let unblock;
const barrier = new Promise((resolve) => {
  unblock = resolve;
});
const expensive = async () => {
  expensiveCalls++;
  await barrier;
  return [{ node_id: "fiction", product_count: 25 }];
};
const states = [];
const parallel = await Promise.all(
  Array.from({ length: 16 }, () => {
    const state = { pending: false };
    states.push(state);
    return presentationTaxonomyCounts(db, "US", "en", expensive, clock, defer, state);
  }),
);
assert.ok(
  parallel.every((x) => x.length === 0),
  "Cold reads must not block on multi-second UI aggregation",
);
assert.ok(
  states.every((s) => s.pending),
  "Temporary missing labels must be marked",
);
unblock();
await Promise.all(jobs.splice(0));
assert.equal(
  expensiveCalls,
  1,
  "All 16 independent requests must share only one D1-leased refresh",
);
assert.ok(writes >= 1);
let state = { pending: false };
const live = await presentationTaxonomyCounts(db, "US", "en", expensive, clock, defer, state);
assert.equal(live[0]?.product_count, 25);
assert.equal(state.pending, false);
assert.equal(expensiveCalls, 1, "Fresh counts never trigger a second expensive query");

// Refresh proactively near expiration. Respond with current display labels;
// the new aggregation is performed in request-owned waitUntil, never shared
// as a Worker-global I/O promise or an authorization cache.
now += 500_000;
let updateCalls = 0;
const refresh = async () => {
  updateCalls++;
  return [{ node_id: "fiction", product_count: 26 }];
};
state = { pending: false };
const early = await presentationTaxonomyCounts(db, "US", "en", refresh, clock, defer, state);
assert.equal(early[0]?.product_count, 25);
assert.equal(state.pending, false);
await Promise.all(jobs.splice(0));
assert.equal(updateCalls, 1);
assert.equal(
  (await presentationTaxonomyCounts(db, "US", "en", refresh, clock, defer))[0]?.product_count,
  26,
);

// Stale result is presentation-only; it may be reused briefly while one
// refresh recomputes current display counts. Not a customer-rights check.
now += 610_000;
let staleCalls = 0;
const afterExpiry = async () => {
  staleCalls++;
  return [{ node_id: "fiction", product_count: 27 }];
};
state = { pending: false };
const stale = await presentationTaxonomyCounts(db, "US", "en", afterExpiry, clock, defer, state);
assert.equal(stale[0]?.product_count, 26);
assert.equal(state.pending, false);
await Promise.all(jobs.splice(0));
assert.equal(staleCalls, 1);

// No cached value: return pending immediately and populate from live rights.
// The public cache must never store the zero-count temporary response.
state = { pending: false };
const coldCountry = await presentationTaxonomyCounts(
  db,
  "GB",
  "fr",
  async () => [{ node_id: "fiction", product_count: 2 }],
  clock,
  defer,
  state,
);
assert.deepEqual(coldCountry, []);
assert.equal(state.pending, true);
await Promise.all(jobs.splice(0));
state.pending = false;
assert.equal(
  (await presentationTaxonomyCounts(db, "GB", "fr", async () => [], clock, defer, state))[0]
    ?.product_count,
  2,
);
assert.equal(state.pending, false);

// A rejected aggregation releases the lease, so the next request can retry.
state = { pending: false };
assert.deepEqual(
  await presentationTaxonomyCounts(
    db,
    "CA",
    "es",
    async () => {
      throw Error("replica temporarily unavailable");
    },
    clock,
    defer,
    state,
  ),
  [],
);
await Promise.all(jobs.splice(0));
const retried = await presentationTaxonomyCounts(
  db,
  "CA",
  "es",
  async () => [{ node_id: "fiction", product_count: 7 }],
  clock,
  defer,
);
assert.deepEqual(retried, []);
await Promise.all(jobs.splice(0));
assert.equal(
  (await presentationTaxonomyCounts(db, "CA", "es", async () => [], clock, defer))[0]
    ?.product_count,
  7,
);

// Force lease expiration and takeover while the first D1 aggregation is
// STILL IN FLIGHT. Its eventual completion must not publish old results or
// release the newer owner's lock (which could cause a stampede).
let firstStarted;
const firstReady = new Promise((resolve) => {
  firstStarted = resolve;
});
let releaseFirst;
const firstBarrier = new Promise((resolve) => {
  releaseFirst = resolve;
});
let secondStarted;
const secondReady = new Promise((resolve) => {
  secondStarted = resolve;
});
let releaseSecond;
const secondBarrier = new Promise((resolve) => {
  releaseSecond = resolve;
});
state = { pending: false };
await presentationTaxonomyCounts(
  db,
  "DE",
  "de",
  async () => {
    firstStarted();
    await firstBarrier;
    return [{ node_id: "fiction", product_count: 501 }];
  },
  clock,
  defer,
  state,
);
assert.equal(state.pending, true);
await firstReady;
assert.equal(jobs.length, 1);
const firstJob = jobs.shift();

now += 30_001; // lease expiry; current owner has not finished its query
await presentationTaxonomyCounts(
  db,
  "DE",
  "de",
  async () => {
    secondStarted();
    await secondBarrier;
    return [{ node_id: "fiction", product_count: 502 }];
  },
  clock,
  defer,
);
await secondReady;
assert.equal(jobs.length, 1);
const secondJob = jobs.shift();
releaseFirst();
await firstJob;
const leases = sqlite
  .prepare("SELECT body FROM api_cache WHERE key LIKE 'taxonomy-counts-refresh:%'")
  .all();
assert.equal(leases.length, 1, "Expired old worker must not erase the replacement lease");
assert.notEqual(leases[0].body, "refreshing");
releaseSecond();
await secondJob;
assert.equal(
  (await presentationTaxonomyCounts(db, "DE", "de", async () => [], clock, defer))[0]
    ?.product_count,
  502,
  "New lease owner must win; old expired output must never overwrite it",
);
assert.equal(
  sqlite
    .prepare("SELECT COUNT(*) total FROM api_cache WHERE key LIKE 'taxonomy-counts-refresh:%'")
    .get().total,
  0,
  "Lease owners must release their own completed entries",
);

// No caller lacking a waitUntil gets the async/possibly stale path.
const legacy = await presentationTaxonomyCounts(
  db,
  "AU",
  "",
  async () => [{ node_id: "fiction", product_count: 9 }],
  clock,
);
assert.deepEqual(legacy, [{ node_id: "fiction", product_count: 9 }]);
const caches = sqlite.prepare("SELECT key,body FROM api_cache").all();
assert.ok(caches.every((r) => !r.body.includes("product_id")));
sqlite.close();
console.log(
  "Taxonomy presentation lease: 16-request cold stampede, TTL refresh, bounded stale, failure release, market isolation and rights boundaries PASS",
);
