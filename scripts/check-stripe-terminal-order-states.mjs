/* eslint-disable prettier/prettier -- Verify the real private-owner SQL state machine, not retired caller writers. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const caller=readFileSync("src/features/fore/commerce.server.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const settlement=readFileSync("src/features/fore/paid-settlement-transaction.server.ts","utf8");

// Direct payment-status SQL and tender consumption were physically retired
// from the caller. A check for their old ordering would fail on a *safer*
// implementation and conceal regressions in the real owner state machine.
assert.doesNotMatch(caller,/await consumeTender\(db, order\)/);
assert.match(caller,/if \(env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"\)[\s\S]{0,120}throw new ApiError\(503, "Paid settlement requires the private commerce owner\."\)/);
const finalizer=caller.slice(caller.indexOf("export async function finalizePaidOrder("),caller.indexOf("export async function reconcileOwnerPaidSettlementEffects("));
assert.ok(finalizer.includes('["pending_payment", "processing", "authorized", "payment_failed"].includes(order.status)'));
const firstTime=finalizer.slice(finalizer.indexOf("// A valid, signed and correctly linked success event"));
assert.ok(firstTime.indexOf('["pending_payment", "processing", "authorized", "payment_failed"].includes(order.status)') <
  firstTime.indexOf("return settleStageOwnerPaidOrder(env, orderId)"),
  "Terminal order must be rejected before first-time owner settlement");
assert.match(settlement,/if\(!mutable\.includes\(order\.status\)\)throw new ApiError\(409/);
assert.ok(settlement.indexOf("if(!mutable.includes(order.status))") <
  settlement.indexOf("const statements:Parameters<CatalogDB"));
const start=owner.indexOf('if(route==="/commercial/payment/update-state")');
assert.ok(start>=0,"Private owner payment-state route must exist");
const next=owner.indexOf('if(route==="/commercial/webhook/claim")',start);
assert.ok(next>start,"Owner payment route must be bounded by its next case");
const code=owner.slice(start,next);
assert.match(code,/owner_payment_intent_order_mismatch/);
assert.match(code,/Object\.keys\(q\)\.sort\(\)\.join\(","\)!=="failureCode,orderId,paymentIntentId,state"/);
assert.match(caller,/await updateStageOwnerPaymentState\(env/);

// Take the *exact* owner SQL strings under test. The canonical owner guards
// order and Stripe-PI identity, prevents terminal reopening, and commits
// cancellation together with both tender-release statements.
const statements=[...code.matchAll(/"((?:UPDATE) [^"\n]+)"/g)].map(m=>m[1]);
const orderSql=(state)=>statements.find(s=>s.startsWith("UPDATE commerce_orders SET status='"+state+"'"));
const processing=orderSql("processing"),authorized=orderSql("authorized");
const failed=orderSql("payment_failed"),canceled=orderSql("canceled");
const reserves=statements.find(s=>s.startsWith("UPDATE commerce_balance_reservations SET status='released'"));
const promos=statements.find(s=>s.startsWith("UPDATE commerce_promo_redemptions SET status='released'"));
for(const sql of [processing,authorized,failed,canceled]){
  assert.ok(sql,"Missing private owner monotonic order transition");
  assert.match(sql,/AND stripe_payment_intent_id=\?/);
  assert.match(sql,/ AND status(?: IN |='pending_payment')/);
}
for(const sql of [reserves,promos]){
  assert.ok(sql,"Missing guarded private owner cancellation release");
  assert.match(sql,/status='canceled'/);
  assert.match(sql,/stripe_payment_intent_id=\?/);
}
assert.match(code,/const results=await env\.PRIMARY_DB\.batch\(\[/);
assert.ok(code.indexOf(canceled)<code.indexOf(reserves) &&
  code.indexOf(reserves)<code.indexOf(promos),"Cancellation must precede both releases in one owner batch");
assert.match(settlement,/if\(!mutable\.includes\(order\.status\)\)/);

const db=new DatabaseSync(":memory:");
const id="order_terminal_qa", pi="pi_exact_test_identity",at="2026-10-27T20:00:00.000Z";
try{
  db.exec(`CREATE TABLE commerce_orders(
    id TEXT PRIMARY KEY,status TEXT NOT NULL,stripe_payment_intent_id TEXT NOT NULL,
    authorized_at TEXT,updated_at TEXT,failure_code TEXT,failure_message TEXT,canceled_at TEXT);
    CREATE TABLE commerce_balance_reservations(
      order_id TEXT,status TEXT NOT NULL,updated_at TEXT);
    CREATE TABLE commerce_promo_redemptions(
      order_id TEXT,status TEXT NOT NULL,updated_at TEXT);`);
  const insert=(status)=>{
    db.prepare("INSERT OR REPLACE INTO commerce_orders(id,status,stripe_payment_intent_id) VALUES(?,?,?)")
      .run(id,status,pi);
    db.exec("DELETE FROM commerce_balance_reservations;DELETE FROM commerce_promo_redemptions;");
    db.prepare("INSERT INTO commerce_balance_reservations(order_id,status) VALUES(?,'reserved')").run(id);
    db.prepare("INSERT INTO commerce_promo_redemptions(order_id,status) VALUES(?,'reserved')").run(id);
  };
  const state=()=>db.prepare("SELECT status FROM commerce_orders WHERE id=?").get(id).status;
  const tender=()=>[db.prepare("SELECT status FROM commerce_balance_reservations WHERE order_id=?").get(id).status,
    db.prepare("SELECT status FROM commerce_promo_redemptions WHERE order_id=?").get(id).status];
  const transition=(status,identity=pi)=>{
    if(status==="authorized")return db.prepare(authorized).run(at,at,id,identity).changes;
    if(status==="processing")return db.prepare(processing).run(at,id,identity).changes;
    if(status==="payment_failed")return db.prepare(failed).run("card_declined",at,id,identity).changes;
    db.exec("BEGIN");
    try{
      const changed=db.prepare(canceled).run(at,at,id,identity).changes;
      db.prepare(reserves).run(at,id,id,identity);
      db.prepare(promos).run(at,id,id,identity);
      db.exec("COMMIT");
      return changed;
    }catch(e){db.exec("ROLLBACK");throw e;}
  };
  for(const terminal of ["canceled","refunded","partially_refunded","paid","revoked"]){
    insert(terminal);
    for(const target of ["processing","authorized","payment_failed","canceled"]){
      assert.equal(transition(target),0,"Stale "+target+" event reopened "+terminal);
      assert.equal(state(),terminal);
      // An exact canceled-state replay repairs reservations left behind by
      // an interrupted cancellation. Other terminal states may not release.
      const expected=terminal==="canceled"&&target==="canceled"?"released":"reserved";
      assert.deepEqual(tender(),[expected,expected],
        "Owner cancellation replay must repair only canceled tender");
    }
  }
  insert("pending_payment");
  for(const target of ["processing","authorized","payment_failed","canceled"]){
    assert.equal(transition(target,"pi_forged_intent"),0,"Foreign Stripe PI changed state");
    assert.equal(state(),"pending_payment");
  }
  assert.deepEqual(tender(),["reserved","reserved"]);
  assert.equal(transition("processing"),1);
  assert.equal(transition("authorized"),1);
  assert.equal(transition("payment_failed"),1);
  assert.equal(transition("authorized"),0,"Stale authorization reopened failed payment");
  assert.equal(transition("canceled"),1);
  assert.equal(state(),"canceled");
  assert.deepEqual(tender(),["released","released"]);
  assert.equal(transition("canceled"),0,"Cancellation replay changed terminal order");
  assert.deepEqual(tender(),["released","released"]);
  console.log("PASS: source-exact private-owner Stripe transitions keep terminal orders immutable, foreign PI denied, and cancellation/release atomic and replay-safe");
}finally{db.close();}
