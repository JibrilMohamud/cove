/* eslint-disable prettier/prettier -- Guard source SQL against stale and revoked commercial authority. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const source=readFileSync("src/features/fore/publishing.server.ts","utf8");
const sql=(pattern,label)=>{
  const match=source.match(pattern);
  assert.ok(match,"Missing production SQL for "+label);
  return match[1];
};
const contract=sql(/"(UPDATE rights_contracts SET status='active',updated_at=\? WHERE id=\?[^"]+)"/,"contract activation");
const grants=sql(/`(UPDATE rights_grants SET status='active',updated_at=\? WHERE id IN \(\$\{placeholders\}\)[^`]+)`/,"grant activation").replace("${placeholders}","?");
const royalty=sql(/"(UPDATE finance_royalty_contracts SET status='active',updated_at=\? WHERE id=\?[^"]+)"/,"royalty activation");
const offer=sql(/`(UPDATE offers SET active=1,updated_at=\? WHERE id=\?[\s\S]*?)`/,"retail activation");
for(const [name,query] of [["contract",contract],["grant",grants],["royalty",royalty]]){
  assert.match(query,/status IN \('draft','active'\)/,
    name+" must never revive revoked, suspended or retired agreements");
}
assert.match(offer,/g.status='active' AND g.decision='allow'/);
assert.match(offer,/g.sales_channel='retail'/);
assert.match(offer,/g.contract_id IS NULL OR rc.status='active'/);
assert.match(source,/if \(Number\(offer\?\.active \|\| 0\)!==1\)/,
  "Publishing must fail closed if a guarded offer update did not activate");

const db=new DatabaseSync(":memory:");
try{
  db.exec(`
    CREATE TABLE rights_contracts(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,status TEXT,edition_id TEXT,
      decision TEXT,sales_channel TEXT,contract_id TEXT,updated_at TEXT);
    CREATE TABLE finance_royalty_contracts(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT);
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);
    CREATE TABLE offers(id TEXT PRIMARY KEY,product_id TEXT,active INTEGER,updated_at TEXT);
    INSERT INTO products VALUES('prd_one','ed_one');
    INSERT INTO rights_contracts VALUES('contract_one','draft',NULL);
    INSERT INTO rights_grants VALUES('grant_one','draft','ed_one','allow','retail','contract_one',NULL);
    INSERT INTO finance_royalty_contracts VALUES('royalty_one','draft',NULL);
    INSERT INTO offers VALUES('offer_one','prd_one',0,NULL);
  `);
  const at="2026-10-28T12:00:00.000Z";
  const set=(table,status)=>db.prepare("UPDATE "+table+" SET status=?").run(status);
  const value=(table)=>db.prepare("SELECT status FROM "+table+" LIMIT 1").get().status;
  for(const [table,query,id] of [
    ["rights_contracts",contract,"contract_one"],
    ["rights_grants",grants,"grant_one"],
    ["finance_royalty_contracts",royalty,"royalty_one"]
  ]){
    for(const negative of ["suspended","revoked","terminated","retired"]){
      set(table,negative);
      assert.equal(db.prepare(query).run(at,id).changes,0,
        table+" resurrected "+negative);
      assert.equal(value(table),negative);
    }
    set(table,"draft");
    assert.equal(db.prepare(query).run(at,id).changes,1);
    assert.equal(value(table),"active");
  }
  const offerRun=()=>db.prepare(offer).run(at,"offer_one").changes;
  const resetOffer=()=>db.prepare("UPDATE offers SET active=0 WHERE id='offer_one'").run();
  assert.equal(offerRun(),1,"Fresh active retail grant may activate");
  resetOffer();
  set("rights_grants","revoked");
  assert.equal(offerRun(),0,"Revoked grant must prevent offer activation");
  set("rights_grants","active");
  set("rights_contracts","suspended");
  assert.equal(offerRun(),0,"Suspended contract must prevent offer activation");
  set("rights_contracts","active");
  db.prepare("UPDATE rights_grants SET sales_channel='subscription'").run();
  assert.equal(offerRun(),0,"Subscription-only permission must not activate a retail price");
  assert.equal(db.prepare("SELECT active FROM offers").get().active,0);
  console.log("PASS: scheduled activation cannot revive suspended/revoked legal authority or expose retail offers without active matching grants");
}finally{db.close();}
