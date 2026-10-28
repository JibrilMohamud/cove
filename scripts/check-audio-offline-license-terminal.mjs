/* eslint-disable prettier/prettier -- Execute the actual canonical migration in SQLite, not a duplicated guard. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const migration=readFileSync("drizzle/0088_audio_offline_license_terminal_guard.sql","utf8");
const db=new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE audio_offline_licenses(
    id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked'))
  );
  INSERT INTO audio_offline_licenses(id,token_hash,status) VALUES
    ('old','token-old','active'),('expired','token-expired','active');`);
  db.exec(migration);
  db.exec(migration); // Idempotent replay must not loosen the fence.
  const status=(id)=>db.prepare("SELECT status FROM audio_offline_licenses WHERE id=?").get(id).status;
  const move=(id,next)=>db.prepare("UPDATE audio_offline_licenses SET status=? WHERE id=?").run(next,id);
  const upsert=(id,next)=>db.prepare(
    "INSERT INTO audio_offline_licenses(id,token_hash,status) VALUES(?,'new-hash',?) ON CONFLICT(id) DO UPDATE SET status=excluded.status"
  ).run(id,next);
  move("old","revoked");
  for(const next of ["active","expired"]){
    assert.throws(()=>move("old",next),/requires a newly issued token/);
    assert.throws(()=>upsert("old",next),/requires a newly issued token/);
    assert.equal(status("old"),"revoked");
  }
  move("old","revoked"); // Idempotent withdrawal is allowed.
  move("expired","expired");
  assert.throws(()=>move("expired","active"),/requires a newly issued token/);
  assert.throws(()=>upsert("expired","active"),/requires a newly issued token/);
  assert.equal(status("expired"),"expired");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO audio_offline_licenses(id,token_hash) VALUES('rollback','token-temp')").run();
    assert.throws(()=>move("old","active"),/requires a newly issued token/);
  } finally { db.exec("ROLLBACK"); }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audio_offline_licenses WHERE id='rollback'").get().n,0);
  db.prepare("INSERT INTO audio_offline_licenses(id,token_hash) VALUES('renewed','token-new')").run();
  assert.equal(status("renewed"),"active");
  assert.equal(status("old"),"revoked");
  console.log("PASS: canonical audio offline license migration denies stale status or UPSERT revival and allows a new independent token");
} finally { db.close(); }
