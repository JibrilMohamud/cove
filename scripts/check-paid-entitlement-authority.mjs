/* eslint-disable prettier/prettier -- Stable paid entitlement authorization invariants. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

// The positive lease writer must verify the immutable purchase snapshot
// against the legal owner's independent product/market proof before commit.
const writer=fs.readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
for(const invariant of [
  "acquired.grantId!==rights[0].grant_id",
  "acquired.editionId!==rights[0].edition_id",
  "acquired.territory!==input.territory",
  "acquired.salesChannel!==input.channel",
  "acquired.contractId!==rights[0].contract_id",
  "acquired.contractVersionId!==rights[0].contract_version_id"
])assert.ok(writer.includes(invariant),"Missing immutable paid purchase scope: "+invariant);
const root=fs.mkdtempSync(path.join(os.tmpdir(),"cove-paid-owner-"));
try{
  const load=async(source,name)=>{
    const out=path.join(root,name+".mjs");
    await build({entryPoints:[source],outfile:out,bundle:true,platform:"node",
      target:"node22",format:"esm",logLevel:"silent"});
    return import(pathToFileURL(out).href);
  };
  const commercial=await load("src/storefront-strangler/commercial-legal-core.ts","product");
  const ent=await load("src/storefront-strangler/commercial-entitlement-core.ts","ent");
  const file=path.join(root,"authority.sqlite");
  let db=new DatabaseSync(file);
  const sql=()=>({exec(query,...params){
    const statement=db.prepare(query);
    const rows=/^\s*SELECT\b/i.test(query)?statement.all(...params):
      (statement.run(...params),[]);
    return {toArray:()=>rows};
  }});
  commercial.createCommercialAuthoritySchema(sql());
  ent.createPaidEntitlementSchema(sql());
  const productId="prd_commercial_a17",userId="user_paid_17",
    entitlementId="6e61cc19-3fd1-4b17-93b3-33f11b4bb9ad";
  const scope={entitlementId,userId,productId,orderId:"order_purchase_17"};
  const ctx={...scope,territory:"US",channel:"retail"};
  const verify=(input=ctx,now=new Date().toISOString())=>ent.readPaidAccess(sql(),input,now);
  const newProduct=()=>{
    const base=commercial.captureCommercialEpoch(sql(),{productId});
    return commercial.publishFreshCommercialProof(sql(),{
      productId,editionId:"ed_commercial_a17",territory:"US",channel:"retail",
      grantId:"right_valid_17",contractId:"rcontract_17",contractVersionId:"rcv_17",
      validUntil:new Date(Date.now()+1200000).toISOString()
    },base);
  };
  const lease=(productEpoch,orderId=scope.orderId)=>{
    const base=ent.captureEntitlementEpoch(sql(),scope);
    return ent.publishFreshEntitlement(sql(),{...ctx,orderId,productEpoch,
      validUntil:new Date(Date.now()+180000).toISOString()},base);
  };
  assert.equal(verify(),null,"No entitlement or product proof: deny");
  assert.deepEqual(newProduct(),{applied:true,epoch:1});
  assert.equal(verify(),null,"A paid product proof is NEVER a buyer entitlement");
  assert.deepEqual(lease(1),{applied:true,epoch:1});
  assert.deepEqual(lease(1),{applied:true,epoch:1},
    "Repeated primary-verified buyer lease must not churn the entitlement epoch");
  assert.equal(verify()?.grant_id,"right_valid_17");
  assert.equal(verify({ ...ctx,userId:"user_paid_18"}),null);
  assert.equal(verify({...ctx,territory:"CA"}),null);
  assert.equal(verify({...ctx,channel:"library"}),null);
  assert.equal(verify(ctx,new Date(Date.now()+240000).toISOString()),null,
    "Expired buyer proof cannot be served by a stale cache");
  assert.throws(()=>ent.captureEntitlementEpoch(sql(),{
    ...scope,userId:"user_paid_18"
  }),/paid_entitlement_scope_changed/);
  assert.deepEqual(commercial.denyCommercialProduct(sql(),{
    productId,operationId:"contract:17:withdraw"
  }),{applied:true,epoch:2});
  assert.equal(verify(),null,"Immediate contract/product withdrawal revokes read access");
  assert.throws(()=>lease(1),/paid_entitlement_product_epoch_stale/,
    "A stale canonical D1 read cannot acknowledge a positive buyer grant after owner withdrawal");
  assert.deepEqual(newProduct(),{applied:true,epoch:3});
  assert.equal(verify(),null,"Regranting a product cannot resurrect stale purchased entitlement");
  assert.deepEqual(lease(3),{applied:true,epoch:2});
  assert.deepEqual(lease(3),{applied:true,epoch:2},
    "Renewal after fresh rights epoch must preserve new buyer epoch");
  assert.equal(verify()?.entitlement_epoch,2);
  const staleEntBase=ent.captureEntitlementEpoch(sql(),scope);
  assert.deepEqual(ent.denyPaidEntitlement(sql(),{
    ...scope,operationId:"refund:paid_17:revoked"
  }),{applied:true,epoch:3});
  assert.equal(verify(),null,"Refund fence invalidates even a product-still-allowed proof");
  assert.throws(()=>ent.publishFreshEntitlement(sql(),{...ctx,productEpoch:3,
    validUntil:new Date(Date.now()+180000).toISOString()},staleEntBase),
    /paid_entitlement_revocation_terminal/,
    "Old Stripe webhook cannot regrant revoked entitlement even with a stale base epoch");
  assert.deepEqual(ent.denyPaidEntitlement(sql(),{
    ...scope,operationId:"refund:paid_17:revoked"
  }),{applied:true,epoch:3},"Refund retry is idempotent");
  assert.throws(()=>ent.denyPaidEntitlement(sql(),{
    ...scope,entitlementId:"ent_other_18",operationId:"refund:paid_17:revoked"
  }),/paid_entitlement_denial_collision/);
  db.close();db=new DatabaseSync(file);
  assert.equal(verify(),null,"Revoked buyer state must persist across DO restarts");
  assert.throws(()=>lease(3),/paid_entitlement_revocation_terminal/,
    "Lagging primary D1 must never resurrect a revoked buyer identity");
  assert.equal(verify(),null,"Restart and stale positive retries preserve denial");
  assert.deepEqual(ent.denyPaidEntitlement(sql(),{
    ...scope,operationId:"refund:paid_17:revoked"
  }),{applied:true,epoch:3},
    "Owner denial remains monotonic and idempotent across restarts");
  assert.deepEqual(ent.denyPaidOrder(sql(),{
    orderId:scope.orderId,operationId:"order-refund:purchase17"
  }),{applied:true,orderId:scope.orderId});
  assert.equal(verify(),null,"One owner order denial revokes every entitlement backed by it");
  assert.deepEqual(ent.denyPaidOrder(sql(),{
    orderId:scope.orderId,operationId:"order-refund:purchase17"
  }),{applied:true,orderId:scope.orderId},"Full-order refund replay is idempotent");
  assert.throws(()=>lease(3),/paid_order_already_revoked/,
    "A refunded order can NEVER regrant access, even after re-verification");
  assert.throws(()=>lease(3,"order_purchase_new_18"),
    /paid_entitlement_revocation_terminal/,
    "A new order cannot launder a revoked entitlement ID");
  const newPurchase={...ctx,
    entitlementId:"217ae8bb-bbf0-4cea-bcdb-b776189af818",
    orderId:"order_purchase_new_18"};
  assert.deepEqual(ent.publishFreshEntitlement(sql(),{
    ...newPurchase,productEpoch:3,
    validUntil:new Date(Date.now()+180000).toISOString()
  },0),{applied:true,epoch:1});
  assert.equal(ent.readPaidAccess(sql(),{...newPurchase,
    territory:"US",channel:"retail"})?.entitlement_epoch,1,
    "A new paid order must use its own distinct entitlement identity");
  assert.equal(verify(),null,"Refunded entitlement ID must remain denied");
  assert.throws(()=>ent.denyPaidOrder(sql(),{
    orderId:"another_purchase_18",operationId:"order-refund:purchase17"
  }),/paid_order_denial_scope_collision/);
  db.close();
  console.log("PASS: paid entitlement proof one indexed owner read, exact buyer, contract product epoch, refund, stale webhook, territory, TTL, persistence and replay");
}finally{fs.rmSync(root,{recursive:true,force:true});}
