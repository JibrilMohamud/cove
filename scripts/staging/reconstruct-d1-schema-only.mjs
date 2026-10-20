import assert from "node:assert/strict";
import fs from "node:fs";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const SOURCE = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const TARGET = "ce0e67b7-692d-44c6-94dc-7f324e7c5421";
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(apiToken && apiToken.length > 24);
assert.notEqual(SOURCE, TARGET);
assert.equal(process.argv[2], "./schema-only-private.sql");

async function query(db, sql) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${db}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const json = await r.json();
  if (!r.ok || !json.success) {
    throw Error(`D1 schema-only API introspection failed: http=${r.status}`);
  }
  return json.result?.[0]?.results || [];
}
const targetTables = await query(
  TARGET,
  "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_cf_KV'",
);
assert.equal(targetTables[0]?.n, 0, "Must import to a fresh empty nonproduction D1");
const sourceCount = await query(
  SOURCE,
  "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_cf_KV'",
);
assert.ok(sourceCount[0]?.n >= 450, "Unexpectedly sparse source database");
const all = [];
for (let offset = 0; offset < 5000; offset += 75) {
  // Introspect ONLY sqlite_master SQL definitions, NEVER table rows.
  const rows = await query(
    SOURCE,
    `SELECT type,name,sql FROM sqlite_master` +
      ` WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name!='_cf_KV'` +
      ` ORDER BY type,name LIMIT 75 OFFSET ${offset}`,
  );
  if (!rows.length) break;
  all.push(...rows);
  if (rows.length < 75) break;
}
assert.ok(all.length >= 1100 && all.length < 2500);
const virtual = all.filter((o) => o.type === "table" && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(o.sql));
const fts = virtual.filter((o) => /\bUSING\s+fts5\s*\(/i.test(o.sql));
assert.ok(fts.length >= 2, "Expected production FTS search tables");
const isShadow = (o) =>
  fts.some((v) =>
    ["_data", "_idx", "_content", "_docsize", "_config"].some(
      (suffix) => o.name === v.name + suffix,
    ),
  );
const shadow = all.filter(isShadow);
assert.ok(shadow.length >= 8, "Expected generated FTS5 shadow tables");
const normal = all.filter((o) => o.type === "table" && !virtual.includes(o) && !isShadow(o));
const regularVirtual = virtual.filter((o) => !/\bUSING\s+fts5vocab\s*\(/i.test(o.sql));
const vocab = virtual.filter((o) => /\bUSING\s+fts5vocab\s*\(/i.test(o.sql));
const indexes = all.filter((o) => o.type === "index" && !isShadow(o));
const views = all.filter((o) => o.type === "view");
const triggers = all.filter((o) => o.type === "trigger");
// Preserve CREATE SQL; no INSERT/UPDATE/DELETE of source data is exported.
// Generated virtual-table shadow schema is automatically rebuilt by SQLite.
const definitions = [...normal, ...regularVirtual, ...vocab, ...indexes, ...views, ...triggers];
assert.ok(definitions.length > 1000);
const names = new Set(all.map((o) => o.name));
for (const required of ["products", "rights_grants", "commerce_orders", "auth_accounts", "soundtrack_recordings", "catalog_search_fts"]) {
  assert.ok(names.has(required), `Missing known production table ${required}`);
}
for (const object of definitions) {
  assert.ok(
    /^(CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b)/i.test(
      object.sql,
    ),
    `Unexpected schema SQL for ${object.name}`,
  );
}
const result = [
  "-- COVE PRIVATE SCHEMA-ONLY RECONSTRUCTION.",
  "-- Source D1 introspection was limited to sqlite_master definitions.",
  "-- No customer, book, rights, account, payment, audio or source rows.",
  "-- Do not commit or upload this generated SQL; delete after stage import.",
  ...definitions.map((o) => o.sql.trim().replace(/;\s*$/, "") + ";"),
].join("\n\n");
fs.writeFileSync(process.argv[2], result, { mode: 0o600 });
console.log(JSON.stringify({
  sourceNonSystemTables: sourceCount[0].n,
  normalTables: normal.length,
  ftsVirtual: regularVirtual.length,
  vocabVirtual: vocab.length,
  skippedGeneratedFtsShadow: shadow.length,
  indexes: indexes.length,
  views: views.length,
  triggers: triggers.length,
  ddlStatements: definitions.length,
  exportBytes: Buffer.byteLength(result),
  containsData: false,
}));
