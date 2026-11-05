import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableSoundsRequest, throttleDelayMs, withSoundsCloudflare429Retry } from "./cf-api-429-retry.mjs";
const d1="accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query";
const kv="accounts/d26430caa63ec55f6612e32f36aca5e9/storage/kv/namespaces/544267f3cf604c1d8976f1b06d258e24/values/sounds%2Fv1";
test("only advisory SELECT transport and idempotent KV puts may retry", () => {
  assert.equal(isRetryableSoundsRequest(d1,"POST"),true);
  assert.equal(isRetryableSoundsRequest(kv,"PUT"),true);
  for(const [resource,method] of [[d1,"DELETE"],[kv,"POST"],["accounts/foo/workers/scripts/cove","PUT"],["anything","POST"]])
    assert.equal(isRetryableSoundsRequest(resource,method),false);
  assert.equal(throttleDelayMs("1",0),12000);
  assert.equal(throttleDelayMs("120",1),60000);
});
test("two 429 responses settle after bounded pauses without masking success", async () => {
  let calls=0;const sleeps=[];const seen=[];
  const res=await withSoundsCloudflare429Retry(
    async () => ({status:++calls<3?429:200,headers:{get:()=>null},body:{cancel:async()=>{}}}),
    {resource:d1,method:"POST",sleep:async(ms)=>sleeps.push(ms),onRetry:x=>seen.push(x)});
  assert.equal(res.status,200);assert.equal(calls,3);assert.deepEqual(sleeps,[12000,15000]);
  assert.deepEqual(seen.map(x=>x.retry),[1,2]);
});
test("three 429s fail visibly and auth errors never retry", async () => {
  let calls=0;let sleeps=0;
  const run=(status,resource=d1)=>withSoundsCloudflare429Retry(
    async()=>{calls++;return {status,headers:{get:()=>null}};},
    {resource,method:"POST",sleep:async()=>sleeps++});
  assert.equal((await run(429)).status,429);assert.equal(calls,3);assert.equal(sleeps,2);
  calls=0;sleeps=0;assert.equal((await run(403)).status,403);assert.equal(calls,1);assert.equal(sleeps,0);
  calls=0;assert.equal((await run(429,"accounts/a/unknown")).status,429);assert.equal(calls,1);
});
test("fetch exceptions propagate immediately without retries", async () => {
  let calls=0;
  await assert.rejects(()=>withSoundsCloudflare429Retry(async()=>{calls++;throw new Error("network");},
    {resource:d1,method:"POST",sleep:async()=>{}}),/network/);
  assert.equal(calls,1);
});
