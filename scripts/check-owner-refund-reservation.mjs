/* eslint-disable prettier/prettier -- Deterministic private owner refund reservation regression. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(join(tmpdir(),"cove-owner-refund-reservation-"));
try{
  const outfile=join(folder,"reserve.mjs");
  await build({entryPoints:["src/storefront-strangler/refund-reservation-owner-executor.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {executeOwnerRefundReservation:execute}=await import(pathToFileURL(outfile).href);
  const request={orderId:"order_refund_reserve_01",reason:"requested_by_customer",
    idempotencyKey:"idempotent-owner-refund-001"};
  function fixture({stripe=600,store=300,gift=100,orderStatus="paid",failInsert=false,concurrent=false}={}){
    const refunds=new Map();let inserts=0,failed=false;
    const order={id:request.orderId,status:orderStatus,currency:"USD",total_minor:1000,
      stripe_due_minor:stripe,store_credit_minor:store,gift_card_minor:gift,
      stripe_payment_intent_id:stripe?"pi_owner_reserve_01":null};
    const db={prepare(sql){return {bind(...args){return {
      async first(){
        if(sql.startsWith("SELECT * FROM commerce_refunds WHERE idempotency_key="))
          return refunds.get(args[0])||null;
        if(sql.startsWith("SELECT * FROM commerce_orders WHERE id="))
          return args[0]===order.id?order:null;
        if(sql.startsWith("SELECT COALESCE(SUM(amount_minor)"))
          return [...refunds.values()].filter(x=>x.order_id===args[0]&&
            ["pending","succeeded"].includes(x.status)).reduce((a,r)=>({
              amount:a.amount+r.amount_minor,stripe:a.stripe+r.stripe_amount_minor,
              gift:a.gift+r.gift_card_amount_minor,store:a.store+r.store_credit_amount_minor
            }),{amount:0,stripe:0,gift:0,store:0});
        throw Error("unexpected_owner_reservation_read:"+sql);
      },
      async run(){
        assert.ok(sql.startsWith("INSERT INTO commerce_refunds("));
        inserts++;
        if(failInsert&&!failed){failed=true;throw Error("canonical_D1_unavailable");}
        const [id,orderId,amount,stripeAmount,giftAmount,storeAmount,currency,reason,status,key]=args;
        assert.equal(status,"pending");
        if(concurrent&&!refunds.size){
          // A competing refund wins the transaction between SELECT and INSERT.
          refunds.set("competing",{id:"ref_competing_01",order_id:orderId,
            idempotency_key:"competing-owner-refund-key-0001",reason,status:"pending",
            amount_minor:1000,stripe_amount_minor:600,gift_card_amount_minor:100,
            store_credit_amount_minor:300});
        }
        const already=[...refunds.values()].reduce((sum,r)=>sum+r.amount_minor,0);
        if(refunds.has(key)||already+amount>order.total_minor)return {meta:{changes:0}};
        refunds.set(key,{id,order_id:orderId,idempotency_key:key,reason,status:"pending",
          amount_minor:amount,stripe_amount_minor:stripeAmount,
          gift_card_amount_minor:giftAmount,store_credit_amount_minor:storeAmount});
        assert.equal(currency,"USD");
        return {meta:{changes:1}};
      }
    };}};}};
    return {db,refunds,counts:()=>inserts};
  }
  const invoke=(f,input)=>execute(f.db,input,row=>f.db.prepare(
    "INSERT INTO commerce_refunds(id,order_id,amount_minor,stripe_amount_minor,gift_card_amount_minor,store_credit_amount_minor,currency,reason,status,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(row.refundId,row.orderId,row.amount,row.stripe,row.gift,row.store,
    row.currency,row.reason,"pending",row.idempotencyKey,row.at,row.at).run());
  const f=fixture();
  for(const invalid of [
    {...request,sql:"DROP TABLE commerce_refunds"},
    {...request,orderId:"bad/../id"},
    {...request,amountMinor:-1},
    {...request,amountMinor:0},
    {...request,idempotencyKey:"short"},
    {...request,reason:5},
  ])await assert.rejects(()=>invoke(f,invalid),/invalid_owner_refund_reservation_command/);
  assert.equal(f.counts(),0,"Bad commands never write");
  const first=await invoke(f,request);
  assert.equal(first.schema,"cove.owner-refund-reservation.v1");
  assert.equal(first.created,true);
  assert.equal(first.amountMinor,1000);
  assert.deepEqual([first.stripeAmountMinor,first.storeCreditAmountMinor,first.giftCardAmountMinor],[600,300,100]);
  assert.match(first.refundId,/^ref_[a-f0-9-]{36}$/);
  const replay=await invoke(f,request);
  assert.equal(replay.created,false);
  assert.equal(replay.refundId,first.refundId);
  assert.equal(f.counts(),1,"A lost ACK cannot double-reserve tender");
  await assert.rejects(()=>invoke(f,{...request,amountMinor:200}),
    /owner_refund_idempotency_collision/);
  await assert.rejects(()=>invoke(f,{...request,reason:"fraudulent"}),
    /owner_refund_idempotency_collision/);
  await assert.rejects(()=>invoke(f,{...request,idempotencyKey:"different-owner-refund-key-0002"}),
    /owner_refund_balance_exhausted/);
  const partial=fixture();
  await assert.rejects(()=>invoke(partial,{...request,amountMinor:500}),
    /owner_refund_partial_scope_unsupported/);
  assert.equal(partial.counts(),0);
  const internal=fixture({stripe:0,store:750,gift:250});
  assert.deepEqual((({stripeAmountMinor,storeCreditAmountMinor,giftCardAmountMinor})=>
    [stripeAmountMinor,storeCreditAmountMinor,giftCardAmountMinor])(
    await invoke(internal,request)),[0,750,250]);
  const canceled=fixture({orderStatus:"canceled"});
  await assert.rejects(()=>invoke(canceled,request),/owner_refund_order_not_refundable/);
  const unavailable=fixture({failInsert:true});
  await assert.rejects(()=>invoke(unavailable,request),/canonical_D1_unavailable/);
  assert.equal(unavailable.refunds.size,0);
  assert.equal((await invoke(unavailable,request)).created,true);
  const race=fixture({concurrent:true});
  await assert.rejects(()=>invoke(race,request),/owner_refund_concurrent_reservation_conflict/);
  assert.equal(race.refunds.size,1,"Competing idempotency key keeps its own original tender");
  const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
  const entry=commerce.indexOf("export async function refundOrder(");
  const ownerBranch=commerce.indexOf('if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1") {',entry);
  const rawInsert=commerce.indexOf("INSERT INTO commerce_refunds(",entry);
  assert.ok(entry>=0&&ownerBranch>entry&&rawInsert>ownerBranch,
    "An enrolled caller must route through the owner BEFORE legacy D1 reservation");
  assert.match(commerce.slice(ownerBranch,rawInsert),/reserveStageOwnerRefundIntent/);
  assert.match(commerce.slice(ownerBranch,rawInsert),/return completeRequestedRefund/);
  const worker=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
  assert.match(worker,/route==="\/commercial\/refund\/reserve"/);
  assert.match(worker,/INSERT INTO commerce_refunds\(id,order_id,amount_minor/);
  console.log("PASS: private owner refund intent reserves immutable tender once; replay, collision, racing keys, D1 failure and QA-only caller fence");
}finally{rmSync(folder,{recursive:true,force:true});}
