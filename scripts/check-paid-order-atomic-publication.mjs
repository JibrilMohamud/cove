/* eslint-disable prettier/prettier -- Multi-book paid grant publication must be all-or-nothing. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(path.join(os.tmpdir(),"cove-paid-atomic-"));
try{
  const load=async(source,name)=>{
    const file=path.join(folder,name+".mjs");
    await build({entryPoints:[source],outfile:file,bundle:true,
      format:"esm",platform:"node",target:"node22",logLevel:"silent"});
    return import(pathToFileURL(file).href);
  };
  const legal=await load("src/storefront-strangler/commercial-legal-core.ts","rights");
  const ent=await load("src/storefront-strangler/commercial-entitlement-core.ts","buyer");
  const market=await load("src/storefront-strangler/market-authority-core.ts","market");
  const atomic=await load("src/storefront-strangler/paid-order-atomic-publication.ts","atomic");
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...bindings){
    const q=db.prepare(statement);
    const result=/^\s*SELECT\b/i.test(statement)?q.all(...bindings):
      (q.run(...bindings),[]);
    return {toArray:()=>result};
  }};
  ent.createPaidEntitlementSchema(sql);
  legal.createCommercialAuthoritySchema(sql);
  market.createMarketAuthoritySchema(sql);
  const userId="user_atomic_20261027",orderId="order_atomic_20261027";
  const future=new Date(Date.now()+5*60_000).toISOString();
  const products=["prd_atomic_book_a","prd_atomic_book_b"];
  const lines=products.map((productId,i)=>({
    productId,userId,orderId,entitlementId:"ent_atomic_receipt_"+i+"_20261027",
    territory:"US",channel:"retail",
    productEpoch:1,expectedEpoch:0,validUntil:future
  }));
  const issueRights=(id)=>{
    const epoch=legal.captureCommercialEpoch(sql,{productId:id});
    return legal.publishFreshCommercialProof(sql,{
      productId:id,editionId:"ed_"+id,
      territory:"US",channel:"retail",grantId:"grant_"+id,
      contractId:"contract_atomic_20261027",contractVersionId:"version_atomic_20261027",
      validUntil:future
    },epoch);
  };
  for(const product of products)assert.equal(issueRights(product).applied,true);
  const transaction=(entries)=>{
    db.exec("BEGIN");
    try{
      const receipt=atomic.publishVerifiedPaidOrderAtomic(sql,entries);
      db.exec("COMMIT");
      return receipt;
    }catch(error){
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const check=(item)=>{
    const q=ent.readPaidAccess(sql,item);
    return !!q;
  };
  assert.equal(check(lines[0]),false);
  assert.equal(check(lines[1]),false);
  const invalid=[lines[0],{...lines[1],productEpoch:999}];
  assert.throws(()=>transaction(invalid),/paid_entitlement_product_epoch_stale/);
  assert.equal(check(lines[0]),false,
    "DO transaction must roll back even earlier successfully published item");
  assert.equal(check(lines[1]),false);
  assert.throws(()=>transaction([lines[0],lines[0]]),
    /invalid_paid_order_atomic_line/);
  assert.throws(()=>transaction([lines[0],{...lines[1],userId:"unauthorized_user"}]),
    /invalid_paid_order_atomic_line/);
  const publication=transaction(lines);
  assert.equal(publication.applied,true);
  assert.equal(publication.orderId,orderId);
  assert.equal(publication.receipts.length,2);
  assert.deepEqual(publication.receipts.map(x=>x.epoch),[1,1]);
  assert.equal(check(lines[0]),true);
  assert.equal(check(lines[1]),true);
  const replay=transaction(lines.map(x=>({...x,expectedEpoch:1})));
  assert.deepEqual(replay.receipts.map(x=>x.epoch),[1,1],
    "Immutable Stripe replay must not churn either buyer epoch");
  ent.denyPaidEntitlement(sql,{...lines[1],operationId:"qa:atomic:buyer-revoke"});
  assert.equal(check(lines[1]),false);
  assert.throws(()=>transaction(lines.map((x,i)=>({...x,expectedEpoch:i===0?1:2}))),
    /paid_entitlement_revocation_terminal/);
  assert.equal(check(lines[0]),true,
    "Failed replacement transaction must leave the previous valid proof intact");
  ent.denyPaidOrder(sql,{orderId,operationId:"qa:atomic:refund"});
  assert.equal(check(lines[0]),false);
  assert.equal(check(lines[1]),false);
  assert.throws(()=>transaction(lines.map((x,i)=>({...x,expectedEpoch:i===0?1:2}))),
    /paid_order_already_revoked/);
  const nextOrder="order_atomic_other_20261027";
  assert.throws(()=>transaction(lines.map(x=>({...x,orderId:nextOrder}))),
    /paid_entitlement_order_swap_forbidden|paid_entitlement_revocation_terminal/);

  // A single owner tombstone disables both historical paid proofs without
  // changing either entitlement row or publication revision in primary D1.
  const db2=new DatabaseSync(":memory:");
  const sql2={exec(statement,...args){
    const q=db2.prepare(statement);
    return {toArray:()=>/^\s*SELECT\b/i.test(statement)?q.all(...args):
      (q.run(...args),[])};
  }};
  ent.createPaidEntitlementSchema(sql2);
  legal.createCommercialAuthoritySchema(sql2);
  market.createMarketAuthoritySchema(sql2);
  market.denyMarket(sql2,{territory:"US",operationId:"qa:atomic:market-revoke"});
  assert.throws(()=>atomic.publishVerifiedPaidOrderAtomic(sql2,lines),
    /paid_order_market_withdrawn/);
  db2.close();db.close();
  console.log("PASS: strong-owner atomic 2-book paid publication; failed later line rolls back first; replay, buyer revoke, refund and market veto");
}finally{rmSync(folder,{recursive:true,force:true});}
