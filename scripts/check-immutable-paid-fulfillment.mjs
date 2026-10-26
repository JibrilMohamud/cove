/* eslint-disable prettier/prettier -- Exact canonical upsert semantics are an immutable order/entitlement boundary. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
const match=commerce.match(/`(INSERT INTO entitlements\(id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at\)[^`]+)`/);
assert.ok(match,"Cannot find canonical paid-entitlement upsert");
assert.ok(match[1].includes("WHERE entitlements.order_item_id=excluded.order_item_id"),
  "Existing purchases may never move to another order item");
assert.ok(match[1].includes("entitlements.status='active'"),
  "Refunded/revoked purchases must not be resurrected by old Stripe replay");
assert.ok(commerce.includes("affectedEntitlement.meta?.changes"),
  "Settlement must reject an unfulfilled or conflicting canonical entitlement write");

const db=new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE entitlements(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,product_id TEXT NOT NULL,
    entitlement_type TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,
    order_item_id TEXT,granted_at TEXT,updated_at TEXT,
    UNIQUE(user_id,product_id,entitlement_type)
  )`);
  const write=db.prepare(match[1]);
  const insert=(id,orderItem,user="user_1",product="prd_paid_1")=>
    write.run(id,user,product,orderItem,new Date().toISOString(),new Date().toISOString()).changes;
  assert.equal(insert("ent_1","item_original"),1);
  assert.equal(insert("ent_2","item_original"),1,"Identical Stripe replay is idempotent");
  assert.deepEqual({...db.prepare("SELECT id,order_item_id,status FROM entitlements WHERE user_id='user_1'").get()},
    {id:"ent_1",order_item_id:"item_original",status:"active"},
    "Idempotent replay never replaces the canonical entitlement identity");
  assert.equal(insert("ent_other","item_new_purchase"),0,
    "A second order may not reassign the first order's buyer entitlement");
  assert.equal(db.prepare("SELECT order_item_id FROM entitlements WHERE id='ent_1'").get().order_item_id,
    "item_original");
  db.prepare("UPDATE entitlements SET status='revoked' WHERE id='ent_1'").run();
  assert.equal(insert("ent_old_webhook","item_original"),0,
    "An old successful payment event may not revive a revoked entitlement");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id='ent_1'").get().status,"revoked");
  assert.equal(insert("ent_other_product","item_other","user_1","prd_paid_2"),1,
    "Independent product remains grantable");
  console.log("PASS: canonical Stripe fulfillment preserves immutable order-item ownership, rejects cross-order laundering and terminal refund resurrection");
} finally {db.close();}
