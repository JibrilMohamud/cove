import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { syntheticOperatorFixturePlan,REQUIRED_BOOK_CARDS } from "./performance/synthetic-operator-fixture.mjs";
const ids=Array.from({length:128},(_,i)=>"perf-synth-"+String(i+1).padStart(6,"0"));
const plan=syntheticOperatorFixturePlan(ids,"40247093368");
assert.equal(plan.ids.length,REQUIRED_BOOK_CARDS);
assert.equal(plan.issueOffers.params.length,REQUIRED_BOOK_CARDS+1);
assert.throws(()=>syntheticOperatorFixturePlan(["actual-book"],"40247093368"));
assert.throws(()=>syntheticOperatorFixturePlan(ids,"wrong-name"));
assert.throws(()=>syntheticOperatorFixturePlan(Array.from({length:128},()=>ids[0]),"40247093368"));
const db=new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT);
  CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,source TEXT,
     decision TEXT,status TEXT,sales_channel TEXT);
  CREATE TABLE retail_product_availability_rows(product_id TEXT,territory_code TEXT,
     rights_grant_id TEXT);
  CREATE TABLE offers(id TEXT PRIMARY KEY,product_id TEXT,offer_type TEXT,currency TEXT,
     amount_minor INTEGER,active INTEGER,created_at TEXT,updated_at TEXT,sales_channel TEXT);
`);
for(const id of ids){
 db.prepare("INSERT INTO products VALUES(?,?,'gutenberg')").run(id,id);
 db.prepare("INSERT INTO rights_grants VALUES(?,?,'operator','allow','active','retail')").run("rg-"+id,id);
 db.prepare("INSERT INTO retail_product_availability_rows VALUES(?,'US',?)").run(id,"rg-"+id);
}
const select=(q)=>db.prepare(q.sql).get(...q.params).n;
assert.equal(select(plan.preflight),24);
assert.equal(db.prepare(plan.operatorize.sql).run(...plan.operatorize.params).changes,24);
assert.equal(db.prepare(plan.issueOffers.sql).run(...plan.issueOffers.params).changes,24);
assert.equal(select(plan.verify),24);
assert.equal(db.prepare(plan.issueOffers.sql).run(...plan.issueOffers.params).changes,0);
db.prepare("UPDATE rights_grants SET status='revoked' WHERE id=?").run("rg-"+ids[0]);
assert.equal(select(plan.verify),23,"A withdrawn operator grant must disappear even with a prior active offer");
db.prepare("UPDATE rights_grants SET status='active' WHERE id=?").run("rg-"+ids[0]);
assert.equal(select(plan.verify),24);
db.prepare(plan.dropOffers.sql).run(...plan.dropOffers.params);
db.prepare(plan.restore.sql).run(...plan.restore.params);
assert.equal(db.prepare("SELECT COUNT(*) n FROM offers").get().n,0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE source_name='operator'").get().n,0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE source_name='gutenberg'").get().n,128);
console.log("PASS stage-only 24 live operator-grant/offer fixture, exact rights revocation, id guard and restoration");
