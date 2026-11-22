/* eslint-disable prettier/prettier -- Security-critical negative path contracts. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {checkedPaidQaCredentials,paidQaApiTokenFor,paidQaWranglerTokenFor,QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const env={CLOUDFLARE_ACCOUNT_ID:"d26430caa63ec55f6612e32f36aca5e9",
  GITHUB_RUN_ID:"45000012345",GITHUB_RUN_ATTEMPT:"2",
  CLOUDFLARE_API_TOKEN:"worker-scoped-credential-xxx",
  COVE_CF_WORKERS_METADATA_READ_TOKEN:"readonly-metadata-token-xxx"};
test("QA credentials fail closed on absence, equality, or wrong account",()=>{
  assert.throws(()=>checkedPaidQaCredentials({...env,CLOUDFLARE_ACCOUNT_ID:"other"}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_WORKERS_METADATA_READ_TOKEN:""}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_WORKERS_METADATA_READ_TOKEN:env.CLOUDFLARE_API_TOKEN}));
});
test("all direct D1 control-plane paths are forbidden even for synthetic IDs",()=>{
  const c=checkedPaidQaCredentials(env);
  for(const id of [QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_D1])
    assert.throws(()=>paidQaApiTokenFor("POST","/d1/database/"+id+"/query",c));
});
test("only exact ephemeral paid QA Workers are mutable",()=>{
  const c=checkedPaidQaCredentials(env);
  const name="cove-paid-legal-owner-"+c.run;
  assert.equal(paidQaApiTokenFor("GET","/workers/scripts/"+name+"/settings",c),c.tokens.metadata);
  assert.equal(paidQaApiTokenFor("POST","/workers/scripts/"+name+"/deployments",c),c.tokens.workers);
  assert.equal(paidQaApiTokenFor("DELETE","/workers/scripts/"+name,c),c.tokens.workers);
  for(const bad of ["cove-legal-authority-production","cove-persistence-backend","cove-paid-legal-owner-999999999-1"])
    assert.throws(()=>paidQaApiTokenFor("DELETE","/workers/scripts/"+bad,c));
  assert.throws(()=>paidQaApiTokenFor("POST","/workers/scripts/"+name+"/settings",c));
});
test("Wrangler may deploy isolated QA Workers, never run direct R2 or D1",()=>{
  const c=checkedPaidQaCredentials(env);
  assert.equal(paidQaWranglerTokenFor(["deploy","--config","safe.jsonc"],c),c.tokens.workers);
  assert.throws(()=>paidQaWranglerTokenFor(["r2","object","delete","bucket/object"],c));
  assert.throws(()=>paidQaWranglerTokenFor(["d1","migrations","apply"],c));
});
