/* eslint-disable prettier/prettier -- Exercise the actual canonical SQL migration, not copied guards. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const sql=readFileSync("drizzle/0085_canonical_terminal_rights_resurrection_guard.sql","utf8");
const db=new DatabaseSync(":memory:");
try{
  db.exec(`CREATE TABLE rights_grants(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE rights_contracts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE finance_royalty_contracts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE offers(id TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0);
    INSERT INTO rights_grants VALUES('grant_one','draft');
    INSERT INTO rights_contracts VALUES('contract_one','draft');
    INSERT INTO finance_royalty_contracts VALUES('royalty_one','draft');
    INSERT INTO offers VALUES('offer_one',0);`);
  db.exec(sql);
  // Production migrations can be replayed idempotently without loosening the fence.
  db.exec(sql);
  for(const [table,id,terminal] of [
    ["rights_grants","grant_one",["suspended","revoked","expired"]],
    ["rights_contracts","contract_one",["suspended","expired","terminated"]],
    ["finance_royalty_contracts","royalty_one",["retired"]],
  ]){
    const status=()=>db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id).status;
    const set=(value)=>db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(value,id);
    set("draft");
    set("active");
    assert.equal(status(),"active",table+" must permit a newly approved draft");
    for(const negative of terminal){
      set(negative);
      for(const positive of ["draft","active"]){
        assert.throws(()=>set(positive),/requires new|must not be reopened/,
          table+" must not revive "+negative);
        assert.equal(status(),negative,"A rejected mutation must preserve terminal authority");
        assert.throws(()=>db.prepare(`INSERT INTO ${table}(id,status) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status`).run(id,positive),
          /requires new|must not be reopened/,"Upsert bypass must also fail");
        assert.equal(status(),negative);
      }
      // An irreversible terminal state is never reset to re-run the fixture.
      db.prepare(`INSERT INTO ${table}(id,status) VALUES(?,?)`).run(id+"_"+negative,"draft");
    }
  }
  // A failed in-batch positive must not leave preceding price activation.
  db.exec("BEGIN");
  try{
    db.prepare("UPDATE offers SET active=1 WHERE id='offer_one'").run();
    assert.throws(()=>db.prepare("UPDATE rights_grants SET status='active' WHERE id='grant_one'").run(),
      /requires new/);
  }finally{db.exec("ROLLBACK");}
  assert.equal(db.prepare("SELECT active FROM offers WHERE id='offer_one'").get().active,0);
  // Fresh separate authority identifiers remain possible after independent review.
  db.prepare("INSERT INTO rights_grants(id,status) VALUES('grant_fresh','draft')").run();
  db.prepare("UPDATE rights_grants SET status='active' WHERE id='grant_fresh'").run();
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE id='grant_fresh'").get().status,"active");
  console.log("PASS: actual D1 terminal-authority triggers reject in-place and upsert resurrection, preserve withdrawal, and permit new independent identifiers");
}finally{db.close();}
