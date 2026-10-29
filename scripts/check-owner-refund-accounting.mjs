/* eslint-disable prettier/prettier -- Owner accounting is deny-first, exact-scope and replay-safe. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(join(tmpdir(),"cove-refund-owner-executor-"));
try {
  const outfile=join(folder,"executor.mjs");
  await build({entryPoints:["src/storefront-strangler/refund-accounting-owner-executor.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {executeOwnerRefundAccounting:execute}=await import(pathToFileURL(outfile).href);
  const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
  const legacyRoyaltyGuard='if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1")';
  const position=commerce.indexOf(legacyRoyaltyGuard);
  assert.ok(position>=0&&commerce.slice(position,position+155)
    .includes("await reverseRoyaltiesForRefund(db, r.id);"),
    "Enrolled stage owner must own all refund royalty reversals, with no parallel legacy D1 posting");
  const orderId="order_accounting_01",refundId="ref_accounting_01";
  function fixture({denied=true,stripeAmount=100,status="succeeded",provider="re_owner_refund_01",royaltyRows=false,failRoyaltyOnce=false}={}){
    let batchCount=0,posted=false,firstCount=0,royaltyBatches=0,royaltyPostedId=null,royaltyFailures=0;
    const refund={id:refundId,order_id:orderId,status,succeeded_at:null,
      provider_refund_id:provider,stripe_amount_minor:stripeAmount,
      amount_minor:100,gift_card_amount_minor:0,store_credit_amount_minor:100-stripeAmount,currency:"USD"};
    const order={id:orderId,user_id:"buyer_owner_accounting",currency:"USD",
      total_minor:100,refunded_minor:0,tax_minor:0,tax_inclusive_minor:0,status:"paid"};
    const db={prepare(sql){
      const statement={sql,bind(...args){
        const bound={sql,args,async first(){
          firstCount++;
          if(sql.startsWith("SELECT id FROM finance_royalty_calculations WHERE source_type="))
            return royaltyPostedId?{id:royaltyPostedId}:null;
          if(sql.startsWith("SELECT id,order_id,status"))return refund;
          if(sql.startsWith("SELECT * FROM commerce_refunds"))return refund;
          if(sql.startsWith("SELECT * FROM commerce_orders"))return order;
          if(sql.startsWith("SELECT id,order_id,succeeded_at FROM commerce_refunds"))
            return {...refund,succeeded_at:posted?"2026-10-29T00:00:00.000Z":null};
          return null;
        },async all(){
          if(sql.startsWith("SELECT * FROM finance_royalty_calculations WHERE order_id="))
            return {results:royaltyRows?[{
              id:"roy_sale_01",order_id:orderId,order_item_id:"item_01",product_id:"prd_owner_01",
              currency:"USD",customer_price_minor:100,basis_minor:90,royalty_pool_minor:20,
              list_price_minor:100,quantity:1,territory_code:"US",sales_channel:"retail"
            }]:[]};
          if(sql.startsWith("SELECT * FROM finance_royalty_allocations WHERE calculation_id="))
            return {results:[]};
          throw Error("unexpected_refund_owner_read:"+sql);
        },async run(){throw Error("All finance writes must be in atomic batch");}};
        return bound;
      }};
      return statement;
    },async batch(statements){
      if(statements[0]?.sql.startsWith("INSERT INTO finance_royalty_calculations")){
        royaltyBatches++;
        if(failRoyaltyOnce&&royaltyFailures++===0)throw Error("royalty_db_unavailable");
        royaltyPostedId=statements[0].args[0];
        return statements.map(()=>({meta:{changes:1}}));
      }
      assert.ok(statements.length>=7);
      assert.ok(statements.at(-1).sql.startsWith("UPDATE commerce_refunds SET status='succeeded'"));
      batchCount++;
      posted=true;refund.succeeded_at="2026-10-29T00:00:00.000Z";
      return statements.map(()=>({meta:{changes:1}}));
    }};
    const ownerSql={exec(query,...values){
      assert.match(query,/cove_paid_refunded_orders/);
      assert.deepEqual(values,[orderId]);
      return {toArray:()=>denied?[{ok:1}]:[]};
    }};
    return {db,ownerSql,refund,counts:()=>({batchCount,firstCount,royaltyBatches})};
  }
  const negative=[
    {orderId,refundId,sql:"DELETE FROM commerce_orders"},
    {orderId:"order_wrong_buyer_01",refundId},
    {orderId,refundId:"ref_bad/../refund"},
    {orderId,refundId,entitlementId:"ent_forged"}
  ];
  const f=fixture();
  for(const invalid of negative)await assert.rejects(()=>execute(f.db,f.ownerSql,invalid));
  assert.equal(f.counts().batchCount,0);
  const live=fixture();
  assert.deepEqual(await execute(live.db,live.ownerSql,{orderId,refundId},"2026-10-29T00:00:00Z"),
    {schema:"cove.owner-refund-accounting.v1",ownerDenied:true,posted:true,
      orderId,refundId,applied:true,royaltiesReconciled:true});
  assert.equal(live.counts().batchCount,1);
  const repeat=await execute(live.db,live.ownerSql,{orderId,refundId},"2026-10-29T00:00:01Z");
  assert.equal(repeat.posted,true);assert.equal(repeat.applied,false);
  assert.equal(live.counts().batchCount,1,"Replays must not post a second financial ledger");
  const noVeto=fixture({denied:false});
  await assert.rejects(()=>execute(noVeto.db,noVeto.ownerSql,{orderId,refundId}),
    /owner_refund_denial_required/);
  assert.equal(noVeto.counts().batchCount,0);
  for(const bad of [
    {status:"pending",provider:"re_pending_01"},{status:"succeeded",provider:null},
    {status:"succeeded",provider:"stripe_invalid"}
  ]){
    const f=fixture(bad);
    await assert.rejects(()=>execute(f.db,f.ownerSql,{orderId,refundId}),
      /owner_refund_provider_not_confirmed/);
    assert.equal(f.counts().batchCount,0);
  }
  const internal=fixture({stripeAmount:0,status:"pending",provider:null});
  assert.equal((await execute(internal.db,internal.ownerSql,{orderId,refundId})).posted,true,
    "No provider receipt required for an all-internal-tender refund under durable owner veto");
  const partial=fixture({royaltyRows:true,failRoyaltyOnce:true});
  await assert.rejects(()=>execute(partial.db,partial.ownerSql,{orderId,refundId}),
    /royalty_db_unavailable/);
  assert.equal(partial.counts().batchCount,1,
    "Refund atomic posting completes, but owner must not ACK until royalty projection settles");
  assert.equal(partial.counts().royaltyBatches,1);
  const repaired=await execute(partial.db,partial.ownerSql,{orderId,refundId});
  assert.equal(repaired.applied,false,"Retry must not post the refund ledger twice");
  assert.equal(repaired.royaltiesReconciled,true);
  assert.equal(partial.counts().batchCount,1);
  assert.equal(partial.counts().royaltyBatches,2);
  await execute(partial.db,partial.ownerSql,{orderId,refundId});
  assert.equal(partial.counts().royaltyBatches,2,
    "A completed royalty reversal must not create a duplicate after replay");
  const unavailable=fixture();
  unavailable.db.batch=async()=>{throw Error("canonical_D1_unavailable");};
  await assert.rejects(()=>execute(unavailable.db,unavailable.ownerSql,{orderId,refundId}),
    /canonical_D1_unavailable/);
  console.log("PASS: owner-first refund AND royalty executor handles provider proof, durable denial, atomic accounting, royalty failure after posting, exact replay and D1 outage");
}finally {rmSync(folder,{recursive:true,force:true});}
