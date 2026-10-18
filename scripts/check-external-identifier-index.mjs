import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = fs.readFileSync("drizzle/0078_external_identifier_entity_value.sql", "utf8");
const source = fs.readFileSync("src/features/fore/discovery.server.ts", "utf8");
const start = source.indexOf("SELECT id FROM works WHERE public_id=? OR id=?");
const end = source.indexOf("LIMIT 1", start);
assert.ok(start >= 0 && end > start, "Use actual work-detail identifier SQL");
const query = source.slice(start, end + "LIMIT 1".length);
assert.match(query, /external_identifiers WHERE entity_type='work' AND value=\?/);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE works(id TEXT PRIMARY KEY, public_id TEXT);
    CREATE UNIQUE INDEX idx_works_public_id ON works(public_id) WHERE public_id IS NOT NULL;
    CREATE TABLE catalog_public_aliases(
      entity_type TEXT NOT NULL, alias TEXT NOT NULL, entity_id TEXT NOT NULL,
      PRIMARY KEY(entity_type,alias)
    );
    CREATE TABLE external_identifiers(
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, scheme TEXT NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,scheme)
    );
    CREATE UNIQUE INDEX idx_external_identifiers_lookup
      ON external_identifiers(scheme,value,entity_type);
  `);
  const work = db.prepare("INSERT INTO works VALUES (?,?)");
  const external = db.prepare("INSERT INTO external_identifiers VALUES (?,?,?,?)");
  const alias = db.prepare("INSERT INTO catalog_public_aliases VALUES (?,?,?)");
  for (let n = 1; n <= 8000; n++) {
    const id = "wrk_" + n;
    work.run(id, "public-" + n);
    external.run("work", id, "catalog", "ext-" + n);
  }
  alias.run("work", "legacy-7", "wrk_7");
  const examples = ["wrk_7", "public-7", "legacy-7", "ext-7", "missing",
    "wrk_7000", "ext-7000"];
  const original = examples.map((ref) =>
    db.prepare(query).all(ref, ref, ref, ref),
  );
  const before = db
    .prepare("EXPLAIN QUERY PLAN SELECT entity_id FROM external_identifiers WHERE entity_type='work' AND value=?")
    .all("ext-7");
  assert.ok(before.some((row) => String(row.detail).includes("sqlite_autoindex_external_identifiers_1")));
  db.exec(migration);
  const after = db
    .prepare("EXPLAIN QUERY PLAN SELECT entity_id FROM external_identifiers WHERE entity_type='work' AND value=?")
    .all("ext-7");
  assert.ok(
    after.some((row) => String(row.detail).includes("idx_external_identifiers_entity_value")),
    "The planner must seek exact work identifiers rather than scan the work index",
  );
  assert.ok(
    !after.some((row) => String(row.detail).includes("sqlite_autoindex_external_identifiers_1")),
  );
  for (let i = 0; i < examples.length; i++)
    assert.deepEqual(
      db.prepare(query).all(...Array(4).fill(examples[i])),
      original[i],
      "Canonical ID, public ID, legacy alias or external identifier must remain identical",
    );
  // Both insertions and canonical identifier updates remain immediately visible.
  external.run("work", "wrk_7", "openlibrary", "ol-new-7");
  assert.deepEqual(db.prepare(query).all(...Array(4).fill("ol-new-7")), [{ id: "wrk_7" }]);
  db.prepare("UPDATE external_identifiers SET value='ol-revised-7' WHERE entity_type='work' AND entity_id='wrk_7' AND scheme='openlibrary'").run();
  assert.deepEqual(db.prepare(query).all(...Array(4).fill("ol-new-7")), []);
  assert.deepEqual(db.prepare(query).all(...Array(4).fill("ol-revised-7")), [{ id: "wrk_7" }]);
  console.log("Work ID lookup index: exact resolver parity, covering seek, aliases, insert/update PASS");
} finally {
  db.close();
}
