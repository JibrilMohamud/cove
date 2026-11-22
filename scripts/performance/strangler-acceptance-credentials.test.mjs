/* eslint-disable prettier/prettier -- Negative scoped Cloudflare staging acceptance test fixtures. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {checkedStranglerAcceptanceCredentials,stranglerAcceptanceTokenFor,ACCOUNT,STAGING_D1,PRODUCTION_D1} from "./strangler-acceptance-credentials.mjs";
const workers="staging-worker-only-upload-credential";
const d1="staging-d1-read-only-credential";
const env={CLOUDFLARE_ACCOUNT_ID:ACCOUNT,GITHUB_RUN_ID:"45000012345",
  COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:workers,COVE_CF_STAGE_D1_READ_TOKEN:d1,
  CLOUDFLARE_API_TOKEN:workers};
test("reject broad, reused, missing and wrong-account Cloudflare acceptance credentials",()=>{
  assert.notEqual(STAGING_D1,PRODUCTION_D1);
  assert.throws(()=>checkedStranglerAcceptanceCredentials({...env,CLOUDFLARE_API_TOKEN:"unscoped-broad-token"}));
  assert.throws(()=>checkedStranglerAcceptanceCredentials({...env,COVE_CF_STAGE_D1_READ_TOKEN:workers}));
  assert.throws(()=>checkedStranglerAcceptanceCredentials({...env,CLOUDFLARE_ACCOUNT_ID:"other"}));
  assert.throws(()=>checkedStranglerAcceptanceCredentials({...env,COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:""}));
});
test("only per-run transient Worker GET and DELETE can use staging deploy principal",()=>{
  const c=checkedStranglerAcceptanceCredentials(env);
  const root="/accounts/"+ACCOUNT+"/workers/scripts/cove-strangler-perf-"+c.run;
  for(const trial of [1,2,3]){
    assert.equal(stranglerAcceptanceTokenFor("GET",root+"-"+trial+"/deployments",c),workers);
    assert.equal(stranglerAcceptanceTokenFor("DELETE",root+"-"+trial+"?force=true",c),workers);
  }
  for(const [method,path] of [
    ["DELETE",root+"-3"],["POST",root+"-3/deployments"],
    ["DELETE",root+"-4?force=true"],["GET",root+"-2/settings"],
    ["DELETE","/accounts/"+ACCOUNT+"/workers/scripts/cove-persistence-backend?force=true"],
    ["POST","/accounts/"+ACCOUNT+"/d1/database/"+PRODUCTION_D1+"/query"],
    ["POST","/accounts/"+ACCOUNT+"/d1/database/"+STAGING_D1+"/execute"],
    ["DELETE","/accounts/"+ACCOUNT+"/r2/buckets/some-bucket"]
  ])assert.throws(()=>stranglerAcceptanceTokenFor(method,path,c));
});
test("synthetic source fixture COUNT runs only with D1 Read",()=>{
  const c=checkedStranglerAcceptanceCredentials(env);
  assert.equal(stranglerAcceptanceTokenFor("POST","/accounts/"+ACCOUNT+"/d1/database/"+STAGING_D1+"/query",c),d1);
  const script=readFileSync("scripts/performance/strangler-integrated-acceptance.mjs","utf8");
  assert.match(script,/assert\.deepEqual\(body, \{ sql: fixtureSql \}/);
  assert.ok(script.includes("!configString.includes(prodDbId)"));
  assert.ok(script.includes('assert.ok(deploy || secret'));
});
test("protected workflow no longer references broad token and preserves human release gate",()=>{
  const workflow=readFileSync(".github/workflows/storefront-strangler-safe-integration.yml","utf8");
  assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
  for(const expected of [
    "secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN",
    "secrets.COVE_CF_STAGE_D1_READ_TOKEN",
    "environment: cove-production-release-audit",
    "inputs.confirm_protected_cloudflare_action == true",
    "inputs.reviewed_main_sha == github.sha",
    "github.event_name == 'workflow_dispatch'"
  ])assert.ok(workflow.includes(expected));
});
