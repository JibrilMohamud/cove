/* eslint-disable prettier/prettier -- explicit source and read-only observer fixtures */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {observeBudget,activationRelease} from "./staging/roll-literary-isolated-utc-budget.mjs";
const workflow=readFileSync(".github/workflows/literary-isolated-utc-budget.yml","utf8");
const observer=readFileSync("scripts/staging/roll-literary-isolated-utc-budget.mjs","utf8");
const owner=readFileSync("src/storefront-strangler/literary-owner-budget-rollover.ts","utf8");
assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
assert.ok(!workflow.includes('cron: "25 * * * *"'));
assert.ok(workflow.includes('cron: "55 * * * *"'));
assert.ok(workflow.includes("secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN"));
assert.ok(workflow.includes("environment: cove-production-release-audit"));
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("needs: static"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(!/\b(?:INSERT INTO|UPDATE literary|DELETE FROM|CREATE TABLE)\b/.test(observer));
for(const gate of ["literary_processing_owner","literary_budget_domain","previous_day_not_active","isolatedIdentity","destinationWritable","original_reserved_units","original_calls","recordOwnedBudgetTick"])
  assert.ok(owner.includes(gate),"native owner gate missing: "+gate);
const now=Date.parse("2026-11-25T02:55:00Z");
const env={GITHUB_REPOSITORY:"JibrilMohamud/cove",GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"schedule",COVE_BIOSYNC_PROD_D1_READ_TOKEN:"r".repeat(32)};
function fixture({current="active",previous="active",receipt={},identity={}}={}){
  const calls=[];
  const transport=async(url,options)=>{
    assert.equal(url,"https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/400c3af3-5d40-41fd-83cc-98228e40ddac/query");
    assert.equal(options.method,"POST");
    assert.equal(options.headers.authorization,"Bearer "+env.COVE_BIOSYNC_PROD_D1_READ_TOKEN);
    const {sql}=JSON.parse(options.body);assert.match(sql,/^SELECT\b/);calls.push(sql);
    const rows=sql.includes("domain_identity")?[{domain:"cove-isolated-literary-budget",schema_version:1,contaminated:0,...identity}]:
      sql.includes("budget_cutover")?[{day:"2026-11-24",status:previous},{day:"2026-11-25",status:current}]:
      [{release_sha:activationRelease,scheduled_ms:Date.parse("2026-11-25T02:25:00Z"),cron:"25 * * * *",day:"2026-11-25",state:"already_active",...receipt}];
    return Response.json({success:true,result:[{success:true,results:rows}]});
  };
  return {transport,now,calls};
}
const pass=fixture();
assert.equal((await observeBudget(env,pass)).providerMutation,false);
assert.equal(pass.calls.length,3);
for(const [opts,reason] of [
  [{current:"prepared"},/budget_current_day_not_active/],
  [{previous:"closed"},/budget_previous_day_not_active/],
  [{receipt:{cron:"*/2 * * * *"}},/budget_native_hourly_receipt_missing/],
  [{receipt:{scheduled_ms:now-3*3600000}},/budget_native_receipt_stale/],
  [{receipt:{release_sha:"b".repeat(40)}},/budget_native_release_drift/],
  [{identity:{contaminated:1}},/AssertionError|deep-equal|deepEqual/]
])await assert.rejects(observeBudget(env,fixture(opts)),reason);
const blocked=fixture();
await assert.rejects(observeBudget({...env,CLOUDFLARE_API_TOKEN:"legacy"},blocked),/legacy mutation credential forbidden/);
assert.equal(blocked.calls.length,0);
console.log("LITERARY_UTC_BUDGET_ROLLOVER_POLICY_PASS native owner is sole scheduled rollover; observer is read-only");
