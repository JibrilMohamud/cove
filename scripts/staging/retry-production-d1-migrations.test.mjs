import assert from "node:assert/strict";
import { test } from "node:test";
import { isD1ResourceThrottle, retryD1Migrations } from "./retry-production-d1-migrations.mjs";
test("only explicit rolling-window D1 7429 qualifies", () => {
  assert.ok(isD1ResourceThrottle("D1 DB is overloaded. Too many resources consumed within a 10 second window [code: 7429]"));
  for (const msg of ["Permission denied (403)","SQL logic error","D1 quota exhausted","D1 migration 7421","Unauthorized"])
    assert.equal(isD1ResourceThrottle(msg),false);
});
test("only bounded recognized resource-window rejections are retried", async()=>{
  let attempts=0;const delays=[];
  const ok=await retryD1Migrations(async()=>{
    attempts++;return attempts<3?{exitCode:1,output:"D1 DB is overloaded [code: 7429]"}:{exitCode:0,output:"Applied"};
  },{sleep:async ms=>delays.push(ms)});
  assert.equal(ok.exitCode,0);assert.equal(attempts,3);assert.deepEqual(delays,[12_000,18_000]);
});
test("permissions and migration SQL failures fail immediately",async()=>{
  let attempts=0;
  await assert.rejects(()=>retryD1Migrations(async()=>{attempts++;return {exitCode:1,output:"403 missing permissions"};},{sleep:async()=>{}}),/non-transient/);
  assert.equal(attempts,1);
});
test("persistent 7429 is reported after four total attempts",async()=>{
  let attempts=0;
  await assert.rejects(()=>retryD1Migrations(async()=>{attempts++;return {exitCode:1,output:"code: 7429"};},{sleep:async()=>{}}),/persisted/);
  assert.equal(attempts,4);
});
