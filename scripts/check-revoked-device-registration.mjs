import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Exercise the exact production device UPSERT, not a rewritten mock query.
// A revoked key is a permanent negative identity; a fresh key is required.
const source = readFileSync("src/features/fore/account-management.server.ts", "utf8");
const start = source.indexOf("INSERT INTO devices(");
assert.ok(start > 0, "Production device registration SQL must exist");
const end = source.indexOf("`", start);
assert.ok(end > start && end - start < 1000);
const sql = source.slice(start, end);
assert.match(sql, /ON CONFLICT\(user_id,device_key\)/);
assert.match(sql, /WHERE devices\.revoked_at IS NULL/);
assert.doesNotMatch(sql, /revoked_at\s*=\s*NULL/);

const handler = source.slice(
  source.indexOf("export async function registerDevice("),
  source.indexOf("export async function revokeDevice("),
);
assert.match(handler, /if \(!row\)\s*throw new ApiError\(409/);

const db = new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_key TEXT NOT NULL,
    name TEXT NOT NULL, platform TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    revoked_at TEXT, created_at TEXT NOT NULL,
    UNIQUE (user_id, device_key)
  )`);
  const stmt = db.prepare(sql);
  const at = "2026-10-28T20:00:00.000Z";
  const key = "durable-device-public-key-001";
  const insert = (id, userId, deviceKey, name) =>
    stmt.get(id, userId, deviceKey, name, "reader", at, at);

  assert.equal(insert("device_1", "buyer_1", key, "First")?.id, "device_1");
  assert.equal(insert("device_2", "buyer_1", key, "Updated")?.id, "device_1");
  assert.equal(db.prepare("SELECT name FROM devices WHERE id='device_1'").get().name, "Updated");

  db.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(at, "device_1");
  assert.equal(
    insert("device_3", "buyer_1", key, "Stolen"),
    undefined,
    "Re-enrolling the same revoked public key must not resurrect it",
  );
  const revoked = db.prepare("SELECT name,revoked_at FROM devices WHERE id='device_1'").get();
  assert.equal(revoked.name, "Updated");
  assert.equal(revoked.revoked_at, at);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM devices").get().n,
    1,
    "Revoked key must not create a second device row",
  );
  assert.equal(
    insert("device_4", "buyer_1", "brand-new-device-public-key-002", "New")?.id,
    "device_4",
    "A user may explicitly enroll a fresh key",
  );
  assert.equal(
    insert("device_5", "buyer_2", key, "Other buyer")?.id,
    "device_5",
    "One user's revoked key must not block a different account",
  );
  console.log(
    "PASS: revoked device keys cannot resurrect; active re-registration, key rotation, buyer isolation preserved",
  );
} finally {
  db.close();
}
