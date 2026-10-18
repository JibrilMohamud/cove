import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

const searchSource = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const from = searchSource.indexOf("async function loadChannelEligibility(");
const end = searchSource.indexOf("\nfunction applyChannelEligibility(", from);
assert.ok(from > 0 && end > from, "Must execute the real production search eligibility function");
const selector = searchSource.slice(from, end);
assert.match(selector, /product_channel_availability/);
assert.match(selector, /EXISTS \(/);
assert.match(selector, /idx_rights_secondary_channel_potential/);
assert.match(selector, /subscription_permitted=1 OR library_permitted=1/);
const { code } = await transform(
  selector.replace(
    "async function loadChannelEligibility(",
    "export async function loadChannelEligibility(",
  ),
  { loader: "ts", format: "esm" },
);
const { loadChannelEligibility } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,storefront_status TEXT);
    CREATE TABLE editions(id TEXT PRIMARY KEY,drm_status TEXT);
    CREATE TABLE rights_grants(
      id TEXT PRIMARY KEY, edition_id TEXT, sales_channel TEXT, status TEXT,
      decision TEXT, subscription_permitted INTEGER, library_permitted INTEGER
    );
    CREATE TABLE rights_grant_territories(grant_id TEXT, territory_code TEXT);
    CREATE VIEW product_channel_availability AS
    WITH effective_grants AS (
      SELECT g.*, 'retail' AS effective_sales_channel FROM rights_grants g WHERE g.sales_channel='retail'
      UNION ALL
      SELECT g.*, 'subscription' AS effective_sales_channel FROM rights_grants g
        WHERE g.sales_channel='subscription' OR (g.sales_channel='retail' AND g.subscription_permitted=1)
      UNION ALL
      SELECT g.*, 'library' AS effective_sales_channel FROM rights_grants g
        WHERE g.sales_channel='library' OR (g.sales_channel='retail' AND g.library_permitted=1)
    )
    SELECT DISTINCT p.id product_id, e.effective_sales_channel sales_channel,
      t.territory_code territory_code
    FROM products p
    JOIN effective_grants e ON e.edition_id=p.edition_id AND e.status='active'
    JOIN rights_grant_territories t ON t.grant_id=e.id
    WHERE p.storefront_status='active' AND e.decision='allow'
      AND NOT EXISTS (
        SELECT 1 FROM effective_grants deny
        JOIN rights_grant_territories dt ON dt.grant_id=deny.id
        WHERE deny.edition_id=p.edition_id AND deny.status='active' AND deny.decision='deny'
          AND deny.effective_sales_channel=e.effective_sales_channel
          AND dt.territory_code=t.territory_code
      );
  `);
  const products = db.prepare("INSERT INTO products VALUES (?,?,'ebook','active')");
  const grants = db.prepare("INSERT INTO rights_grants VALUES (?,?,?,?,?,?,?)");
  const territories = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
  for (let n = 1; n <= 1500; n++) {
    products.run("book-" + n, "edition-" + n);
    grants.run("retail-" + n, "edition-" + n, "retail", "active", "allow", 0, 0);
    territories.run("retail-" + n, "US");
  }
  db.exec(fs.readFileSync("drizzle/0077_secondary_channel_potential_index.sql", "utf8"));
  const ids = ["book-1", "book-2", "book-3", "book-500", "book-1499"];
  const dbAdapter = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: db.prepare(sql).all(...args) };
            },
          };
        },
      };
    },
  };
  const original = (country) =>
    db
      .prepare(
        `SELECT product_id,sales_channel FROM product_channel_availability
      WHERE territory_code=upper(?) AND sales_channel IN ('subscription','library')
        AND product_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(country, ...ids)
      .map((x) => x.product_id + ":" + x.sales_channel)
      .sort();
  const check = async (country) => {
    const before = original(country);
    const actual = [...(await loadChannelEligibility(dbAdapter, ids, country))].sort();
    assert.deepEqual(actual, before, "Original legal view results differ for " + country);
  };
  for (const country of ["US", "CA", "GB"]) await check(country);
  // As new channel rights are granted, the negative gate must immediately
  // return to the exact current legal view, without a rights/eligibility cache.
  grants.run("subscription-1", "edition-1", "subscription", "active", "allow", 0, 0);
  territories.run("subscription-1", "US");
  grants.run("library-2", "edition-2", "retail", "active", "allow", 0, 1);
  territories.run("library-2", "CA");
  for (const country of ["US", "CA", "GB"]) await check(country);
  grants.run("deny-subscription-1", "edition-1", "subscription", "active", "deny", 0, 0);
  territories.run("deny-subscription-1", "US");
  db.prepare("UPDATE rights_grants SET status='revoked' WHERE id='library-2'").run();
  for (const country of ["US", "CA", "GB"]) await check(country);
  db.prepare(
    "UPDATE rights_grants SET decision='allow',status='active' WHERE id='deny-subscription-1'",
  ).run();
  await check("US");
  const sample = dbAdapter.prepare(
    `SELECT 1 FROM rights_grants INDEXED BY idx_rights_secondary_channel_potential
    WHERE status='active' AND (sales_channel IN ('subscription','library')
      OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1))) LIMIT 1`,
  );
  assert.ok((await sample.bind().all()).results.length, "Live grant candidate probe must be valid");
  const sqlPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN " +
        "SELECT 1 FROM rights_grants INDEXED BY idx_rights_secondary_channel_potential WHERE status='active' AND (sales_channel IN ('subscription','library') OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1))) LIMIT 1",
    )
    .all();
  assert.ok(sqlPlan.some((x) => x.detail.includes("idx_rights_secondary_channel_potential")));
  console.log(
    "Channel negative gate: live retail permissions, direct grants, denials, revocations, US/CA/GB PASS",
  );
} finally {
  db.close();
}
