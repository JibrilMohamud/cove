/* eslint-disable prettier/prettier -- Stripe ordering is adversarial; terminal orders must not be reopened. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const code=readFileSync("src/features/fore/commerce.server.ts","utf8");
assert.match(code,/if\(!\["pending_payment","processing","authorized","payment_failed"\]\.includes\(order\.status\)\)/,
  "First-time settlement must refuse canceled, partially refunded or revoked orders");
assert.ok(code.indexOf('if(!["pending_payment","processing","authorized","payment_failed"].includes(order.status))')<
  code.indexOf("await consumeTender(db, order);"),
  "Terminal-state settlement guard MUST precede tender consumption");

const query=(status)=>{
  const matches=[...code.matchAll(new RegExp(
    "\"(UPDATE commerce_orders SET status='"+status+"'[^\"]+)\"","g"
  ))].map(x=>x[1]);
  const guarded=matches.find(x=>x.includes(" AND status IN (") ||
    (status==="processing"&&x.includes(" AND status='pending_payment'")));
  assert.ok(guarded,"Missing monotonic guarded Stripe SQL for "+status);
  return guarded;
};
const processing=query("processing"),authorized=query("authorized");
const failed=query("payment_failed"),canceled=query("canceled");
const db=new DatabaseSync(":memory:");
try{
  db.exec(`CREATE TABLE commerce_orders(
    id TEXT PRIMARY KEY,status TEXT NOT NULL,
    authorized_at TEXT,updated_at TEXT,failure_code TEXT,
    failure_message TEXT,canceled_at TEXT)`);
  const at="2026-10-27T20:00:00.000Z";
  const insert=(status)=>{
    db.prepare("INSERT OR REPLACE INTO commerce_orders(id,status) VALUES(?,?)")
      .run("order_terminal_qa",status);
  };
  const status=()=>db.prepare("SELECT status FROM commerce_orders WHERE id='order_terminal_qa'").get().status;
  const run=(sql)=>{
    if(sql===authorized||sql===processing)
      return db.prepare(sql).run(...(sql===authorized?[at,at,"order_terminal_qa"]:[at,"order_terminal_qa"]));
    if(sql===failed)return db.prepare(sql).run("card_declined","declined",at,"order_terminal_qa");
    return db.prepare(sql).run(at,at,"order_terminal_qa");
  };
  for(const terminal of ["canceled","refunded","partially_refunded","paid"]){
    insert(terminal);
    for(const sql of [processing,authorized,failed,canceled]){
      assert.equal(run(sql).changes,0,
        "Out-of-order Stripe update reopened "+terminal);
      assert.equal(status(),terminal);
    }
  }
  insert("pending_payment");
  assert.equal(run(processing).changes,1);
  assert.equal(status(),"processing");
  assert.equal(run(authorized).changes,1);
  assert.equal(status(),"authorized");
  assert.equal(run(failed).changes,1);
  assert.equal(status(),"payment_failed");
  assert.equal(run(authorized).changes,0,
    "Old amount_capturable webhook cannot turn a failed order back into authorized");
  assert.equal(run(canceled).changes,1);
  assert.equal(status(),"canceled");
  assert.equal(run(processing).changes,0);
  assert.equal(status(),"canceled");
  console.log("PASS: canonical Stripe state machine stays monotonic under canceled/refunded/paid event replay");
}finally{db.close();}
