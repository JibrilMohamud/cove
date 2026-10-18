import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = fs.readFileSync("drizzle/0076_catalog_added_expression_sort.sql", "utf8");
assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_search_added_effective_stable/);
assert.match(
  migration,
  /COALESCE\(product_created_at, first_ingested_at\) DESC,\s*external_book_id DESC,\s*product_id ASC/,
);

// Assert the real search query uses the bounded plan only for result pages,
// never for FTS candidate matching, facet aggregation or global counts.
const source = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const selectorStart = source.indexOf("function rankedCandidateFrom(");
const selectorEnd = source.indexOf("function withoutFacet(", selectorStart);
assert.ok(selectorStart >= 0 && selectorEnd > selectorStart);
const selector = source.slice(selectorStart, selectorEnd);
assert.match(selector, /input\.sort !== "added" \|\| part\.hasFts/);
assert.match(selector, /idx_search_added_effective_stable/);
assert.match(selector, /CROSS JOIN products p/);
assert.match(selector, /CROSS JOIN editions e/);
const idsStart = source.indexOf("const runIds = async () =>");
const countStart = source.indexOf("const runCount = ()", idsStart);
assert.ok(idsStart >= 0 && countStart > idsStart);
assert.match(source.slice(idsStart, countStart), /rankedCandidateFrom\(input, part\)/);
assert.doesNotMatch(
  source.slice(countStart, countStart + 450),
  /rankedCandidateFrom/,
  "Unranked count must not use the forced newest index",
);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE catalog_search_documents(
      product_id TEXT PRIMARY KEY, external_book_id TEXT NOT NULL,
      product_created_at TEXT, first_ingested_at TEXT NOT NULL,
      currency TEXT NOT NULL, availability TEXT NOT NULL, suppressed INTEGER NOT NULL
    );
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL,storefront_status TEXT,source_name TEXT);
    CREATE TABLE editions(id TEXT PRIMARY KEY,release_status TEXT);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,sales_channel TEXT,status TEXT);
    CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT);
    CREATE VIEW retail_product_availability_rows AS
      SELECT p.id product_id, rt.territory_code FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      JOIN rights_grant_territories rt ON rt.grant_id=rg.id
      WHERE rg.status='active' AND rg.sales_channel='retail';
  `);
  const book = db.prepare("INSERT INTO products VALUES (?,?,?,?)");
  const edition = db.prepare("INSERT INTO editions VALUES (?,?)");
  const doc = db.prepare("INSERT INTO catalog_search_documents VALUES (?,?,?,?,?,?,?)");
  const grant = db.prepare("INSERT INTO rights_grants VALUES (?,?,'retail',?)");
  const region = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
  for (let n = 1; n <= 2000; n++) {
    const id = "book-" + String(n).padStart(5, "0");
    const created = n % 17 === 0 ? null : "2026-10-" + String(1 + (n % 18)).padStart(2, "0");
    const first = "2026-09-" + String(1 + (n % 20)).padStart(2, "0");
    book.run(id, id, n % 31 === 0 ? "draft" : "active", n % 29 === 0 ? "upload" : "gutenberg");
    edition.run(id, n % 37 === 0 ? "archived" : "available");
    // Duplicate timestamps and external IDs deliberately exercise stable product-id ties.
    doc.run(
      id,
      "external-" + String(n % 61).padStart(3, "0"),
      created,
      first,
      n % 23 === 0 ? "CAD" : "USD",
      "available",
      n % 41 === 0 ? 1 : 0,
    );
    grant.run("grant-" + id, id, n % 19 === 0 ? "revoked" : "active");
    region.run("grant-" + id, "US");
    if (n % 13 === 0) region.run("grant-" + id, "CA");
  }
  db.exec(migration);
  const storedIndex = db
    .prepare("SELECT sql FROM sqlite_master WHERE name='idx_search_added_effective_stable'")
    .get();
  assert.ok(storedIndex?.sql, "Migration must create the real expression index");

  const clause = `FROM catalog_search_documents d
    JOIN products p ON p.id=d.product_id
    JOIN editions e ON e.id=p.edition_id
    LEFT JOIN publishers pub ON pub.id=e.publisher_id`;
  // Production joins publishers; minimal fixture intentionally adds it too.
  db.exec(
    "CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT); ALTER TABLE editions ADD COLUMN publisher_id TEXT",
  );
  const where = `p.storefront_status='active' AND p.source_name<>'upload'
    AND d.suppressed=0 AND e.release_status IN ('available','preorder')
    AND d.availability=? AND EXISTS(
      SELECT 1 FROM retail_product_availability_rows rpa
      WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?)
    ) AND d.currency=?`;
  const order =
    "COALESCE(d.product_created_at,d.first_ingested_at) DESC,d.external_book_id DESC,d.product_id ASC";
  const oldSql = `SELECT d.product_id ${clause} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const optimizedFrom = `FROM catalog_search_documents d INDEXED BY idx_search_added_effective_stable
    CROSS JOIN products p ON p.id=d.product_id
    CROSS JOIN editions e ON e.id=p.edition_id
    LEFT JOIN publishers pub ON pub.id=e.publisher_id`;
  const nextSql = `SELECT d.product_id ${optimizedFrom} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const plan = db.prepare("EXPLAIN QUERY PLAN " + nextSql).all("available", "US", "USD", 24, 0);
  assert.ok(
    plan.some((row) => String(row.detail).includes("idx_search_added_effective_stable")),
    "Ranked candidates must be scanned by the stable added-date expression index",
  );
  assert.ok(
    !plan.some((row) => String(row.detail).includes("USE TEMP B-TREE FOR ORDER BY")),
    "Added-date candidate ranking must not sort the entire catalog",
  );
  for (const country of ["US", "CA", "GB"]) {
    for (const offset of [0, 24, 48, 200, 800, 1500]) {
      const args = ["available", country, "USD", 24, offset];
      const previous = db.prepare(oldSql).all(...args);
      const updated = db.prepare(nextSql).all(...args);
      assert.deepEqual(
        updated,
        previous,
        `Live-rights order changed in country ${country}, offset ${offset}`,
      );
    }
  }
  // Updates, including a new NULL date and a rights revocation, must remain exact.
  db.prepare("UPDATE catalog_search_documents SET product_created_at=NULL WHERE product_id=?").run(
    "book-00001",
  );
  db.prepare("UPDATE rights_grants SET status='revoked' WHERE edition_id=?").run("book-00002");
  assert.deepEqual(
    db.prepare(nextSql).all("available", "US", "USD", 24, 0),
    db.prepare(oldSql).all("available", "US", "USD", 24, 0),
  );
  console.log(
    "Stable newest/added index: null fallback, ties, revocations, territorial filters and pages PASS",
  );
} finally {
  db.close();
}
