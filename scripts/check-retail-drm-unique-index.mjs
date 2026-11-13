import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The only permitted difference in the production legal view is replacing
// six lookup forms that are equivalent under the existing UNIQUE key.
// Preserve every grant, withdrawal, contract, territory and offer predicate.
const prior = fs.readFileSync("drizzle/0074_flatten_retail_membership.sql", "utf8");
const migration = fs.readFileSync("drizzle/0092_retail_drm_single_index_lookup.sql", "utf8");
const oldLookup =
  "(SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1)";
const indexedLookup =
  "(SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND da.kind=(CASE WHEN allow.product_format='ebook' THEN 'epub' WHEN allow.product_format='audiobook' THEN 'audio' ELSE NULL END) LIMIT 1)";
assert.equal(prior.split(oldLookup).length - 1, 6);
assert.equal(migration.split(indexedLookup).length - 1, 6);
const from = migration.indexOf("-- Keep the public DISTINCT contract");
assert.ok(from >= 0, "Migration must re-create original full legal view");
assert.equal(
  migration.slice(from),
  prior.replace(
    "DROP VIEW retail_product_availability;\n",
    "DROP VIEW retail_product_availability;\nDROP VIEW retail_product_availability_rows;\n",
  ).replaceAll(oldLookup, indexedLookup),
  "No legal predicate, status, territory, contract or deny clause may change",
);

// The production index is UNIQUE(edition_id,kind). The original OR condition
// therefore selects zero or one row, so sorting cannot change its result.
const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE digital_assets(
      id TEXT PRIMARY KEY,edition_id TEXT NOT NULL,kind TEXT NOT NULL,
      drm_status TEXT,updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_digital_assets_edition_kind
      ON digital_assets(edition_id,kind);
  `);
  const insert = db.prepare("INSERT INTO digital_assets VALUES (?,?,?,?,?)");
  insert.run("a1", "edition-1", "epub", "none", "2026-01-02");
  insert.run("a2", "edition-1", "audio", "lcp", "2026-11-02");
  insert.run("a3", "edition-2", "epub", "adobe", "2026-11-01");
  insert.run("a4", "edition-2", "cover", "watermark", "2026-12-01");
  insert.run("a5", "edition-3", "audio", "social-drm", "2026-10-01");

  const old = db.prepare(
    "SELECT da.drm_status value FROM digital_assets da WHERE da.edition_id=? AND ((?='ebook' AND da.kind='epub') OR (?='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1",
  );
  const indexed = db.prepare(
    "SELECT da.drm_status value FROM digital_assets da WHERE da.edition_id=? AND da.kind=(CASE WHEN ?='ebook' THEN 'epub' WHEN ?='audiobook' THEN 'audio' ELSE NULL END) LIMIT 1",
  );
  for (const edition of ["edition-1", "edition-2", "edition-3", "missing"]) {
    for (const format of ["ebook", "audiobook", "EBOOK", "AUDIOBOOK", "", "hardcover", null]) {
      assert.deepEqual(
        indexed.get(edition, format, format),
        old.get(edition, format, format),
        `Lookup changed for ${edition} / ${String(format)}`,
      );
    }
  }
  for (const status of ["none", "lcp", "adobe", "watermark", "social-drm", null]) {
    db.prepare("UPDATE digital_assets SET drm_status=? WHERE id='a1'").run(status);
    assert.deepEqual(indexed.get("edition-1", "ebook", "ebook"), old.get("edition-1", "ebook", "ebook"));
  }
  const oldPlan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=? AND ((?='ebook' AND da.kind='epub') OR (?='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1",
  ).all("edition-1", "ebook", "ebook");
  const newPlan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=? AND da.kind=(CASE WHEN ?='ebook' THEN 'epub' WHEN ?='audiobook' THEN 'audio' ELSE NULL END) LIMIT 1",
  ).all("edition-1", "ebook", "ebook");
  assert.ok(oldPlan.some((row) => /TEMP B-TREE FOR ORDER BY/.test(String(row.detail))));
  assert.ok(newPlan.some((row) => /idx_digital_assets_edition_kind/.test(String(row.detail))));
  assert.ok(!newPlan.some((row) => /TEMP B-TREE|MULTI-INDEX OR/.test(String(row.detail))));
  // The full migration is then exercised by scripts/check-rights.mjs,
  // which applies every checked-in D1 migration and tests deny/revoke flows.
  console.log("Retail DRM view: exact source-only rewrite, indexed lookup parity, missing assets, unusual formats and all DRM statuses PASS");
} finally {
  db.close();
}
