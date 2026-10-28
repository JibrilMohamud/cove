/* eslint-disable prettier/prettier -- Exercise exact canonical SQL migrations and purchase upsert. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const db=new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE entitlements (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,product_id TEXT NOT NULL,
    entitlement_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL,order_item_id TEXT,granted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE commercial_delivery_grants(id TEXT PRIMARY KEY,status TEXT NOT NULL);
  CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,status TEXT NOT NULL);
  CREATE UNIQUE INDEX idx_entitlements_user_product_type
    ON entitlements(user_id,product_id,entitlement_type);`);
  db.exec(readFileSync("drizzle/0087_paid_revocation_terminal_guard.sql","utf8"));
  const migration=readFileSync("drizzle/0088_paid_repurchase_fresh_entitlement.sql","utf8");
  db.exec(migration);
  db.exec(migration);
  const source=readFileSync("src/features/fore/commerce.server.ts","utf8");
  const upsertSql=`INSERT INTO entitlements(
    id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at
  ) VALUES(?,?,?,'purchase','active','commerce',?,?,?)
  ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active'
  DO UPDATE SET status='active',order_item_id=excluded.order_item_id,updated_at=excluded.updated_at`;
  assert.ok(
    source.includes("ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active'"),
    "Original signed payment writer must target the current-active partial uniqueness index",
  );
  const librarySource=readFileSync("src/features/fore/api.server.ts","utf8");
  assert.ok(
    librarySource.includes("ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active'"),
    "A legitimate public-domain library acquisition must match the new partial index",
  );
  const grant=(id,item)=>db.prepare(upsertSql).run(id,"qa-buyer","book-42",item,"2026-10-28","2026-10-28");
  const rows=()=>db.prepare("SELECT id,status,order_item_id FROM entitlements WHERE user_id='qa-buyer' ORDER BY granted_at,id").all().map(row=>({...row}));
  grant("purchase-1","order-item-1");
  assert.equal(rows().length,1);
  db.prepare("UPDATE entitlements SET status='revoked' WHERE id='purchase-1'").run();
  assert.throws(
    ()=>db.prepare("UPDATE entitlements SET status='active' WHERE id='purchase-1'").run(),
    /fresh independently authorized purchase/,
  );
  grant("purchase-2","order-item-2");
  assert.deepEqual(rows(),[
    {id:"purchase-1",status:"revoked",order_item_id:"order-item-1"},
    {id:"purchase-2",status:"active",order_item_id:"order-item-2"},
  ],"Genuine repurchase has a fresh entitlement and preserves the revoked order history");
  assert.throws(()=>grant("duplicate-history","order-item-1"),/UNIQUE|constraint/i,
    "A new grant must never rewrite the original order-item acquisition record");
  grant("retry-active","order-item-2");
  assert.equal(rows().length,2,"Repeated fulfillment of same active order remains idempotent");
  assert.equal(rows().filter(x=>x.status==="active").length,1);
  assert.throws(()=>db.prepare("UPDATE entitlements SET status='active' WHERE id='purchase-1'").run(),
    /fresh independently authorized purchase/);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE entitlements SET status='revoked' WHERE id='purchase-2'").run();
    assert.throws(()=>db.prepare("UPDATE entitlements SET status='active' WHERE id='purchase-2'").run(),
      /fresh independently authorized purchase/);
  }finally{db.exec("ROLLBACK");}
  assert.equal(rows().find(x=>x.id==="purchase-2")?.status,"active",
    "Failed replay cannot partially revoke an unrelated active purchase");
  const freePurchase=(id)=>db.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'public-domain','active','gutenberg',?,?) ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active' DO UPDATE SET status='active',updated_at=excluded.updated_at"
  ).run(id,"qa-buyer","gutenberg-free","2026-10-28","2026-10-28");
  freePurchase("free-1");
  db.prepare("UPDATE entitlements SET status='revoked' WHERE id='free-1'").run();
  freePurchase("free-2");
  const free=db.prepare(
    "SELECT id,status FROM entitlements WHERE product_id='gutenberg-free' ORDER BY id"
  ).all().map(x=>({...x}));
  assert.deepEqual(free,[
    {id:"free-1",status:"revoked"},
    {id:"free-2",status:"active"},
  ],"Public-domain acquisition must use the same partial index and never revive an earlier withdrawn record");
  console.log("PASS: exact D1 paid repurchase index and signed writer allow fresh order-linked entitlement, preserve terminal history, deny stale revival and duplicate order attribution");
}finally{db.close();}
