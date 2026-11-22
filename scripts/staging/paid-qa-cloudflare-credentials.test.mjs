/* eslint-disable prettier/prettier -- Security-critical negative path contracts. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {checkedPaidQaCredentials,paidQaApiTokenFor,paidQaWranglerTokenFor,QA_PAID_D1,QA_SCHEMA_SOURCE_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const env={CLOUDFLARE_ACCOUNT_ID:"d26430caa63ec55f6612e32f36aca5e9",
  GITHUB_RUN_ID:"45000012345",GITHUB_RUN_ATTEMPT:"2",
  CLOUDFLARE_API_TOKEN:"worker-scoped-credential-xxx",
  COVE_CF_PAID_QA_D1_WRITE_TOKEN:"qa-only-d1-sql-credential-xx",
  COVE_CF_PAID_QA_R2_WRITE_TOKEN:"qa-only-r2-object-credential",
  COVE_CF_WORKERS_METADATA_READ_TOKEN:"readonly-metadata-token-xxx"};
test("QA credentials fail closed on absence, equality, or wrong account",()=>{
  assert.throws(()=>checkedPaidQaCredentials({...env,CLOUDFLARE_ACCOUNT_ID:"other"}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_PAID_QA_D1_WRITE_TOKEN:""}));
  assert.throws(()=>checkedPaidQaCredentials({...env,COVE_CF_PAID_QA_D1_WRITE_TOKEN:env.CLOUDFLARE_API_TOKEN}));
});
test("only fixed QA D1 IDs receive SQL token, never production or other D1",()=>{
  const c=checkedPaidQaCredentials(env);
  for(const id of [QA_PAID_D1,QA_SCHEMA_SOURCE_D1])
    assert.equal(paidQaApiTokenFor("POST","/d1/database/"+id+"/query",c),c.tokens.d1);
  for(const id of [PRODUCTION_D1,"00000000-0000-0000-0000-000000000000"])
    assert.throws(()=>paidQaApiTokenFor("POST","/d1/database/"+id+"/query",c));
  assert.throws(()=>paidQaApiTokenFor("DELETE","/d1/database/"+QA_PAID_D1+"/query",c));
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
test("Wrangler R2 commands use a different principal from Worker deploy",()=>{
  const c=checkedPaidQaCredentials(env);
  assert.equal(paidQaWranglerTokenFor(["deploy","--config","safe.jsonc"],c),c.tokens.workers);
  assert.equal(paidQaWranglerTokenFor(["r2","object","delete","bucket/object"],c),c.tokens.r2);
  assert.equal(paidQaWranglerTokenFor(["r2","bucket","create","bucket"],c),c.tokens.r2);
  assert.throws(()=>paidQaWranglerTokenFor(["d1","migrations","apply"],c));
});
