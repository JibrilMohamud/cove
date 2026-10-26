/* eslint-disable prettier/prettier -- Security decision regression uses strict, explicit fake private owner ports. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
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
  const order={id:orderId,user_id:userId,territory_code:"US",status:"paid"};
  const items=[
    {id:"item_paid_17",product_id:productId,sales_channel:"retail",
      entitlement_status:"granted",preorder_id:null,entitlement_id:entitlementId},
    {id:"item_preorder_18",product_id:"prd_commercial_b18",sales_channel:"retail",
      entitlement_status:"pending",preorder_id:"preorder_18",entitlement_id:null}
  ];
  let calls=[],reads=0,ownerStatus=200,ownerPayload={applied:true,epoch:1};
  let veto=false,orderChecks=0;
  const db={prepare(sql){
    return {bind(...args){
      return {
        async first(){
          reads++;
          assert.match(sql,/FROM commerce_orders WHERE id=/);
          assert.deepEqual(args,[orderId,userId]);
          return order;
        },
        async all(){
          reads++;
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
  await certify(env,orderId,userId);
  assert.equal(reads,2);
  assert.deepEqual(calls,[{path:"/commercial/entitlement/publish-verified",
    body:{entitlementId,userId,productId,territory:"US",channel:"retail"}}],
    "Only an exact paid buyer entitlement is sent for canonical verification");
  await certify(env,orderId,userId);
  assert.equal(calls.length,2,"Already-paid Stripe event must retry owner reconciliation");
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
  console.log("PASS: signed-payment owner handoff is buyer-scoped, staging-gated, retry-safe, and refuses stale grants, offline owners, refunds and unbounded orders");
}finally{rmSync(directory,{force:true,recursive:true});}
