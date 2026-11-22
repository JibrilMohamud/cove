/* eslint-disable prettier/prettier -- Static credential separation contract, no secret access. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=x=>readFileSync(x,"utf8");
const paid=read(".github/workflows/paid-legal-full-schema-private-qa.yml");
const qa=read("scripts/staging/prove-private-paid-owner.mjs");
const prod=read(".github/workflows/deploy-persistence-backend.yml");
const fleet=read(".github/workflows/deployed-canonical-d1-principal-audit.yml");
const topology=read(".github/workflows/production-cutover-topology-audit.yml");
test("paid QA uses three distinct, capability-separated credentials",()=>{
  assert.doesNotMatch(paid,/secrets\.CLOUDFLARE_API_TOKEN/);
  for(const name of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_QA_D1_MUTATION_TOKEN","COVE_CF_QA_R2_STORAGE_TOKEN"])
    assert.ok(paid.includes("secrets."+name),name+" not wired");
  assert.match(qa,/assert\.notEqual\(workerToken,qaD1Token/);
  assert.match(qa,/assert\.notEqual\(qaD1Token,r2Token/);
  assert.match(qa,/process\.env\.CLOUDFLARE_API_TOKEN,undefined/);
  assert.match(qa,/assert\.notEqual\(account,forbiddenProductionAccount/);
  assert.match(qa,/assert\.notEqual\(primary,"4bd657ac-8789-403e-a28c-93aba8d0a989"/);
  assert.match(qa,/bindIsolatedQaPrimary\(original\)/);
  assert.match(qa,/bindIsolatedQaPrimary\(writer\)/);
  assert.match(qa,/bindIsolatedQaPrimary\(settlement\)/);
  assert.match(paid,/vars\.COVE_CF_QA_ACCOUNT_ID/);
  assert.match(qa,/resource\.startsWith\("\/d1\/database\/"\)\?qaD1Token:workerToken/);
  assert.match(qa,/CLOUDFLARE_API_TOKEN:args\[0\]==="r2"\?r2Token:workerToken/);
});
test("fleet and topology audits use only the protected reader",()=>{
  assert.doesNotMatch(fleet,/secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(topology,/secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(fleet,/secrets\.COVE_CF_FLEET_READ_TOKEN/);
  assert.match(topology,/secrets\.COVE_CF_FLEET_READ_TOKEN/);
});
test("production deploy, ephemeral handshake and explicit D1 migration have separate credentials",()=>{
  assert.doesNotMatch(prod,/secrets\.CLOUDFLARE_API_TOKEN/);
  for(const name of ["COVE_CF_PROD_D1_MIGRATIONS_TOKEN","COVE_CF_PROD_WORKERS_DEPLOY_TOKEN","COVE_CF_WORKERS_METADATA_READ_TOKEN","COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"])
    assert.ok(prod.includes("secrets."+name),name+" not wired");
  assert.match(prod,/github\.event_name == 'workflow_dispatch'/);
  assert.match(prod,/inputs\.apply_migrations == true/);
});

test("protected rollback, disabled owner, private legal QA and no-D1 gateway do not use broad credential",()=>{
  const source=["cove-stage-protected-worker-rollback.yml",
    "deploy-locked-fast-storefront-gateway.yml","production-legal-owner-locked.yml",
    "legal-authority-private-qa.yml"].map(x=>read(".github/workflows/"+x));
  for(const workflow of source)
    assert.doesNotMatch(workflow,/secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(source[0],/secrets\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN/);
  assert.match(source[1],/secrets\.COVE_CF_PROD_WORKERS_DEPLOY_TOKEN/);
  assert.match(source[1],/secrets\.COVE_CF_WORKERS_METADATA_READ_TOKEN/);
  assert.match(source[2],/secrets\.COVE_CF_FLEET_READ_TOKEN/);
  assert.match(source[3],/secrets\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN/);
  for(const [name,input] of [["cove-stage-protected-worker-rollback.yml",source[0]],
    ["production-legal-owner-locked.yml",source[2]],
    ["deploy-locked-fast-storefront-gateway.yml",source[1]]]){
    assert.match(input,/environment: cove-production-release-audit/);
    assert.match(input,/github\.event_name == 'workflow_dispatch'/,
      name+" must require protected manual approval");
  }
});

test("staging SSR, protected GET preflight, R2 provision no longer need an account-admin token",()=>{
  const ssr=read(".github/workflows/cloudflare-native-ssr-staging.yml");
  const dp=read(".github/workflows/strangler-data-plane-preflight.yml");
  const r2=read(".github/workflows/strangler-stage-private-bucket-provision.yml");
  for(const source of [ssr,dp,r2])assert.doesNotMatch(source,/secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(ssr,/secrets\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN/);
  assert.match(dp,/secrets\.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN/);
  assert.match(r2,/secrets\.COVE_CF_STAGE_R2_PROVISION_TOKEN/);
  for(const source of [dp,r2]){
    assert.match(source,/environment: cove-production-release-audit/);
    assert.match(source,/github\.event_name == 'workflow_dispatch'/);
    assert.match(source,/github\.ref == 'refs\/heads\/main'/);
  }
});
