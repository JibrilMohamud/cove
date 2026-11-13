import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const source = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
assert.match(source, /FORE_POPULAR_RIGHTS_SHORTLIST === "1"/);
assert.match(source, /!userId &&/);
assert.match(source, /input\.sort === "popular" &&/);
assert.match(source, /input\.page === 1 &&/);
assert.match(source, /input\.limit <= 24 &&/);
assert.match(source, /input\.subscription === undefined &&/);
assert.match(source, /input\.library === undefined &&/);
assert.match(source, /input\.availability === "available" &&/);
assert.match(
  source,
  /firstPagePopularRightsShortlist\(\s*env\.DB,\s*part,\s*progressive \? input\.limit \+ 1 : input\.limit/,
);
assert.match(
  source,
  /if \(verified\) \{\s*hasVerifiedNextPageWitness = progressive;\s*return \{ results: verified\.slice\(0, input\.limit\)/,
);
assert.match(source, /const plan = await rankedCandidatePlan/);
assert.match(source, /const scoped = rightsScopedCachedPageQuery\(part, ids\)/);

const bundle = await build({
  entryPoints: ["src/features/fore/search-popular-shortlist.server.ts"],
  platform: "neutral",
  format: "esm",
  bundle: true,
  write: false,
});
const { firstPagePopularRightsShortlist: shortlist } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const sql = new DatabaseSync(":memory:");
try {
  sql.exec(`
    CREATE TABLE catalog_search_documents(
      product_id TEXT PRIMARY KEY, fore_bestseller_score INTEGER,
      external_book_id TEXT, suppressed INTEGER, availability TEXT, currency TEXT
    );
    CREATE INDEX idx_search_popular_stable ON catalog_search_documents(
      fore_bestseller_score DESC, external_book_id, product_id
    );
    CREATE TABLE products(
      id TEXT PRIMARY KEY,edition_id TEXT,storefront_status TEXT,source_name TEXT
    );
    CREATE TABLE editions(id TEXT PRIMARY KEY,publisher_id TEXT,release_status TEXT);
    CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE retail_product_availability_rows(product_id TEXT,territory_code TEXT);
    CREATE INDEX idx_rpa ON retail_product_availability_rows(product_id,territory_code);
  `);
  const insert = {
    d: sql.prepare("INSERT INTO catalog_search_documents VALUES(?,?,?,?,?,?)"),
    p: sql.prepare("INSERT INTO products VALUES(?,?,?,?)"),
    e: sql.prepare("INSERT INTO editions VALUES(?,?,?)"),
    rights: sql.prepare("INSERT INTO retail_product_availability_rows VALUES(?,?)"),
  };
  for (let i = 0; i < 200; i++) {
    const id = "p" + String(i).padStart(4, "0");
    insert.d.run(id, 200 - i, id, i % 17 === 0 ? 1 : 0, "available", "USD");
    insert.p.run(id, "e" + id, i % 19 === 0 ? "paused" : "active", "gutenberg");
    insert.e.run("e" + id, null, "available");
    if (i % 11 !== 0) insert.rights.run(id, "US");
  }
  const db = {
    prepare(statement) {
      let args = [];
      return {
        bind(...params) {
          args = params;
          return this;
        },
        async all() {
          return { results: sql.prepare(statement).all(...args) };
        },
      };
    },
  };
  const where = [
    "p.storefront_status='active'",
    "p.source_name<>'upload'",
    "d.suppressed=0",
    "e.release_status IN ('available','preorder')",
    "d.availability=?",
    "EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))",
    "d.currency=?",
  ];
  const scope = {
    prefix: "",
    from: `catalog_search_documents d INDEXED BY idx_search_popular_stable
      CROSS JOIN products p ON p.id=d.product_id
      CROSS JOIN editions e ON e.id=p.edition_id
      LEFT JOIN publishers pub ON pub.id=e.publisher_id`,
    where,
    binds: ["available", "US", "USD"],
    hasFts: false,
  };
  const full = (territory = "US", currency = "USD") =>
    sql
      .prepare(
        `SELECT d.product_id FROM ${scope.from}
         WHERE ${where.join(" AND ")}
         ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
         LIMIT 24 OFFSET 0`,
      )
      .all("available", territory, currency)
      .map((row) => row.product_id);
  const fast = await shortlist(db, scope, 24);
  assert.ok(fast, "Dense legal market must produce complete verified first page");
  assert.deepEqual(
    fast,
    full(),
    "Bounded current-rights shortlist must preserve exact SQL ranking",
  );
  assert.deepEqual(await shortlist(db, scope, 24), fast, "Warm reads remain exact");
  assert.equal(await shortlist(db, { ...scope, hasFts: true }, 24), null);
  assert.deepEqual(
    (await shortlist(db, scope, 25))?.slice(0, 24),
    full(),
    "The 25th rights-verified book may prove Next without a catalog-wide COUNT",
  );
  assert.equal(await shortlist(db, scope, 26), null);

  // Revoke high-ranked products: every resulting page must immediately
  // exclude them; neither a cached shortlist nor a stale right can grant.
  for (let i = 0; i < 8; i++) {
    const id = "p" + String(i).padStart(4, "0");
    sql.prepare("DELETE FROM retail_product_availability_rows WHERE product_id=?").run(id);
  }
  assert.deepEqual(await shortlist(db, scope, 24), full(), "Rights withdrawal must be immediate");

  // Insufficient verified IDs inside the top 96: the fast path may NOT
  // invent a partial page or skip eligible lower-ranked books.
  for (let i = 0; i < 96; i++) {
    const id = "p" + String(i).padStart(4, "0");
    sql.prepare("DELETE FROM retail_product_availability_rows WHERE product_id=?").run(id);
  }
  assert.equal(await shortlist(db, scope, 24), null, "Sparse market requires original full query");
  assert.equal(full().length, 24, "Original fallback retains lower-ranked eligible books");

  // Different territory/currency can never borrow cached US eligibility.
  assert.equal(await shortlist(db, { ...scope, binds: ["available", "GB", "USD"] }, 24), null);
  assert.equal(await shortlist(db, { ...scope, binds: ["available", "US", "CAD"] }, 24), null);

  // No results from a failed primary rights recheck may be returned.
  const broken = {
    prepare(statement) {
      if (statement.includes("WITH selected(product_id)"))
        throw new Error("Primary territorial rights are unavailable");
      return db.prepare(statement);
    },
  };
  await assert.rejects(shortlist(broken, scope, 24), /Primary territorial rights are unavailable/);
  console.log(
    "PASS: real bounded popularity shortlist equals full ranked SQL, withdraws rights immediately, rejects sparse and failed primary checks",
  );
} finally {
  sql.close();
}
