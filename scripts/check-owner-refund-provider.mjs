/* eslint-disable prettier/prettier -- Real leased-owner DO route with mocked D1 and strong SQLite. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const dir=mkdtempSync(join(tmpdir(),"cove-owner-refund-provider-"));
try{
  const output=join(dir,"legal-worker.mjs");
  await build({
    entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:output,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"mock-cloudflare-do",setup(context){
      context.onResolve({filter:/^cloudflare:workers$/},()=>({
        path:"mock-cloudflare:workers",namespace:"owner-test"
      }));
      context.onLoad({filter:/.*/,namespace:"owner-test"},()=>({
        contents:"export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
        loader:"js"
      }));
    }}]
  });
  const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
  const secret="f".repeat(64),orderId="order_provider_123",refundId="ref_provider_123";
  const paymentIntentId="pi_provider_123",providerRefundId="re_provider_123";

  const originalFetch=globalThis.fetch;
  let stripeStatus="pending",stripeFailure=false,providerOverride={};
  globalThis.fetch=async (url,options)=>{
    assert.equal(url,"https://api.stripe.com/v1/refunds/"+providerRefundId);
    assert.equal(options.method,"GET");
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers.authorization,"Bearer sk_test_private_owner_fixture");
    if(stripeFailure)throw Error("stripe_temporarily_unavailable");
    return new Response(JSON.stringify({
      object:"refund",id:providerRefundId,livemode:false,
      payment_intent:paymentIntentId,amount:100,currency:"usd",
      metadata:{fore_order_id:orderId,fore_refund_id:refundId},
      status:stripeStatus,...providerOverride
    }),{status:200});
  };

  const state={status:"pending",succeeded_at:null,provider_refund_id:null,denied:true,
    writes:0,failWrite:false};
  const refund=()=>({id:refundId,order_id:orderId,
    provider_refund_id:state.provider_refund_id,
    stripe_amount_minor:100,currency:"USD",status:state.status,
    succeeded_at:state.succeeded_at});
  const order=()=>({id:orderId,stripe_payment_intent_id:paymentIntentId,currency:"USD"});
  const db={prepare(sql){
    return {bind(...args){return {
      async first(){
        if(sql.startsWith("SELECT id,order_id,provider_refund_id,stripe_amount_minor"))
          return refund();
        if(sql.startsWith("SELECT id,stripe_payment_intent_id,currency"))
          return order();
        if(sql.startsWith("SELECT id,order_id,provider_refund_id,status"))
          return refund();
        throw Error("Unexpected database read: "+sql);
      },
      async run(){
        assert.ok(sql.startsWith("UPDATE commerce_refunds SET provider_refund_id="));
        if(state.failWrite)throw Error("canonical_D1_temporarily_unavailable");
        assert.equal(args[0],providerRefundId);
        assert.equal(args[3],refundId);
        assert.equal(args[4],orderId);
        assert.equal(args[5],providerRefundId);
        state.writes++;
        if(state.provider_refund_id&&state.provider_refund_id!==args[0])
          return {meta:{changes:0}};
        state.provider_refund_id=args[0];
        if(state.status!=="succeeded"&&!state.succeeded_at)state.status=args[1];
        return {meta:{changes:1}};
      }
    };}};
  }};
  const sql={exec(statement,...args){
    if(/^SELECT\s/i.test(statement)&&statement.includes("cove_paid_refunded_orders")){
      assert.deepEqual(args,[orderId]);
      return {toArray:()=>state.denied?[{ok:1}]:[]};
    }
    return {toArray:()=>[]};
  }};
  const env={
    PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+2*60*1000),
    COVE_RIGHTS_OWNER_SECRET:secret,
    STRIPE_SECRET_KEY:"sk_test_private_owner_fixture",STRIPE_LIVEMODE:"false"
  };
  const create=custom=>new CoveLegalAuthority({storage:{sql}},custom);
  const owner=create(env);
  const input={orderId,refundId,providerRefundId,paymentIntentId,
    amountMinor:100,currency:"USD",status:"pending"};
  async function call(payload=input,target=owner,token=secret){
    return target.fetch(new Request("https://legal-authority.internal/commercial/refund/record-provider",{
      method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify(payload)
    }));
  }
  const good=await call();
  assert.equal(good.status,200);
  assert.deepEqual(await good.json(),{
    schema:"cove.owner-refund-provider.v1",orderId,refundId,
    providerRefundId,status:"pending",ownerDenied:true,providerRecorded:true
  });
  assert.equal(state.writes,1);
  assert.equal((await call()).status,200);
  assert.equal(state.writes,1,"Exact replay must not write a new D1 provider state");
  stripeStatus="succeeded";
  assert.equal((await call({...input,status:"succeeded"})).status,200);
  assert.equal(state.status,"succeeded");
  assert.equal(state.writes,2);
  assert.equal((await call({...input,status:"pending"})).status,200);
  assert.equal(state.status,"succeeded","Out-of-order pending webhook must not regress succeeded");
  assert.equal(state.writes,2);
  for(const bad of [
    {...input,orderId:"order_not_yours"}, {...input,refundId:"ref_wrong_123"},
    {...input,providerRefundId:"re_collision_other"},
    {...input,paymentIntentId:"pi_wrong_123"},
    {...input,amountMinor:101}, {...input,currency:"CAD"},
    {...input,status:"approved"}, {...input,sql:"DROP TABLE commerce_refunds"}
  ]){
    const previous=state.writes;
    assert.notEqual((await call(bad)).status,200);
    assert.equal(state.writes,previous,"Forged provider scope cannot update canonical refund");
  }
  // A private adapter cannot forge success when Stripe still says pending.
  stripeStatus="pending";
  const beforeUnproven=state.writes;
  assert.notEqual((await call({...input,status:"succeeded"})).status,200);
  assert.equal(state.writes,beforeUnproven);
  stripeStatus="succeeded";
  for(const altered of [
    {id:"re_unrelated_refund"},{amount:101},{currency:"cad"},
    {livemode:true},{payment_intent:"pi_other_payment"},
    {metadata:{fore_order_id:"order_wrong",fore_refund_id:refundId}},
    {metadata:{fore_order_id:orderId,fore_refund_id:"ref_wrong"}}
  ]){
    providerOverride=altered;
    assert.notEqual((await call()).status,200,"Private owner must verify independent Stripe scope");
    assert.equal(state.writes,beforeUnproven,"Forged provider may not mutate D1");
  }
  providerOverride={};
  stripeFailure=true;
  assert.notEqual((await call()).status,200,"Provider outage must deny write");
  stripeFailure=false;
  assert.notEqual((await call(input,create({...env,STRIPE_SECRET_KEY:""}))).status,200,
    "Absent private owner Stripe credential must fail closed");
  state.denied=false;
  assert.notEqual((await call(input)).status,200,
    "Provider state may not mutate before the durable whole-order denial");
  state.denied=true;
  assert.equal((await call(input,owner,"b".repeat(64))).status,401);
  assert.equal((await call(input,create({...env,COVE_RIGHTS_OWNER_ENABLED:"0"}))).status,503);
  assert.equal((await call(input,create({...env,COVE_RIGHTS_OWNER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"}))).status,503);
  state.status="pending";
  state.failWrite=true;
  assert.notEqual((await call({...input,status:"failed"})).status,200);
  assert.equal(state.status,"pending","D1 outage must not forge a provider status change");
  state.failWrite=false;
  assert.equal((await call({...input,status:"succeeded"})).status,200);
  assert.equal(state.status,"succeeded");
  const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
  assert.match(commerce,/recordOwnerStripeRefundReceipt\(env, String\(o.id\), id, refund\)/);
  assert.match(commerce,/recordOwnerStripeRefundReceipt\(env, String\(r.order_id\), String\(r.id\), obj\)/);
  assert.doesNotMatch(commerce,/UPDATE commerce_refunds SET provider_refund_id=/,
    "The caller may not write provider refund status directly into shared D1");
  assert.match(commerce,/Refund completion requires the private commerce owner/,
    "Refund provider calls require the enrolled private owner");
  globalThis.fetch=originalFetch;
  console.log("PASS: owner independently verifies Stripe refund metadata, status, amount, currency, mode, replay and outages");
}finally{rmSync(dir,{recursive:true,force:true});}
