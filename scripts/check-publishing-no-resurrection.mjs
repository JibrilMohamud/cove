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
const offer=sql(/`(UPDATE offers SET active=CASE WHEN EXISTS [(][\s\S]*? THEN 1 ELSE 0 END,updated_at=[?] WHERE id=[?])`/,"retail activation").replace("${grantPlaceholders}","?");
for(const [name,query] of [["contract",contract],["grant",grants],["royalty",royalty]]){
  assert.match(query,/status IN \('draft','active'\)/,
    name+" must never revive revoked, suspended or retired agreements");
}
assert.match(offer,/g.status='active' AND g.decision='allow'/);
assert.match(offer,/g.sales_channel='retail'/);
assert.match(offer,/g.id IN \(\?\)/,"Frozen grant ID must be bound in offer SQL");
assert.match(offer,/g.contract_version_id=\?/);
assert.match(offer,/rcv.status='active'/);
assert.match(offer,/rcv.effective_to IS NULL OR rcv.effective_to>\?/);
assert.match(source,/if \(!activatingIds.length\)/,"Missing grant manifest must deny activation");
assert.match(offer,/g.contract_id IS NULL OR rc.status='active'/);
assert.match(source,/if \(Number\(offer\?\.active \|\| 0\)\s*!==\s*1\)/,
  "Publishing must fail closed if a guarded offer update did not activate");

const db=new DatabaseSync(":memory:");
try{
  db.exec(`
    CREATE TABLE rights_contracts(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,status TEXT,edition_id TEXT,
      decision TEXT,sales_channel TEXT,contract_id TEXT,contract_version_id TEXT,updated_at TEXT);
    CREATE TABLE rights_contract_versions(id TEXT PRIMARY KEY,contract_id TEXT,
      status TEXT,effective_from TEXT,effective_to TEXT);
    INSERT INTO rights_contract_versions VALUES('version_one','contract_one','active',
      '2026-01-01T00:00:00.000Z',NULL);
    CREATE TABLE finance_royalty_contracts(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT);
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);
    CREATE TABLE offers(id TEXT PRIMARY KEY,product_id TEXT,active INTEGER,updated_at TEXT);
    INSERT INTO products VALUES('prd_one','ed_one');
    INSERT INTO rights_contracts VALUES('contract_one','draft',NULL);
    INSERT INTO rights_grants VALUES('grant_one','draft','ed_one','allow','retail','contract_one','version_one',NULL);
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
  const offerRun=(grant="grant_one",contract="contract_one",version="version_one")=>{
    db.prepare(offer).run(grant,contract,contract,version,version,at,at,at,"offer_one");
    return db.prepare("SELECT active FROM offers WHERE id='offer_one'").get().active;
  };
  const resetOffer=()=>db.prepare("UPDATE offers SET active=0 WHERE id='offer_one'").run();
  assert.equal(offerRun(),1,"Fresh active retail grant may activate");
  resetOffer();
  set("rights_grants","revoked");
  assert.equal(offerRun(),0,"Revoked grant must prevent offer activation");
  db.prepare("UPDATE offers SET active=1 WHERE id='offer_one'").run();
  assert.equal(offerRun(),0,"A stale previously-active offer must be deactivated on revoked rights");
  set("rights_grants","active");
  set("rights_contracts","suspended");
  assert.equal(offerRun(),0,"Suspended contract must prevent offer activation");
  set("rights_contracts","active");
  db.prepare("UPDATE rights_grants SET sales_channel='subscription'").run();
  assert.equal(offerRun(),0,"Subscription-only permission must not activate a retail price");
  db.prepare("UPDATE rights_grants SET sales_channel='retail',status='revoked' WHERE id='grant_one'").run();
  db.prepare("INSERT INTO rights_grants VALUES('grant_other','active','ed_one','allow','retail','contract_one','version_one',NULL)").run();
  assert.equal(offerRun(),0,
    "Another legal grant for same edition must never substitute for frozen revoked grant");
  assert.equal(offerRun("grant_other","contract_other"),0,
    "Offer must reject mismatching frozen contract identity");
  assert.equal(offerRun("grant_other","contract_one","wrong_version"),0,
    "Offer must reject mismatching frozen contract version");
  db.prepare("UPDATE rights_contract_versions SET status='suspended'").run();
  assert.equal(offerRun("grant_other"),0,"Suspended contract version must not reactivate price");
  db.prepare("UPDATE rights_contract_versions SET status='active',effective_to='2026-10-01T00:00:00.000Z'").run();
  assert.equal(offerRun("grant_other"),0,"Expired contract version must not reactivate price");
  assert.equal(db.prepare("SELECT active FROM offers").get().active,0);

  // Exercise the production schedule SELECT, not a reimplementation: 510 old
  // future releases must not monopolize the 500-row cap ahead of a due title.
  const found=source.match(/`(SELECT l\.\*,pv\.id version_id,pv\.manifest_json,pv\.version_number FROM publishing_release_lifecycles l[^`]+LIMIT 500)`/);
  assert.ok(found,"Missing production bounded schedule query");
  db.exec("CREATE TABLE publishing_release_lifecycles(id TEXT PRIMARY KEY,state TEXT,updated_at TEXT,pending_publication_version_id TEXT,current_publication_version_id TEXT)");
  db.exec("CREATE TABLE publishing_publication_versions(id TEXT PRIMARY KEY,manifest_json TEXT,version_number INTEGER)");
  const addVersion=db.prepare("INSERT INTO publishing_publication_versions VALUES(?,?,1)");
  const addLifecycle=db.prepare("INSERT INTO publishing_release_lifecycles VALUES(?,?,?,?,?)");
  const future=JSON.stringify({metadata:{releaseDate:"2027-10-28T12:00:00.000Z"}});
  const due=JSON.stringify({metadata:{releaseDate:"2026-10-27T12:00:00.000Z"}});
  const preorder=JSON.stringify({metadata:{releaseDate:"2027-10-28T12:00:00.000Z",preorderDate:"2026-10-27T12:00:00.000Z"}});
  for(let i=0;i<510;i++){
    const key="future_"+String(i).padStart(3,"0");
    addVersion.run(key,future);
    addLifecycle.run(key,"scheduled","2025-01-01T00:00:00.000Z",null,key);
  }
  addVersion.run("due_retail",due);
  addLifecycle.run("due_retail","scheduled","2026-10-28T00:00:00.000Z",null,"due_retail");
  addVersion.run("due_preorder",preorder);
  addLifecycle.run("due_preorder","scheduled","2026-10-28T01:00:00.000Z",null,"due_preorder");
  addVersion.run("bad_manifest","{not json");
  addLifecycle.run("bad_manifest","scheduled","2026-10-28T02:00:00.000Z",null,"bad_manifest");
  const nowSeconds=Math.floor(Date.parse(at)/1000);
  const scheduled=db.prepare(found[1]).all(nowSeconds,nowSeconds);
  assert.deepEqual(scheduled.map(row=>row.id),["due_retail","due_preorder"],
    "Non-due or malformed releases must not crowd out due retail/preorder titles");
  console.log("PASS: bounded publishing scheduler selects due releases ahead of 510 older future titles");
  console.log("PASS: scheduled activation cannot revive suspended/revoked legal authority or expose retail offers without active matching grants");
}finally{db.close();}
