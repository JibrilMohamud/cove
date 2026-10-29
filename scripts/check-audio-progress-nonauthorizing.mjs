/* eslint-disable prettier/prettier -- Exact production SQL regression protects a narrowly reviewed non-authorizing classification. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const source=readFileSync("src/features/fore/sync.server.ts","utf8");
const start=source.indexOf('} else if (m.entityType === "audio_location")');
const finish=source.indexOf('} else if (m.entityType === "biosync_location")',start);
assert.ok(start>0&&finish>start,"Audio-location handling must remain distinct from paid authorization");
const branch=source.slice(start,finish);
assert.match(source,/entityType === "audio_location"[\s\S]{0,180}productId: z\.string\(\)\.min\(1\)/);
assert.match(branch,/SELECT version FROM commercial_audio_playback WHERE user_id=\? AND product_id=\?/);
assert.match(branch,/if \(Number\(current\?\.version \|\| 0\) !== m\.expectedVersion\)/);
const sqls=[...branch.matchAll(/"((?:DELETE FROM|UPDATE|INSERT INTO) commercial_audio_playback[^"]+)"/g)].map(x=>x[1]);
assert.equal(sqls.length,3,"Adding or removing any audiobook progress mutation requires independent re-review");
const [remove,update,insert]=sqls;
assert.equal(remove,"DELETE FROM commercial_audio_playback WHERE user_id=? AND product_id=? AND version=?");
assert.equal(update,"UPDATE commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=?,updated_at=? WHERE user_id=? AND product_id=? AND version=?");
assert.equal(insert,"INSERT INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,?,?)");
assert.doesNotMatch(branch,/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:entitlements|rights_grants|offers|commerce_orders|commercial_delivery_grants|audio_offline_licenses)\b/i);

const db=new DatabaseSync(":memory:");
try{
  db.exec("CREATE TABLE entitlements(id TEXT,user_id TEXT,product_id TEXT,status TEXT)");
  db.exec("CREATE TABLE commercial_audio_playback(user_id TEXT,product_id TEXT,chapter_id TEXT,seconds REAL,speed REAL,version INTEGER,updated_at TEXT,PRIMARY KEY(user_id,product_id))");
  db.prepare("INSERT INTO entitlements VALUES(?,?,?,'revoked')").run("ent_a","reader_a","book_a");
  const first=db.prepare(insert).run("reader_a","book_a","ch1",12,1,1,"now");
  assert.equal(first.changes,1);
  db.prepare(insert).run("reader_b","book_a","other",3,1,1,"now");
  assert.equal(db.prepare(update).run("ch2",29,1.2,2,"later","reader_a","book_a",1).changes,1);
  assert.equal(db.prepare(update).run("wrong",0,1,3,"later","reader_b","book_a",2).changes,0,
    "Optimistic version mismatch must not advance another user's bookmark");
  assert.equal(db.prepare(remove).run("reader_a","book_a",2).changes,1);
  assert.equal(db.prepare("SELECT chapter_id FROM commercial_audio_playback WHERE user_id='reader_b'").get().chapter_id,"other");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id='ent_a'").get().status,"revoked",
    "Audio progress MUST NOT create, reinstate or revoke an entitlement");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_audio_playback WHERE user_id='reader_a'").get().n,0);
}finally{db.close();}
console.log("PASS: the exact three audio sync SQL sites only mutate versioned, buyer-scoped listening progress; no rights are granted");
