/* eslint-disable prettier/prettier -- Bounded protected legal audit transport fixture. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProtectedD1ReadThrottle,retryAfterDelayMs} from './protected-d1-read-throttle.mjs';

function clock() {
  let time = 1_000_000;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      assert.ok(Number.isSafeInteger(ms)&&ms>=0);
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}
function response(status, retryAfter) {
  const value = {status, cancelled:false};
  value.headers={get:(header)=>header==='retry-after'?retryAfter:null};
  value.body={cancel:async()=>{value.cancelled=true;}};
  return value;
}

test('pacing is shared across independent read requests, without needless retries',async()=>{
  const c=clock(), gate=createProtectedD1ReadThrottle({...c});
  const first=response(200),second=response(200);
  assert.equal(await gate.request(async()=>first),first);
  assert.equal(await gate.request(async()=>second),second);
  assert.deepEqual(c.sleeps,[500]);
  assert.deepEqual(gate.stats(),{httpAttempts:2,rateLimitedResponses:0,rateLimitWaitMs:0});
});

test('429 retries only the same read callback, respects Retry-After and destroys throttled body',async()=>{
  const c=clock(), events=[],gate=createProtectedD1ReadThrottle({...c,onThrottle:x=>events.push(x)});
  const limited=response(429,'45'),ok=response(200);
  let count=0;
  assert.equal(await gate.request(async()=>++count===1?limited:ok),ok);
  assert.equal(count,2);
  assert.equal(limited.cancelled,true);
  assert.deepEqual(c.sleeps,[45_000]);
  assert.deepEqual(events,[{retry:1,delayMs:45_000}]);
  assert.deepEqual(gate.stats(),{httpAttempts:2,rateLimitedResponses:1,rateLimitWaitMs:45_000});
});

test('invalid or zero Retry-After gets conservative bounded backoff',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c});
  const values=[response(429,'invalid'),response(429,'0'),response(200)];
  let i=0;
  assert.equal((await gate.request(async()=>values[i++])).status,200);
  assert.deepEqual(c.sleeps,[20_000,40_000]);
  assert.equal(gate.stats().httpAttempts,3);
});

test('HTTP-date Retry-After is respected without guessing about the server window',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c});
  const date=new Date(c.now()+70_000).toUTCString();
  let i=0;
  assert.equal((await gate.request(async()=>++i===1?response(429,date):response(200))).status,200);
  assert.deepEqual(c.sleeps,[70_000]);
  assert.equal(retryAfterDelayMs(date,c.now()),0);
});

test('retry budget rejects a server Retry-After longer than permitted, never retries early',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c});
  let requests=0;
  const limited=response(429,'600');
  await assert.rejects(()=>gate.request(async()=>{requests++;return limited;}),/rights_spot_audit_rate_limited/);
  assert.equal(requests,1);
  assert.equal(limited.cancelled,true);
  assert.deepEqual(c.sleeps,[]);
  assert.equal(gate.stats().rateLimitedResponses,1);
});

test('only 429 is retried; authorization, transient 5xx and transport error are not retried',async()=>{
  for(const status of [400,401,403,500,503]){
    const c=clock(),gate=createProtectedD1ReadThrottle({...c});
    let calls=0;
    const result=await gate.request(async()=>{calls++;return response(status);});
    assert.equal(result.status,status);
    assert.equal(calls,1);
    assert.deepEqual(c.sleeps,[]);
  }
  const c=clock(),gate=createProtectedD1ReadThrottle({...c});
  let calls=0;
  await assert.rejects(()=>gate.request(async()=>{calls++;throw Error('transport');}),/transport/);
  assert.equal(calls,1);
});

test('per-query 429 retry cap stops repeated overload and never calls the service forever',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c});
  let count=0;
  await assert.rejects(()=>gate.request(async()=>{count++;return response(429);}),/rights_spot_audit_rate_limited/);
  assert.equal(count,4);
  assert.deepEqual(c.sleeps,[20_000,40_000,80_000]);
  assert.equal(gate.stats().rateLimitedResponses,4);
});

test('global 429 cap applies across queries, not only to the current one',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c,max429Responses:2});
  let count=0;
  assert.equal((await gate.request(async()=>++count===1?response(429):response(200))).status,200);
  assert.equal((await gate.request(async()=>++count===3?response(429):response(200))).status,200);
  await assert.rejects(()=>gate.request(async()=>response(429)),/rights_spot_audit_rate_limited/);
  assert.equal(gate.stats().rateLimitedResponses,3);
  assert.equal(gate.stats().httpAttempts,5);
});

test('global attempt and backoff limits are hard stops',async()=>{
  const c=clock(),gate=createProtectedD1ReadThrottle({...c,maxAttempts:1});
  assert.equal((await gate.request(async()=>response(200))).status,200);
  await assert.rejects(()=>gate.request(async()=>response(200)),/rights_spot_audit_query_budget_exhausted/);
  const d=clock(),timeBound=createProtectedD1ReadThrottle({...d,maxRetryWaitMs:25_000});
  let tries=0;
  await assert.rejects(()=>timeBound.request(async()=>{tries++;return response(429);}),
    /rights_spot_audit_rate_limited/);
  assert.equal(tries,2);
  assert.deepEqual(d.sleeps,[20_000]);
});

test('guard rejects missing callback rather than treating it as a SQL read',async()=>{
  const gate=createProtectedD1ReadThrottle();
  await assert.rejects(()=>gate.request(null),/rights_spot_audit_query_blocked/);
});
