import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = fs.readFileSync(
  "drizzle/0077_secondary_channel_potential_index.sql",
  "utf8",
);
assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_rights_secondary_channel_potential/);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE rights_grants(
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      sales_channel TEXT NOT NULL,
      subscription_permitted INTEGER NOT NULL DEFAULT 0,
      library_permitted INTEGER NOT NULL DEFAULT 0,
      edition_id TEXT NOT NULL
    );
  `);
  const write = db.prepare(
    "INSERT INTO rights_grants VALUES (?,?,?,?,?,?)",
  );
  for (let n = 0; n < 2000; n++) {
    write.run("retail-" + n, "active", "retail", 0, 0, "edition-" + n);
  }
  db.exec(migration);
  const sql = `SELECT 1 candidate FROM rights_grants
    INDEXED BY idx_rights_secondary_channel_potential
    WHERE status='active'
      AND (sales_channel IN ('subscription','library')
        OR (sales_channel='retail'
          AND (subscription_permitted=1 OR library_permitted=1)))
    LIMIT 1`;
  const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all();
  assert.ok(
    plan.some((r) => String(r.detail).includes("idx_rights_secondary_channel_potential")),
    "Negative gate must use the bounded candidate-grants partial index",
  );
  assert.equal(db.prepare(sql).get(), undefined, "Retail-only catalog must skip view safely");
  write.run("retail-with-library", "active", "retail", 0, 1, "new-edition");
  assert.ok(db.prepare(sql).get(), "New retail library permission forces full legal view");
  db.prepare("UPDATE rights_grants SET status='revoked' WHERE id='retail-with-library'").run();
  assert.equal(db.prepare(sql).get(), undefined, "Revoked grant must not pass live gate");
  write.run("direct-subscription", "active", "subscription", 0, 0, "new-edition");
  assert.ok(db.prepare(sql).get(), "Direct subscription channel forces full legal view");
  db.prepare("UPDATE rights_grants SET sales_channel='retail',subscription_permitted=0 WHERE id='direct-subscription'").run();
  assert.equal(db.prepare(sql).get(), undefined, "Revoking candidate permission removes index entry");
  write.run("direct-library", "active", "library", 0, 0, "new-edition");
  assert.ok(db.prepare(sql).get(), "Direct library channel forces full legal view");
  assert.equal(
    db.prepare("SELECT COUNT(*) total FROM rights_grants INDEXED BY idx_rights_secondary_channel_potential WHERE status='active' AND (sales_channel IN ('subscription','library') OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1)))").get().total,
    1,
  );
  // This index is only a negative gate. It must NEVER be used as an
  // allowlist: status, contract, language, DRM, time and deny precedence
  // are evaluated by product_channel_availability on all candidate hits.
  console.log("Secondary channel potential index: zero candidates, insert, revoke, channel transition and plan PASS");
} finally {
  db.close();
}
