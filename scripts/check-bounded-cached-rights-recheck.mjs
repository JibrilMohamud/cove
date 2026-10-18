import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/rights-scoped-cache-page.ts", "utf8");
const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { rightsScopedCachedPageQuery } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
assert.match(search, /rightsScopedCachedPageQuery\(part, cached.ids\)/);
assert.match(search, /rightsScopedCachedPageQuery\(part, ids\)/);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE products(
      id TEXT PRIMARY KEY, edition_id TEXT, storefront_status TEXT, source_name TEXT
    );
    CREATE TABLE editions(id TEXT PRIMARY KEY, release_status TEXT, publisher_id TEXT);
    CREATE TABLE publishers(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE catalog_search_documents(
      product_id TEXT PRIMARY KEY, external_book_id TEXT, suppressed INTEGER,
      availability TEXT, currency TEXT, fore_bestseller_score REAL
    );
    CREATE INDEX idx_search_popular_stable ON catalog_search_documents(
      fore_bestseller_score DESC, external_book_id ASC, product_id ASC
    );
    CREATE TABLE rights_grants(
      id TEXT PRIMARY KEY, edition_id TEXT, status TEXT, decision TEXT
    );
    CREATE TABLE rights_grant_territories(grant_id TEXT, territory_code TEXT);
    CREATE VIEW retail_product_availability_rows AS
      SELECT p.id AS product_id, territory_code FROM products p
      JOIN rights_grants g ON g.edition_id=p.edition_id AND g.status='active'
        AND g.decision='allow'
      JOIN rights_grant_territories t ON t.grant_id=g.id
      WHERE NOT EXISTS(
        SELECT 1 FROM rights_grants deny
        JOIN rights_grant_territories dt ON dt.grant_id=deny.id
        WHERE deny.edition_id=p.edition_id AND deny.status='active'
          AND deny.decision='deny' AND dt.territory_code=t.territory_code
      );
  `);
  const product = db.prepare("INSERT INTO products VALUES (?,?,?,?)");
  const edition = db.prepare("INSERT INTO editions VALUES (?,?,?)");
  const document = db.prepare("INSERT INTO catalog_search_documents VALUES (?,?,?,?,?,?)");
  const grant = db.prepare("INSERT INTO rights_grants VALUES (?,?,?,?)");
  const region = db.prepare("INSERT INTO rights_grant_territories VALUES (?,?)");
  for (let n = 1; n <= 2200; n++) {
    const id = "book-" + String(n).padStart(5, "0");
    const active = n % 23 !== 0;
    product.run(id, id, active ? "active" : "draft", n % 29 === 0 ? "upload" : "gutenberg");
    edition.run(id, n % 37 === 0 ? "archived" : "available", null);
    document.run(
      id,
      "source-" + n,
      n % 41 === 0 ? 1 : 0,
      "available",
      n % 17 === 0 ? "CAD" : "USD",
      n % 11,
    );
    grant.run("grant-" + id, id, n % 19 === 0 ? "revoked" : "active", "allow");
    region.run("grant-" + id, "US");
    if (n % 7 === 0) region.run("grant-" + id, "CA");
    if (n % 31 === 0) {
      grant.run("deny-" + id, id, "active", "deny");
      region.run("deny-" + id, "US");
    }
  }
  const part = {
    prefix: "",
    from: `catalog_search_documents d INDEXED BY idx_search_popular_stable
      CROSS JOIN products p ON p.id=d.product_id
      CROSS JOIN editions e ON e.id=p.edition_id
      LEFT JOIN publishers pub ON pub.id=e.publisher_id`,
    where: [
      "p.storefront_status='active'",
      "p.source_name<>'upload'",
      "d.suppressed=0",
      "e.release_status IN ('available','preorder')",
      "d.availability=?",
      "EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))",
      "d.currency=?",
    ],
    hasFts: false,
    binds: ["available", "US", "USD"],
  };
  const ids = Array.from({ length: 12 }, (_, k) => "book-" + String((k + 1) * 7).padStart(5, "0"));
  const original = (x) =>
    `SELECT d.product_id FROM ${part.from} WHERE ${part.where.join(" AND ")}
      AND d.product_id IN (${x.map(() => "?").join(",")})`;
  for (const territory of ["US", "CA", "GB"]) {
    for (const currency of ["USD", "CAD"]) {
      const scoped = { ...part, binds: ["available", territory, currency] };
      for (const sample of [ids, ids.slice(0, 1), [...ids, "book-not-found"]]) {
        const plan = rightsScopedCachedPageQuery(scoped, sample);
        const before = db.prepare(original(sample)).all(...scoped.binds, ...sample);
        const after = db.prepare(plan.sql).all(...plan.binds);
        assert.deepEqual(
          after.map((x) => x.product_id).sort(),
          before.map((x) => x.product_id).sort(),
          `Cached page rights changed: ${territory}, ${currency}, ${sample.length}`,
        );
      }
    }
  }
  const next = rightsScopedCachedPageQuery(part, ids);
  const explain = db.prepare("EXPLAIN QUERY PLAN " + next.sql).all(...next.binds);
  assert.ok(explain.some((x) => String(x.detail).includes("selected")));
  assert.ok(
    explain.some((x) =>
      /SEARCH d USING INDEX sqlite_autoindex_catalog_search_documents_1/.test(x.detail),
    ),
    "The result page must seek only the requested product IDs",
  );
  assert.ok(
    !explain.some((x) => /SCAN d USING INDEX idx_search_popular_stable/.test(x.detail)),
    "Cached page rights must not walk the entire sorted catalog",
  );

  db.prepare("UPDATE rights_grants SET status='revoked' WHERE edition_id=?").run(ids[0]);
  db.prepare("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?").run(ids[1]);
  assert.deepEqual(
    db
      .prepare(next.sql)
      .all(...next.binds)
      .map((x) => x.product_id)
      .sort(),
    db
      .prepare(original(ids))
      .all(...part.binds, ...ids)
      .map((x) => x.product_id)
      .sort(),
    "Revocation and suppression must immediately affect the selected IDs",
  );
  assert.throws(() => rightsScopedCachedPageQuery(part, []), /Invalid bounded/);
  assert.throws(
    () => rightsScopedCachedPageQuery(part, Array(101).fill("book")),
    /Invalid bounded/,
  );
  const fts = rightsScopedCachedPageQuery(
    {
      ...part,
      prefix: "WITH matched AS (SELECT product_id FROM search_fts)",
      hasFts: true,
      from: "matched m JOIN catalog_search_documents d ON d.product_id=m.product_id",
      binds: ["full-text-term", ...part.binds],
    },
    ids.slice(0, 2),
  );
  assert.match(fts.sql, /^WITH matched AS/);
  assert.doesNotMatch(fts.sql, /selected\(product_id\)/);
  assert.deepEqual(fts.binds, ["full-text-term", ...part.binds, ...ids.slice(0, 2)]);
  console.log(
    "Cached rights page: indexed small-ID seeks, US/CA/GB, currencies, revocations, suppression, FTS bypass PASS",
  );
} finally {
  db.close();
}
