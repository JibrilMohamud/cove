import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const source = fs.readFileSync("src/features/fore/search-counts-cache.server.ts", "utf8");
const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
assert.match(source, /const PREFIX = "search-counts:v1:"/);
assert.match(search, /presentationSearchCount\(env.DB, input, expression, countLive\)/);
assert.match(search, /!input.query && !part.hasFts/);
assert.match(search, /rightsScopedCachedPageQuery\(part, cached.ids\)/);
assert.match(search, /retail_product_availability_rows/);
assert.match(search, /const runIds = async/);
assert.match(search, /const presentationDb = replicaEligiblePresentationRead\(env.DB\)/);
assert.match(search, /const row = await presentationDb\.prepare\(/);
assert.match(search, /return env.DB\.prepare\(sql\)/);
assert.match(search, /canonicalBooksByProductIds\(env.DB, ids\)/);

const result = await build({
  entryPoints: ["src/features/fore/search-counts-cache.server.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
});
const { publicSearchCountIdentity, presentationSearchCount } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
);

const replicaBundle = await build({
  entryPoints: ["src/features/fore/presentation-replica.server.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
});
const { replicaEligiblePresentationRead } = await import(
  "data:text/javascript;base64," + Buffer.from(replicaBundle.outputFiles[0].text).toString("base64")
);
let selected = null;
const replica = {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first() {
        return { count: 17 };
      },
    };
  },
  async batch() {},
};
const primary = {
  prepare() {
    throw Error("The presentation COUNT must not hit primary when D1 Sessions exist");
  },
  async batch() {},
  withSession(mode) {
    selected = mode;
    return replica;
  },
};
assert.equal(replicaEligiblePresentationRead(primary), replica);
assert.equal(selected, "first-unconstrained");
const fallback = { prepare() {}, async batch() {} };
assert.equal(replicaEligiblePresentationRead(fallback), fallback);

const scope = {
  query: "",
  territory: "US",
  currency: "USD",
  languages: ["en"],
  categories: [],
  subscription: undefined,
  library: undefined,
  sort: "popular",
  page: 1,
  limit: 24,
};
const id = (input = scope, expression = "") => publicSearchCountIdentity(input, expression);
for (const sort of ["popular", "added", "rating", "title"]) {
  for (const page of [1, 2, 99]) {
    assert.equal(id({ ...scope, sort, page, limit: 120 }), id());
  }
}
const populations = ["coming_soon", "released", "published"];
assert.equal(
  new Set([id(), ...populations.map((sort) => id({ ...scope, sort }))]).size,
  4,
  "Eligibility-changing sorts must not share the ordinary browse count",
);
for (const change of [
  { territory: "CA" },
  { currency: "CAD" },
  { categories: ["Fantasy"] },
  { languages: ["fr"] },
  { query: "ocean" },
  { subscription: true },
  { library: false },
]) {
  assert.notEqual(id({ ...scope, ...change }), id(), "Country/filter rights scopes must not mix");
}
assert.notEqual(id(scope, "star"), id(scope, "ocean"), "FTS scope is unique");

const sql = new DatabaseSync(":memory:");
try {
  sql.exec(
    "CREATE TABLE api_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER NOT NULL)",
  );
  const db = {
    prepare(q) {
      const stmt = sql.prepare(q);
      return {
        bind(...params) {
          return {
            async first() {
              return stmt.get(...params) ?? null;
            },
            async run() {
              return stmt.run(...params);
            },
          };
        },
      };
    },
    async batch(queries) {
      for (const query of queries) await query.run();
    },
  };
  // Use a wall-clock epoch: writeCatalogCache intentionally uses Date.now() for pruning.
  let time = Date.now();
  const clock = () => time;
  let liveCalls = 0;
  const live = (result) => async () => {
    liveCalls++;
    return result;
  };
  assert.equal(await presentationSearchCount(db, scope, "", live(45000), clock), 45000);
  assert.equal(
    await presentationSearchCount(db, { ...scope, sort: "added", page: 6 }, "", live(2), clock),
    45000,
  );
  assert.equal(liveCalls, 1, "Sort and pagination must reuse only the public count");
  assert.equal(
    await presentationSearchCount(db, { ...scope, territory: "CA" }, "", live(0), clock),
    0,
  );
  assert.equal(liveCalls, 2, "A different market must independently compute");
  // Warm ordinary browsing, then request all three distinct release views.
  // A wrong cross-sort hit returns 45000 here without calling live().
  for (const [sort, expected] of [
    ["coming_soon", 2],
    ["released", 44998],
    ["published", 40000],
  ]) {
    assert.equal(
      await presentationSearchCount(db, { ...scope, sort }, "", live(expected), clock),
      expected,
    );
  }
  assert.equal(liveCalls, 5, "Each release population computes its own number");
  const rows = sql.prepare("SELECT key,body FROM api_cache").all();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.key.startsWith("search-counts:v1:")));
  assert.ok(rows.every((r) => /^\d+$/.test(r.body)));
  assert.ok(rows.every((r) => !r.body.includes("product_id") && !r.body.includes("user_id")));
  time += 600_001;
  assert.equal(await presentationSearchCount(db, scope, "", live(45001), clock), 45001);
  assert.equal(liveCalls, 6, "Expired presentation number recomputes the live scoped count");

  sql.prepare("UPDATE api_cache SET body=?").run('{"not":"a-number"}');
  assert.equal(await presentationSearchCount(db, scope, "", live(45002), clock), 45002);
  assert.equal(liveCalls, 7, "Corrupt cache cannot grant access or suppress live counts");

  const brokenDb = {
    prepare() {
      throw Error("D1 cache unavailable");
    },
    async batch() {
      throw Error("D1 cache unavailable");
    },
  };
  assert.equal(await presentationSearchCount(brokenDb, scope, "", live(40000), clock), 40000);
  assert.equal(liveCalls, 8, "Missing cache recomputes on primary");
  await assert.rejects(
    presentationSearchCount(brokenDb, scope, "", live(-5), clock),
    /Invalid public search count/,
  );
  console.log(
    "Public count presentation cache: market/isolation, paging/sort, TTL, stale-count safety, invalid cache PASS",
  );
} finally {
  sql.close();
}
