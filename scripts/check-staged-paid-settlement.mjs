/* eslint-disable prettier/prettier -- Security decision regression uses strict, explicit fake private owner ports. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(path.join(os.tmpdir(),"cove-paid-settlement-owner-"));
try{
  const outfile=path.join(directory,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/paid-settlement-publication.server.ts"],
    outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {certifyStagePaidSettlement:certify,
    assertStagePaidOrderNotWithdrawn:preflight}=await import(pathToFileURL(outfile).href);
  const orderId="order_purchase_17",userId="user_purchase_17",
    productId="prd_commercial_a17",entitlementId="2be93243-1057-4fdc-a393-f8666bd97378";
  const order={id:orderId,user_id:userId,territory_code:"US",status:"pending_payment"};
  const items=[
    {id:"item_paid_17",product_id:productId,sales_channel:"retail",
      entitlement_status:"granted",preorder_id:null,entitlement_id:entitlementId,
      rights_grant_id:"grant_17",
      rights_snapshot_json:JSON.stringify({grantId:"grant_17",editionId:"ed_17",
        contractId:"contract_17",contractVersionId:"version_17",
        territory:"US",salesChannel:"retail"})},
    {id:"item_preorder_18",product_id:"prd_commercial_b18",sales_channel:"retail",
      entitlement_status:"pending",preorder_id:"preorder_18",entitlement_id:null}
  ];
  let calls=[],reads=0,ownerStatus=200,ownerPayload={applied:true,epoch:1};
  let veto=false,orderChecks=0;
  let rightsRows=[{product_id:productId,edition_id:"ed_17",grant_id:"grant_17",
    contract_id:"contract_17",contract_version_id:"version_17",
    epoch:1,valid_until:new Date(Date.now()+900000).toISOString()}];
  const db={prepare(sql){
    return {bind(...args){
      return {
        async first(){
          reads++;
          assert.match(sql,/FROM commerce_orders WHERE id=/);
          assert.deepEqual(args.length===1?args:[...args],
            args.length===1?[orderId]:[orderId,userId]);
          return order;
        },
        async all(){
          reads++;
          if(sql.includes("FROM commerce_order_items WHERE order_id=?")){
            assert.deepEqual(args,[orderId]);
            return {results:items};
          }
          assert.match(sql,/FROM commerce_order_items oi/);
          assert.deepEqual(args,[userId,orderId]);
          return {results:items};
        }
      };
    }};
  }};
  const owner={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(request){
      const supplied=await request.json();
      const route=new URL(request.url).pathname;
      assert.equal(request.headers.get("authorization"),"Bearer "+"a".repeat(64));
      if(route==="/commercial/order/verify"){
        orderChecks++;
        assert.deepEqual(supplied,{orderId});
        return Response.json({
          schema:"cove.paid-order-permission.v1",orderId,allowed:!veto
        },{status:ownerStatus});
      }
      calls.push({path:route,body:supplied});
      if(route==="/commercial/authorize-batch"){
        assert.deepEqual(supplied,{ids:[productId],territory:"US",channel:"retail"});
        return Response.json({schema:"cove.commercial-legal.v1",rows:rightsRows},
          {status:ownerStatus});
      }
      return Response.json(ownerPayload,{status:ownerStatus});
    }};
  }};
  const env={
    DB:db,COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64),LEGAL_AUTHORITY:owner
  };
  await certify({...env,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},orderId,userId);
  await preflight({...env,COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"},orderId);
  assert.equal(reads,0,"Production/default-off path must never contact staged legal or D1");
  assert.equal(orderChecks,0);
  await preflight(env,orderId);
  assert.equal(orderChecks,1,"Owner must confirm no previous refunded-order veto");
  assert.equal(calls.length,1,"Preflight must check live paid market rights");
  rightsRows=[];
  await assert.rejects(preflight(env,orderId),e=>e.status===451,
    "Owner must refuse a stale checkout snapshot before Stripe tender");
  rightsRows=[{product_id:productId,edition_id:"ed_17",grant_id:"grant_17",
    contract_id:"contract_17",contract_version_id:"version_17",
    epoch:1,valid_until:new Date(Date.now()+900000).toISOString()}];
  rightsRows[0].valid_until="not-a-date";
  await assert.rejects(preflight(env,orderId),e=>e.status===451,
    "Malformed legal proof expiries must never authorize payment");
  rightsRows[0].valid_until=new Date(Date.now()+900000).toISOString();
  // The canonical-schema QA owner now exercises the exact staged settlement
  // contract; the prod database must remain impossible to opt into.
  await preflight({...env,COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"},orderId);
  await assert.rejects(preflight({...env,COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},orderId),
    e=>e.status===503,"Customer production DB cannot borrow stage paid ownership");
  const originalSnapshot=items[0].rights_snapshot_json;
  items[0].rights_snapshot_json="{}";
  await assert.rejects(preflight(env,orderId),e=>e.status===451,
    "Unverified or changed acquisition scope may not charge the buyer");
  items[0].rights_snapshot_json=originalSnapshot;
  veto=true;
  await assert.rejects(preflight(env,orderId),e=>e.status===409,
    "Strong owner tombstone must reject a new settlement BEFORE tender mutation");
  veto=false;ownerStatus=503;
  await assert.rejects(preflight(env,orderId),e=>e.status===503,
    "Owner outage before Stripe settlement must not permit local ledger writes");
  ownerStatus=200;
  await assert.rejects(preflight({...env,COVE_SSR_STAGING:"0"},orderId),
    e=>e.status===503,"Production cannot borrow a temporary staging owner");
  await assert.rejects(certify({...env,COVE_SSR_STAGING:"0"},orderId,userId),
    e=>e.status===503,"Never enable an isolated owner via a production environment");
  order.status="paid";calls=[];
  await certify(env,orderId,userId);
  assert.ok(reads>=4,"Both canonical preflight and post-settlement proof read D1");
  assert.deepEqual(calls,[{path:"/commercial/entitlement/publish-verified",
    body:{entitlementId,userId,productId,territory:"US",channel:"retail"}}],
    "Only an exact paid buyer entitlement is sent for canonical verification");
  await certify(env,orderId,userId);
  assert.equal(calls.length,2,"Already-paid Stripe event must retry owner reconciliation");
  await certify({...env,COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"},orderId,userId);
  assert.equal(calls.length,3,"Full-schema QA settlement requires exact owner publication");
  await assert.rejects(certify({...env,COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},orderId,userId),
    e=>e.status===503,"Production D1 cannot enable a temporary staging settlement owner");
  ownerStatus=503;
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "Owner outage must never be accepted as successful payment authorization");
  ownerStatus=200;ownerPayload={applied:false,epoch:1};
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "A stale or rejected owner publication receipt must fail closed");
  ownerPayload={applied:true,epoch:0};
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "Invalid owner epoch is not a paid access proof");
  ownerPayload={applied:true,epoch:1};
  order.status="refunded";
  await assert.rejects(certify(env,orderId,userId),e=>e.status===409,
    "A refunded order can never publish a new positive buyer entitlement");
  order.status="paid";items[0].sales_channel="subscription";
  await assert.rejects(certify(env,orderId,userId),e=>e.status===409,
    "Paid retail settlement must not launder a subscription grant");
  items[0].sales_channel="retail";items[0].entitlement_id=null;
  await assert.rejects(certify(env,orderId,userId),e=>e.status===409,
    "A paid canonical order without a linked active entitlement cannot publish");
  items[0].entitlement_id=entitlementId;
  items.push(...Array.from({length:24},(_,i)=>({...items[0],id:"extra_"+i})));
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "Unbounded payment line fanout must fail closed");
  items.length=2;
  const secondEntitlementId="21ea0be4-3b77-4ba3-a8f3-a992d7280c2e";
  const secondProductId="prd_commercial_second_19";
  items.push({...items[0],
    id:"item_paid_19",product_id:secondProductId,
    entitlement_id:secondEntitlementId});
  const complete={applied:true,orderId,receipts:[
    {entitlementId,epoch:1},
    {entitlementId:secondEntitlementId,epoch:1}
  ]};
  ownerPayload=complete;calls=[];
  await certify(env,orderId,userId);
  assert.deepEqual(calls,[{
    path:"/commercial/entitlement/publish-order-verified",
    body:{orderId,userId,territory:"US",channel:"retail"}
  }],"A two-book order must use exactly ONE canonical-verified strong-owner RPC");
  ownerPayload={...complete,receipts:complete.receipts.slice(0,1)};
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "A partial paid-order receipt cannot authorize ANY cart completion");
  ownerPayload={...complete,receipts:[
    {entitlementId,epoch:1},{entitlementId,epoch:1}
  ]};
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "Duplicate buyer receipts cannot masquerade as complete cart authorization");
  ownerStatus=503;ownerPayload=complete;
  await assert.rejects(certify(env,orderId,userId),e=>e.status===503,
    "Owner outage during atomic multi-book settlement must never allow partial access");
  ownerStatus=200;
  items[2].entitlement_status="pending";
  await assert.rejects(certify(env,orderId,userId),e=>e.status===409,
    "A missing canonical paid item blocks the entire multi-book cart");
  const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
  const payment=commerce.slice(commerce.indexOf("export async function finalizePaidOrder("),
    commerce.indexOf("export async function recoverPayment("));
  assert.ok(payment.indexOf("Terminal or invalid order cannot be settled.")>=0 &&
    payment.indexOf("Terminal or invalid order cannot be settled.") <
    payment.indexOf("return settleStageOwnerPaidOrder"),
    "An invalid terminal signed payment must be rejected before private owner settlement");
  assert.ok(commerce.includes("await assertStagePaidOrderNotWithdrawn(env, orderId)"),
    "Checkout must check strong-owner withdrawal before reserving tender");
  assert.ok(payment.indexOf("await certifyStagePaidSettlement")>=0,
    "No paid order may silently omit independent owner publication");
  const refund=commerce.slice(commerce.indexOf("async function completeRequestedRefund("),
    commerce.indexOf("async function stageRevokeRefundEntitlements("));
  assert.ok(refund.indexOf("await stageRevokeRefundEntitlements")>=0 &&
    refund.indexOf("await stageRevokeRefundEntitlements")<refund.indexOf('stripeRequest(env, "refunds"'),
    "Stage must withdraw paid access before the Stripe provider begins refunding");
  const delivery=readFileSync("src/features/fore/delivery.server.ts","utf8");
  assert.equal((delivery.match(/await requireStagePaidEntitlementAccess\(env,/g)||[]).length,2,
    "Original paid delivery must query owner at BOTH grant issuance and byte redemption");
  console.log("PASS: staged paid handoff requires one atomic full-order receipt; rejects incomplete, duplicate and unavailable owner proofs");
}finally{rmSync(directory,{force:true,recursive:true});}
