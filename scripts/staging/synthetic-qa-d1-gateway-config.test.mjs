/* eslint-disable prettier/prettier -- Assert immutable D1 gateway synthetic resources. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {syntheticD1GatewayConfig} from "./synthetic-qa-d1-gateway-config.mjs";
for(const mode of ["paid","legal"])test(mode+" gateway only binds named synthetic D1",()=>{
  const x=syntheticD1GatewayConfig(mode,"45000012345-1",Date.now()+10*60_000);
  assert.equal(x.name,(mode==="paid"?"cove-paid-d1-gateway-":"cove-legal-d1-gateway-")+"45000012345-1");
  assert.equal(x.workers_dev,true);
  assert.equal(x.preview_urls,false);
  assert.deepEqual(x.routes,[]);
  assert.ok(x.d1_databases.every(b=>b.database_id!=="4bd657ac-8789-403e-a28c-93aba8d0a989"));
  assert.ok(x.d1_databases.every(b=>b.database_id!==""));
  assert.equal(x.vars.COVE_QA_D1_GATE_ALLOWED,mode);
  assert.equal(x.services,undefined);
  assert.equal(x.r2_buckets,undefined);
  assert.equal(x.triggers,undefined);
});
test("reject unreviewed mode and stale or distant expiry",()=>{
  assert.throws(()=>syntheticD1GatewayConfig("production","45000012345",Date.now()+60_000));
  assert.throws(()=>syntheticD1GatewayConfig("paid","bad",Date.now()+60_000));
  assert.throws(()=>syntheticD1GatewayConfig("paid","45000012345",Date.now()-1));
  assert.throws(()=>syntheticD1GatewayConfig("paid","45000012345",Date.now()+60*60_000));
});
