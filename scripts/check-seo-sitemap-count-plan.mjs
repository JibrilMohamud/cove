import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Source-verified, in-memory SQL equivalence check for the published-work
 * sitemap count. Never contacts production D1, performs migrations or
 * changes legal/retail eligibility.
 */
const source = readFileSync("src/features/fore/seo.server.ts", "utf8");
const branch = source.split('else if (kind === "works")')[1];
assert.ok(branch, "SEO works count must exist");
const ticks = String.fromCharCode(96);
const optimized = branch.split(ticks)[1];
assert.ok(optimized && optimized.startsWith("SELECT COUNT(*) n FROM works w WHERE"), "expected EXISTS count plan");
assert.match(optimized, /EXISTS\s*\(/);
assert.doesNotMatch(optimized, /COUNT\s*\(\s*DISTINCT/i);
assert.match(optimized, /w\.canonical_status<>'redirected'/);
assert.match(optimized, /p\.source_name<>'upload'/);

const original = "SELECT COUNT(DISTINCT w.id) n FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND w.canonical_status<>'redirected'";
const db = new DatabaseSync(":memory:");
try {
  db.exec([
    "CREATE TABLE works (id TEXT PRIMARY KEY, canonical_status TEXT);",
    "CREATE TABLE editions (id TEXT PRIMARY KEY, work_id TEXT);",
    "CREATE TABLE products (id TEXT PRIMARY KEY, edition_id TEXT, storefront_status TEXT, source_name TEXT);",
    "CREATE INDEX idx_editions_work ON editions(work_id);",
    "CREATE INDEX idx_products_edition ON products(edition_id);",
  ].join("\n"));

  const putWork = db.prepare("INSERT INTO works(id,canonical_status) VALUES(?,?)");
  const putEdition = db.prepare("INSERT INTO editions(id,work_id) VALUES(?,?)");
  const putProduct = db.prepare("INSERT INTO products(id,edition_id,storefront_status,source_name) VALUES(?,?,?,?)");
  for (const [id, state] of [
    ["w1","canonical"], ["w2","canonical"], ["w3","redirected"],
    ["w4","canonical"], ["w5","canonical"], ["w6",null],
  ]) putWork.run(id, state);
  for (const [id, work] of [
    ["e1","w1"], ["e2","w1"], ["e3","w2"], ["e4","w3"],
    ["e5","w4"], ["e6","w5"], ["e7","w6"],
  ]) putEdition.run(id, work);
  for (const [id, edition, status, sourceName] of [
    ["p1","e1","active","gutenberg"],
    ["p2","e2","active","publisher-api"],
    ["p3","e3","active","gutenberg"],
    ["p4","e4","active","gutenberg"],
    ["p5","e5","active","upload"],
    ["p6","e6","inactive","gutenberg"],
    ["p7","e7","active","gutenberg"],
  ]) putProduct.run(id, edition, status, sourceName);

  function equals(stage, expected) {
    const baseline = Number(db.prepare(original).get().n);
    const candidate = Number(db.prepare(optimized).get().n);
    assert.equal(candidate, baseline, stage + ": count parity");
    assert.equal(candidate, expected, stage + ": expected count");
  }
  equals("two published works despite duplicate products", 2);
  db.prepare("UPDATE products SET storefront_status='inactive' WHERE id IN ('p1','p2')").run();
  equals("withdrawn work stops counting immediately", 1);
  db.prepare("UPDATE products SET source_name='upload' WHERE id='p3'").run();
  equals("personal upload excluded", 0);
  db.prepare("UPDATE products SET source_name='publisher-api',storefront_status='active' WHERE id='p5'").run();
  equals("newly active work counted immediately", 1);
  db.prepare("UPDATE works SET canonical_status='redirected' WHERE id='w4'").run();
  equals("redirected work excluded immediately", 0);

  const plan = db.prepare("EXPLAIN QUERY PLAN " + optimized).all().map((r) => r.detail).join("\n");
  assert.match(plan, /CORRELATED SCALAR SUBQUERY/i, "planner should short-circuit matching works");
  console.log("PASS: indexed EXISTS preserves exact sitemap works count, exclusion and withdrawal parity");
} finally {
  db.close();
}
