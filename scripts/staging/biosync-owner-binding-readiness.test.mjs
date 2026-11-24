/* eslint-disable prettier/prettier -- Protected QA fixture asserts strict no-write readiness rules. */
import assert from "node:assert/strict";
import test from "node:test";
import {stabilizeBiosyncOwnerBinding} from "./biosync-owner-binding-readiness.mjs";

const success=()=>({status:200,body:{schema:"cove.qa.biosync-owner-binding-readiness.v1"},
  noStore:true});
function harness(inject=()=>null){
  let calls=0,sleeps=0;
  return {
    async probe(){
      calls++;
      return inject({calls,wave:Math.ceil(calls/32)})||success();
    },
    async sleep(ms){
      assert.equal(ms,3000);
      sleeps++;
    },
    get calls(){return calls;},
    get sleeps(){return sleeps;}
  };
}
test("two consecutive all-32 owner-DO-bound 200 receipts are required before first commit",async()=>{
  const h=harness(({wave,calls})=>{
    if(wave===1&&calls%2===0)return {status:404};
    if(wave===1&&calls%2===1)return {status:503};
    return null;
  });
  const result=await stabilizeBiosyncOwnerBinding(h.probe,h.sleep);
  assert.deepEqual(result,{
    schema:"cove.qa.biosync-binding-stable.v1",
    completedWaves:3,edge404:16,unavailable503:16,consecutive:2
  });
  assert.equal(h.calls,3*32);
  assert.equal(h.sleeps,2);
});
test("a single 404 in every 32-way wave can never count as a passing campaign",async()=>{
  const h=harness(({calls})=>calls%32===1?{status:404}:null);
  await assert.rejects(stabilizeBiosyncOwnerBinding(h.probe,h.sleep),
    /biosync_owner_binding_readiness_unstable:12:0/);
  assert.equal(h.calls,12*32);
  assert.equal(h.sleeps,11);
});
test("permanent 503 owner unavailability also fails after hard finite limit",async()=>{
  const h=harness(()=>({status:503}));
  await assert.rejects(stabilizeBiosyncOwnerBinding(h.probe,h.sleep),
    /biosync_owner_binding_readiness_unstable:0:384/);
  assert.equal(h.calls,12*32);
});
test("only unmarked 502/504 edge failures can delay a pre-commit, no-write readiness wave",async()=>{
  const h=harness(({wave,calls})=>{
    if(wave===1)return calls%2?{status:502,noStore:false}:{status:504,noStore:false};
    return null;
  });
  const result=await stabilizeBiosyncOwnerBinding(h.probe,h.sleep);
  assert.deepEqual(result,{
    schema:"cove.qa.biosync-binding-stable.v1",completedWaves:3,
    edge404:0,unavailable503:0,consecutive:2,edge502:16,edge504:16
  });
  assert.equal(h.calls,3*32);
  assert.equal(h.sleeps,2);
});
test("persistent unmarked 502 never meets the two-clean-wave owner proof",async()=>{
  const h=harness(()=>({status:502,noStore:false}));
  await assert.rejects(stabilizeBiosyncOwnerBinding(h.probe,h.sleep),
    /biosync_owner_binding_readiness_unstable:0:0:edge502=384:edge504=0/);
  assert.equal(h.calls,12*32);
  assert.equal(h.sleeps,11);
});
test("gateway-marked wrong route and application 502 fail without retry",async()=>{
  for(const response of [{status:404,noStore:true},{status:502,noStore:true},
    {status:504,noStore:true}]){
    const h=harness(()=>response);
    await assert.rejects(stabilizeBiosyncOwnerBinding(h.probe,h.sleep),
      /biosync_owner_binding_readiness_receipt_denied/);
    assert.equal(h.sleeps,0);
  }
});
test("wrong owner receipt, missing no-store, forged status, bad token and network errors fail immediately",async()=>{
  for(const result of [
    {status:200,body:{schema:"wrong"},noStore:true},
    {status:200,body:{schema:"cove.qa.biosync-owner-binding-readiness.v1"}},
    {status:401},
    {status:400},
    {status:202},
  ]){
    const h=harness(()=>result);
    await assert.rejects(stabilizeBiosyncOwnerBinding(h.probe,h.sleep),
      /biosync_owner_binding_readiness_receipt_denied/);
    assert.equal(h.sleeps,0);
  }
  const fail=harness(()=>{throw Error("network_unavailable")});
  await assert.rejects(stabilizeBiosyncOwnerBinding(fail.probe,fail.sleep),
    /network_unavailable/);
  assert.equal(fail.sleeps,0);
  await assert.rejects(stabilizeBiosyncOwnerBinding(null,async()=>{}),
    /biosync_owner_binding_readiness_invalid/);
});
