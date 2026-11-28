/* eslint-disable prettier/prettier -- Verify source scan and exact detached data-plane map. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {findStandingStageReferences,inventory,requireCleared} from "./audit-standing-stage-credential.mjs";
test("no legacy secret alias or computed reference may evade inventory",()=>{
  for(const ref of ["secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","secrets [ 'COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN' ]",'secrets["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"]']){
    assert.equal(findStandingStageReferences(ref)[0].kind,"legacy");
  }
  assert.equal(findStandingStageReferences("secrets[env.DYNAMIC_TOKEN]")[0].kind,"computed");
  assert.deepEqual(findStandingStageReferences("secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN"),[]);
  const report=inventory();
  assert.ok(report.workflowsInspected>=150);
  assert.equal(report.physicalRevocationCertified,false);
  if(report.legacyReferences||report.unresolvedComputedReferences)assert.throws(()=>requireCleared(report));
});
test("detached resources have new exact identifiers, no production primary",()=>{
  const m=JSON.parse(readFileSync("infra/detached-staging-resources.json","utf8"));
  assert.equal(m.targetAccount,"f51e8ccbc394e2d6016ff8c2c303d54b");
  assert.notEqual(m.targetAccount,m.sourceAccount);
  assert.equal(m.databases.length,7);assert.equal(m.buckets.length,3);assert.equal(m.kv.length,1);
  const ids=m.databases.flatMap(x=>[x.oldId,x.newId]);
  assert.equal(new Set(ids).size,14);
  assert.ok(!ids.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
  assert.notEqual(m.kv[0].oldId,m.kv[0].newId);
});
