/* eslint-disable prettier/prettier -- Exercise exact canonical D1 SQL guards. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const sql=readFileSync("drizzle/0087_paid_revocation_terminal_guard.sql","utf8");
const db=new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE entitlements(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE commercial_delivery_grants(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    INSERT INTO entitlements VALUES('revoked_entitlement','active'),('rollback_entitlement','active');
    INSERT INTO commercial_delivery_grants VALUES('delivery_revoked','active'),('delivery_expired','active'),('delivery_exhausted','active');
    INSERT INTO commerce_orders VALUES('order_canceled','pending_payment'),
      ('order_refunded','paid'),('order_chargeback','paid');`);
  db.exec(sql);
  db.exec(sql); // A redeployed migration must not replace or loosen guards.
  const value=(table,id)=>db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id).status;
  const set=(table,id,status)=>db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(status,id);
  const replay=(table,id,status)=>db.prepare(
    `INSERT INTO ${table}(id,status) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status`
  ).run(id,status);
  set("entitlements","revoked_entitlement","revoked");
  for(const resurrect of ["active","expired","suspended","draft"]){
    assert.throws(()=>set("entitlements","revoked_entitlement",resurrect),/fresh independently authorized purchase/);
    assert.throws(()=>replay("entitlements","revoked_entitlement",resurrect),/fresh independently authorized purchase/);
    assert.equal(value("entitlements","revoked_entitlement"),"revoked");
  }
  set("entitlements","revoked_entitlement","revoked"); // Idempotent denial replay.
  set("commercial_delivery_grants","delivery_revoked","revoked");
  set("commercial_delivery_grants","delivery_expired","expired");
  set("commercial_delivery_grants","delivery_exhausted","exhausted");
  for(const id of ["delivery_revoked","delivery_expired","delivery_exhausted"]){
    assert.throws(()=>set("commercial_delivery_grants",id,"active"),/cannot be reopened/);
    assert.throws(()=>replay("commercial_delivery_grants",id,"active"),/cannot be reopened/);
  }
  set("commercial_delivery_grants","delivery_expired","revoked");
  set("commercial_delivery_grants","delivery_exhausted","revoked");
  for(const [id,terminal] of [
    ["order_canceled","canceled"],["order_refunded","refunded"],["order_chargeback","chargeback_lost"]
  ]){
    set("commerce_orders",id,terminal);
    for(const positive of ["pending_payment","authorized","processing","paid","partially_refunded","payment_failed"]){
      assert.throws(()=>set("commerce_orders",id,positive),/cannot return to payable status/);
      assert.throws(()=>replay("commerce_orders",id,positive),/cannot return to payable status/);
      assert.equal(value("commerce_orders",id),terminal);
    }
  }
  // A provider reconciliation may still change one TERMINAL designation to
  // another, but cannot move via a positive/intermediate state.
  set("commerce_orders","order_canceled","refunded");
  assert.equal(value("commerce_orders","order_canceled"),"refunded");
  db.exec("BEGIN");
  try {
    set("entitlements","rollback_entitlement","revoked");
    assert.throws(()=>set("entitlements","revoked_entitlement","active"),/fresh independently authorized purchase/);
  }finally{db.exec("ROLLBACK");}
  assert.equal(value("entitlements","rollback_entitlement"),"active");
  for(const [table,id] of [
    ["entitlements","fresh_entitlement"],
    ["commercial_delivery_grants","fresh_delivery"],
    ["commerce_orders","fresh_order"]
  ]) {
    db.prepare(`INSERT INTO ${table}(id,status) VALUES(?,?)`).run(id,table==="commerce_orders"?"pending_payment":"active");
  }
  assert.equal(value("entitlements","fresh_entitlement"),"active");
  assert.equal(value("commercial_delivery_grants","fresh_delivery"),"active");
  console.log("PASS: exact canonical D1 payment, entitlement and media token terminal guards reject stale UPDATE and UPSERT, preserve rollback and fresh purchases");
}finally { db.close(); }
