import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

// Exercise the REAL production query builder against a synthetic legal fixture.
// No fixtures, SQL or generated rights permissions can reach production D1.
const source = fs.readFileSync("src/features/fore/recommendations.server.ts", "utf8");
const start = source.indexOf("async function activeCandidateIds(");
const end = source.indexOf("\nfunction addFeature(", start);
assert.ok(start >= 0 && end > start, "Cannot locate production candidate selector");
const isolated = `const MAX_CANDIDATES = 500;
${source.slice(start, end).replace("async function activeCandidateIds", "export async function activeCandidateIds")}`;
const compiled = await transform(isolated, { loader: "ts", format: "esm", target: "es2022" });
const { activeCandidateIds } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);

const sql = new DatabaseSync(":memory:");
sql.exec(`
  CREATE TABLE products (id TEXT PRIMARY KEY,edition_id TEXT,storefront_status TEXT,source_name TEXT,updated_at TEXT);
  CREATE TABLE editions (id TEXT PRIMARY KEY,release_status TEXT);
  CREATE TABLE recommendation_item_metrics (product_id TEXT PRIMARY KEY,trend_score REAL,popularity_score REAL);
  CREATE TABLE recommendation_regional_item_metrics (territory_code TEXT,product_id TEXT,trend_score REAL,popularity_score REAL);
  CREATE TABLE catalog_search_documents (product_id TEXT PRIMARY KEY,sales_velocity REAL,download_count INTEGER);
  CREATE TABLE rights_grants (id TEXT PRIMARY KEY,edition_id TEXT,sales_channel TEXT,status TEXT);
  CREATE TABLE rights_grant_territories (grant_id TEXT,territory_code TEXT);
  CREATE INDEX test_products_edition ON products(edition_id);
  CREATE INDEX test_rights_grants_edition ON rights_grants(edition_id,sales_channel,status);
  CREATE INDEX test_rights_territory ON rights_grant_territories(territory_code,grant_id);
  CREATE VIEW retail_product_availability_rows AS
    SELECT p.id product_id,rgt.territory_code FROM products p
    JOIN rights_grants rg ON rg.edition_id=p.edition_id
    JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id
    WHERE rg.sales_channel='retail' AND rg.status='active';
  CREATE VIEW retail_product_availability AS
    SELECT DISTINCT product_id,territory_code FROM retail_product_availability_rows;
`);
const putProduct = sql.prepare(
  "INSERT INTO products VALUES (?,?, 'active','gutenberg','2026-10-18')",
);
const putEdition = sql.prepare("INSERT INTO editions VALUES (?,'available')");
const putMetric = sql.prepare("INSERT INTO recommendation_item_metrics VALUES (?,?,?)");
const putGrant = sql.prepare("INSERT INTO rights_grants VALUES (?,?,'retail',?)");
const putTerritory = sql.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
for (let i = 1; i <= 1160; i++) {
  const id = "book-" + String(i).padStart(3, "0");
  putProduct.run(id, id);
  putEdition.run(id);
  putMetric.run(id, 1200 - i, 1200 - i);
  // Three revoked US candidates near the very top, with valid grant records;
  // these must remain ineligible even if the rank-first shortlist includes them.
  const status = i <= 3 ? "revoked" : "active";
  putGrant.run("grant-" + id, id, status);
  putTerritory.run("grant-" + id, "US");
  if (i >= 1120) putTerritory.run("grant-" + id, "CA");
}
const reference = sql.prepare(`
SELECT p.id FROM products p JOIN editions e ON e.id=p.edition_id
LEFT JOIN recommendation_item_metrics m ON m.product_id=p.id
LEFT JOIN recommendation_regional_item_metrics rm ON rm.product_id=p.id AND rm.territory_code=upper(?)
LEFT JOIN catalog_search_documents d ON d.product_id=p.id
WHERE p.storefront_status='active' AND e.release_status IN ('available','preorder')
 AND p.source_name<>'upload'
 AND EXISTS (SELECT 1 FROM retail_product_availability rpa
             WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
ORDER BY COALESCE(rm.trend_score,m.trend_score,d.sales_velocity,0) DESC,
         COALESCE(rm.popularity_score,m.popularity_score,d.download_count,0) DESC,
         p.updated_at DESC,p.id ASC LIMIT ?
`);
function adapter(calls, database = sql) {
  return {
    prepare(statement) {
      return {
        bind(...params) {
          return {
            async all() {
              calls.push(statement);
              return { results: database.prepare(statement).all(...params) };
            },
            async first() {
              calls.push(statement);
              return database.prepare(statement).get(...params);
            },
          };
        },
      };
    },
  };
}
for (const territory of ["US", "CA", "GB"]) {
  for (const limit of [0, 5, 50, 160, 500]) {
    const calls = [];
    const actual = await activeCandidateIds(adapter(calls), territory, limit);
    const expected = reference.all(territory, territory, Math.min(500, limit)).map((row) => row.id);
    assert.deepEqual(actual, expected, `Exact sorted live rights differ for ${territory}/${limit}`);
    if (territory === "US" && limit === 5)
      assert.equal(
        calls.length,
        2,
        "Large market must use grant-count preflight and bounded exact shortlist",
      );
    if ((territory === "CA" || territory === "GB") && limit === 5)
      assert.equal(calls.length, 2, "Sparse rights must force exact complete fallback");
    if (limit === 0) assert.equal(calls.length, 0, "Empty request must not call D1");
  }
}
// A separate ranking snapshot deliberately does not follow later primary
// product state or rights revocations. It must never authorize any result.
const replica = new DatabaseSync(":memory:");
try {
  for (const table of [
    "products",
    "editions",
    "recommendation_item_metrics",
    "recommendation_regional_item_metrics",
    "catalog_search_documents",
  ]) {
    replica.exec(
      sql.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql,
    );
    const rows = sql.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length) {
      const keys = Object.keys(rows[0]);
      const insert = replica.prepare(
        `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      );
      for (const row of rows) insert.run(...keys.map((key) => row[key]));
    }
  }
  const primaryCalls = [],
    replicaCalls = [];
  let sessions = 0;
  const primary = adapter(primaryCalls);
  const routed = {
    ...primary,
    withSession(constraint) {
      assert.equal(constraint, "first-unconstrained");
      sessions++;
      return adapter(replicaCalls, replica);
    },
  };
  for (const limit of [5, 50, 160, 500]) {
    assert.deepEqual(
      await activeCandidateIds(routed, "US", limit),
      reference.all("US", "US", limit).map((row) => row.id),
    );
  }
  assert.ok(
    replicaCalls.every((q) => !/rights_grant|retail_product_availability/.test(q)),
    "Replica reads must be ranking hints only",
  );
  assert.ok(
    primaryCalls.every((q) => !/WITH ranked AS MATERIALIZED/.test(q)),
    "Dense primary reads must not sort the full catalog",
  );
  assert.equal(sessions, 4, "Each request owns a new ranking session");
  // Replica still ranks these highly, but current primary denies both.
  sql.exec("UPDATE rights_grants SET status='revoked' WHERE edition_id='book-004'");
  sql.exec("UPDATE products SET storefront_status='inactive' WHERE id='book-005'");
  assert.equal(
    replica.prepare("SELECT storefront_status FROM products WHERE id='book-005'").get()
      .storefront_status,
    "active",
  );
  const revoked = await activeCandidateIds(routed, "US", 5);
  assert.deepEqual(
    revoked,
    reference.all("US", "US", 5).map((row) => row.id),
  );
  assert.ok(!revoked.includes("book-004") && !revoked.includes("book-005"));
  // Sparse/empty markets must retain the complete primary oracle.
  const beforeSessions = sessions;
  for (const territory of ["CA", "GB"])
    assert.deepEqual(
      await activeCandidateIds(routed, territory, 50),
      reference.all(territory, territory, 50).map((row) => row.id),
    );
  assert.equal(sessions, beforeSessions);
  const unavailable = {
    ...primary,
    withSession() {
      throw Error("replica unavailable");
    },
  };
  assert.deepEqual(await activeCandidateIds(unavailable, "US", 5), revoked);
  // A lagging/empty shortlist is repaired using the complete live primary path.
  replica.exec("UPDATE products SET storefront_status='inactive'");
  assert.deepEqual(await activeCandidateIds(routed, "US", 5), revoked);
  replica.exec("UPDATE products SET storefront_status='active'");
  const failedPrimary = {
    ...routed,
    prepare(q) {
      if (/json_each/.test(q)) throw Error("primary rights unavailable");
      return primary.prepare(q);
    },
  };
  await assert.rejects(activeCandidateIds(failedPrimary, "US", 5), /primary rights unavailable/);
  assert.deepEqual(
    await activeCandidateIds(routed, "US", 5),
    revoked,
    "Failure must not poison recovery",
  );
} finally {
  replica.close();
}
assert.match(source.slice(start, end), /retail_product_availability_rows/);
assert.match(source.slice(start, end), /rights_grant_territories/);
assert.match(source.slice(start, end), /grantCount\?\.grant_count/);
assert.match(source.slice(start, end), /fast\.results\.length === wanted/);
console.log(
  "Recommendation candidates: identical live-rights ranking across US/CA/GB, revocations, sparse markets, empty requests, full-shortlist and exact-fallback branches: PASS",
);
