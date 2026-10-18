import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const code = fs.readFileSync("src/features/fore/taxonomy-counts-cache.server.ts", "utf8");
const taxonomy = fs.readFileSync("src/features/fore/taxonomy.server.ts", "utf8");
assert.match(taxonomy, /presentationTaxonomyCounts\(db, territory, language, async \(\) =>/);
assert.match(taxonomy, /retail_product_availability rpa/);
assert.doesNotMatch(code, /product_id|productIds|account_id|user_id/);
const output = await build({
  entryPoints: ["src/features/fore/taxonomy-counts-cache.server.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
});
const { presentationTaxonomyCounts, taxonomyPresentationReadDb } = await import(
  "data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64")
);

// A fresh replica session is allowed ONLY for queryLive's presentation
// aggregation. This must not change the write DB or legal-rights calls.
assert.match(taxonomy, /const countDb = taxonomyPresentationReadDb\(db\)/);
assert.match(taxonomy, /const current = await countDb/);
let sessions = 0;
const replicaSource = {
  withSession(mode) {
    assert.equal(mode, "first-unconstrained");
    sessions++;
    return { session: sessions };
  },
};
assert.deepEqual(taxonomyPresentationReadDb(replicaSource), { session: 1 });
assert.deepEqual(taxonomyPresentationReadDb(replicaSource), { session: 2 });
const localDb = { prepare: () => undefined };
assert.equal(taxonomyPresentationReadDb(localDb), localDb);

const sql = new DatabaseSync(":memory:");
sql.exec(
  "CREATE TABLE api_cache(key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)",
);
const calls = [];
const db = {
  prepare(query) {
    const stmt = sql.prepare(query);
    return {
      bind(...params) {
        return {
          async first() {
            const value = stmt.get(...params);
            return value ?? null;
          },
          async run() {
            return stmt.run(...params);
          },
        };
      },
    };
  },
  async batch(statements) {
    for (const stmt of statements) await stmt.run();
  },
};
let time = 10_000;
const clock = () => time;
const query = (territory, language, count) => async () => {
  calls.push([territory, language]);
  return [{ node_id: "fantasy", product_count: count }];
};

try {
  let result = await presentationTaxonomyCounts(db, "US", "", query("US", "", 12), clock);
  assert.deepEqual(result, [{ node_id: "fantasy", product_count: 12 }]);
  result = await presentationTaxonomyCounts(db, "us", "", query("US", "", 77), clock);
  assert.equal(
    result[0].product_count,
    12,
    "Identical rights country must reuse presentation only",
  );
  assert.equal(calls.length, 1);
  result = await presentationTaxonomyCounts(db, "CA", "", query("CA", "", 0), clock);
  assert.deepEqual(result, [{ node_id: "fantasy", product_count: 0 }]);
  result = await presentationTaxonomyCounts(db, "US", "FR", query("US", "fr", 4), clock);
  assert.equal(result[0].product_count, 4);
  assert.equal(calls.length, 3, "Country and language must have independent cache entries");

  // Counts can be 10-minute-old presentation metadata; no book IDs, rights,
  // downloads, commerce or sale decisions are cached anywhere by this path.
  time += 600_001;
  result = await presentationTaxonomyCounts(db, "US", "", query("US", "", 3), clock);
  assert.equal(result[0].product_count, 3, "Expired presentation count must recompute");
  assert.equal(calls.length, 4);

  const key = sql
    .prepare("SELECT key FROM api_cache WHERE body LIKE '%fantasy%' LIMIT 1")
    .get()?.key;
  assert.ok(key);
  assert.ok(String(key).startsWith("taxonomy-counts:v1:"));
  assert.equal(String(key).includes("US"), false, "Market keys should be normalized hash only");
  const cachedRows = sql.prepare("SELECT key,body FROM api_cache").all();
  assert.ok(cachedRows.every((x) => !x.body.includes("product_id")));
  sql.prepare('UPDATE api_cache SET body=\'{"not":"valid"}\' WHERE key=?').run(key);
  // Invalid cache data forces live recount on its particular key.
  const identity = async () => [{ node_id: "fallback", product_count: 99 }];
  const first = await presentationTaxonomyCounts(db, "US", "", identity, clock);
  assert.ok(first.length > 0, "Corrupted presentation cache must never break rendering");
  const fakeDb = {
    prepare() {
      throw Error("cache unavailable");
    },
    async batch() {
      throw Error("cache unavailable");
    },
  };
  assert.deepEqual(
    await presentationTaxonomyCounts(fakeDb, "GB", "en", identity, clock),
    [{ node_id: "fallback", product_count: 99 }],
    "Cache failures must never turn into authorization or storefront failures",
  );
  console.log(
    "Taxonomy presentation-only cache: locality, TTL, live miss, corrupt cache, missing cache PASS",
  );
} finally {
  sql.close();
}
