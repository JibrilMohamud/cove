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
