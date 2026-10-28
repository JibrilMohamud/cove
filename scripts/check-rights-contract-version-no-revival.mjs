/* eslint-disable prettier/prettier -- Verify exact production SQL trigger with SQLite. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const migration=readFileSync("drizzle/0086_rights_contract_version_terminal_guard.sql","utf8");
const db=new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE rights_contract_versions (
    id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','active','superseded','terminated'))
  );
  INSERT INTO rights_contract_versions(id,status) VALUES('v1','draft'),('v2','draft');`);
  db.exec(migration);
  db.exec(migration);
  const read=(id)=>db.prepare("SELECT status FROM rights_contract_versions WHERE id=?").get(id).status;
  const move=(id,status)=>db.prepare("UPDATE rights_contract_versions SET status=? WHERE id=?").run(status,id);
  move("v1","active");
  assert.equal(read("v1"),"active","A genuine initial activation must remain possible");
  move("v1","superseded");
  for(const positive of ["draft","active"]) {
    assert.throws(()=>move("v1",positive),/fresh independent approval/);
    assert.equal(read("v1"),"superseded");
    assert.throws(()=>db.prepare(
      "INSERT INTO rights_contract_versions(id,status) VALUES('v1',?) ON CONFLICT(id) DO UPDATE SET status=excluded.status"
    ).run(positive),/fresh independent approval/,"A stale UPSERT must not revive a superseded version");
    assert.equal(read("v1"),"superseded");
  }
  move("v1","terminated");
  for(const positive of ["draft","active"]) {
    assert.throws(()=>move("v1",positive),/fresh independent approval/);
    assert.equal(read("v1"),"terminated");
  }
  move("v2","active");
  move("v2","terminated");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO rights_contract_versions(id,status) VALUES('v3','draft')").run();
    assert.throws(()=>move("v2","active"),/fresh independent approval/);
  }finally{db.exec("ROLLBACK");}
  assert.equal(db.prepare("SELECT count(*) n FROM rights_contract_versions WHERE id='v3'").get().n,0,
    "A rejected positive authorization cannot commit an earlier batched side effect");
  db.prepare("INSERT INTO rights_contract_versions(id,status) VALUES('fresh_v4','draft')").run();
  move("fresh_v4","active");
  assert.equal(read("fresh_v4"),"active","Fresh independent identifiers remain eligible for review");
  console.log("PASS: exact D1 contract-version migration rejects terminated/superseded revival, including UPSERT and rollback");
}finally { db.close(); }
