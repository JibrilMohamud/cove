/* eslint-disable prettier/prettier -- Execute the owner's EXACT conditional commit proof on SQLite. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const gateway=readFileSync("src/storefront-strangler/canonical-owner-command-gateway.ts","utf8");
const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
const start=owner.indexOf('if(route==="/commercial/checkout/prepare-draft")');
const end=owner.indexOf('if(route==="/commercial/checkout/materialize-draft")',start);
assert.ok(start>0&&end>start,"Only a private, fenced owner prepare route is allowed");
const code=owner.slice(start,end);
assert.match(code,/await assessBuyerOrderRisk\\(localRiskDb,order\\.id\\)/);
assert.match(code,/const localRiskDb=bindPublicationOwner\\(db,/);
assert.match(code,/route!=="\\/risk\\/private-apply-assessment"/);
assert.match(code,/route!=="\\/risk\\/private-create-hold"/);
assert.match(code,/return this\\.fetch\\(req\\)/);
assert.match(code,/return new Response\\(null,\\{status:403,headers:noStore\\}\\)/);
assert.match(code,/if\(quote\.consumed_at\)/);
assert.match(code,/stripe_payment_intent_id IS NULL/);
assert.match(code,/if\(risk\.action==="block"\|\|/);
assert.match(code,/INSERT INTO commerce_balance_reservations/);
assert.match(code,/INSERT INTO commerce_promo_redemptions/);
assert.match(code,/UPDATE commerce_checkout_quotes SET consumed_at/);
assert.match(code,/await db\.batch\(stmts\)/);
assert.match(gateway,/"commerce.prepare-checkout-draft"/);
assert.match(commerce,/createStageOwnerCheckoutPayment\(\s*env,\s*user,\s*input,\s*quote,\s*false\s*\)/);
assert.match(commerce,/await prepareStageCheckoutDraft\(env,/);
assert.match(commerce,/await attachStageOwnerCheckoutPayment\(env,/);
const found=code.match(/stmts\.push\(db\.prepare\(\s*"(SELECT CASE WHEN [^"]+)"\s*\)\.bind\(/);
assert.ok(found,"The actual final SQL proof MUST be extracted and executed");
const sql=found[1];
assert.match(sql,/ELSE json_extract\('invalid-checkout-preparation','\$'\)/);
assert.match(sql,/risk_assessment_id IS NOT NULL/);
assert.match(sql,/stripe_payment_intent_id IS NULL/);
assert.match(sql,/COUNT\(\*\) FROM commerce_promo_redemptions/);

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE commerce_checkout_quotes(id TEXT,user_id TEXT,consumed_at TEXT);
    CREATE TABLE commerce_orders(id TEXT,user_id TEXT,status TEXT,risk_assessment_id TEXT,risk_action TEXT,capture_method TEXT,stripe_payment_intent_id TEXT);
    CREATE TABLE commerce_balance_reservations(order_id TEXT,status TEXT,source_type TEXT,amount_minor INTEGER);
    CREATE TABLE commerce_promo_redemptions(order_id TEXT,status TEXT,amount_minor INTEGER);
    INSERT INTO commerce_checkout_quotes VALUES('quote_test','user_test',NULL);
    INSERT INTO commerce_orders VALUES('ord_test','user_test','pending_payment','risk_test','allow','automatic_async',NULL);`);
  return db;
}
const at="2026-10-30T05:00:00.000Z";
const args=[
  "quote_test","user_test",at,"ord_test",2,
  "ord_test",100,"ord_test",200,"ord_test",1,
  "ord_test",50,"ord_test","user_test","allow","automatic_async"
];
function commit(db,{gift=100,store=200,promo=50,risks=true,quote=true}={}){
  db.exec("BEGIN IMMEDIATE");
  try{
    if(risks)db.prepare("UPDATE commerce_orders SET risk_assessment_id='risk_test' WHERE id='ord_test'").run();
    db.prepare("INSERT INTO commerce_balance_reservations VALUES('ord_test','reserved','gift_card',?)").run(gift);
    db.prepare("INSERT INTO commerce_balance_reservations VALUES('ord_test','reserved','store_credit',?)").run(store);
    db.prepare("INSERT INTO commerce_promo_redemptions VALUES('ord_test','reserved',?)").run(promo);
    if(quote)db.prepare("UPDATE commerce_checkout_quotes SET consumed_at=?").run(at);
    const result=db.prepare(sql).get(...args);
    assert.equal(result.verified,1);
    db.exec("COMMIT");
  }catch(e){db.exec("ROLLBACK");throw e;}
}
const valid=fixture();
commit(valid);
assert.equal(valid.prepare("SELECT consumed_at FROM commerce_checkout_quotes").get().consumed_at,at);
assert.equal(valid.prepare("SELECT COUNT(*) n FROM commerce_balance_reservations").get().n,2);
valid.close();
for(const [name,config] of [
  ["gift_underreserved",{gift:99}],["store_underreserved",{store:199}],
  ["promo_overreserved",{promo:51}],["missing_quote",{quote:false}]
]){
  const db=fixture();
  assert.throws(()=>commit(db,config),/malformed JSON|invalid JSON/i,name);
  assert.equal(db.prepare("SELECT consumed_at FROM commerce_checkout_quotes").get().consumed_at,null,name);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commerce_balance_reservations").get().n,0,name);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commerce_promo_redemptions").get().n,0,name);
  db.close();
}
const denied=fixture();
denied.prepare("UPDATE commerce_orders SET status='canceled'").run();
assert.throws(()=>commit(denied),/malformed JSON|invalid JSON/i);
denied.close();
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
assert.equal(review.releaseApproval,false);
console.log("PASS: private checkout owner proof commits exact gift/credit/promo/quote counts; invalid reservations, terminal order and quote race atomically roll back");
