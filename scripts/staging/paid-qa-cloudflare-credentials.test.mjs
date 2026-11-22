/* eslint-disable prettier/prettier -- Exact QA account and credential isolation tests. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {checkedPaidQaCredentials,paidQaApiTokenFor,paidQaWranglerTokenFor,QA_ACCOUNT,QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_ACCOUNT,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const env={CLOUDFLARE_ACCOUNT_ID:QA_ACCOUNT,
  GITHUB_RUN_ID:"45000012345",GITHUB_RUN_ATTEMPT:"2",
  COVE_CF_QA_WORKERS_DEPLOY_TOKEN:"qa-worker-scoped-credential-xxx",
  COVE_CF_QA_D1_MUTATION_TOKEN:"qa-d1-write-credential-xxx",
  COVE_CF_QA_R2_STORAGE_TOKEN:"qa-r2-write-credential-xxx"};
test("isolated QA credentials reject production, broad token and missing/duplicate principal",()=>{
  assert.notEqual(QA_ACCOUNT,PRODUCTION_ACCOUNT);
  assert.notEqual(QA_PAID_D1,PRODUCTION_D1);
  assert.notEqual(QA_SCHEMA_SOURCE_D1,PRODUCTION_D1);
  assert.throws(()=>checkedPaidQaCredentials({...env,CLOUDFLARE_ACCOUNT_ID:PRODUCTION_ACCOUNT}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_QA_D1_MUTATION_TOKEN:""}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_QA_R2_STORAGE_TOKEN:env.COVE_CF_QA_WORKERS_DEPLOY_TOKEN}));
  assert.throws(()=>checkedPaidQaCredentials({...env,CLOUDFLARE_API_TOKEN:"legacy-broad-credential-must-be-absent"}));
});
test("all direct D1 paths are denied through Worker control-plane selector",()=>{
  const c=checkedPaidQaCredentials(env);
  for(const id of [QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_D1])
    assert.throws(()=>paidQaApiTokenFor("POST","/d1/database/"+id+"/query",c));
});
test("only exact ephemeral paid QA Workers may be mutated",()=>{
  const c=checkedPaidQaCredentials(env);
  const name="cove-paid-legal-owner-"+c.run;
  assert.equal(paidQaApiTokenFor("GET","/workers/scripts/"+name+"/settings",c),c.tokens.workers);
  assert.equal(paidQaApiTokenFor("POST","/workers/scripts/"+name+"/deployments",c),c.tokens.workers);
  assert.equal(paidQaApiTokenFor("DELETE","/workers/scripts/"+name,c),c.tokens.workers);
  for(const bad of ["cove-legal-authority-production","cove-persistence-backend","cove-paid-legal-owner-999999999-1"])
    assert.throws(()=>paidQaApiTokenFor("DELETE","/workers/scripts/"+bad,c));
  assert.throws(()=>paidQaApiTokenFor("POST","/workers/scripts/"+name+"/settings",c));
});
test("Wrangler may deploy only exactly named temporary QA Worker config",()=>{
  const c=checkedPaidQaCredentials(env);
  assert.equal(paidQaWranglerTokenFor(["deploy","--config","/tmp/.cove-paid-owner-proof-"+c.run+".jsonc","--secrets-file","/tmp/qa.json"],c),c.tokens.workers);
  assert.equal(paidQaWranglerTokenFor(["deploy","--config","/tmp/.cove-paid-d1-gateway-"+c.run+".jsonc","--secrets-file","/tmp/qa.json"],c),c.tokens.workers);
  assert.throws(()=>paidQaWranglerTokenFor(["deploy","--config","wrangler.production.jsonc","--secrets-file","/tmp/qa"],c));
  assert.throws(()=>paidQaWranglerTokenFor(["r2","object","delete","bucket/object"],c));
  assert.throws(()=>paidQaWranglerTokenFor(["d1","migrations","apply"],c));
});
