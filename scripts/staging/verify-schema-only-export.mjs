import assert from "node:assert/strict";
import fs from "node:fs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) throw Error("Missing protected schema export");
const sql = fs.readFileSync(file, "utf8");
const tables = [
  ...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["\x60\[]?([a-z_][a-z0-9_]*)/gi),
].map((match) => match[1].toLowerCase());
const known = [
  "products",
  "rights_grants",
  "auth_accounts",
  "commerce_orders",
  "soundtrack_recordings",
  "literary_profiles",
  "gutenberg_source_cache",
];
for (const table of known) {
  assert.ok(tables.includes(table), "Missing production schema table: " + table);
}
assert.ok(tables.length >= 350, "Expected substantial production-schema parity");
assert.ok(sql.length > 200000 && sql.length < 10000000, "Unexpected export size");
// --no-data is required by the exporting command. Require that no top-level
// fixture/customer INSERT statements begin a line. Note CREATE TRIGGER
// definitions legitimately contain nested INSERT statements.
assert.doesNotMatch(
  sql,
  /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"|\x60|\[)?(?:auth_accounts|orders|commerce_orders|rights_grants|products)\b/im,
  "Schema-only export unexpectedly includes customer/content data",
);
const unique = new Set(tables);
console.log(
  JSON.stringify({
    schemaOnly: true,
    tableDeclarations: tables.length,
    uniqueTables: unique.size,
    expectedTablesPresent: known.length,
    bytes: sql.length,
  }),
);
