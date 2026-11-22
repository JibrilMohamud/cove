/* eslint-disable prettier/prettier -- Strict synthetic control-plane path negatives. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {checkedPrivateLegalQaCredentials,legalQaTokenFor} from "./legal-qa-cloudflare-credentials.mjs";
const env={CLOUDFLARE_ACCOUNT_ID:"d26430caa63ec55f6612e32f36aca5e9",
  GITHUB_RUN_ID:"45000012345",CLOUDFLARE_API_TOKEN:"scoped-workers-credential-xxx",
  COVE_CF_WORKERS_METADATA_READ_TOKEN:"metadata-read-credential-xxx"};
test("private legal QA requires two independent credentials",()=>{
  const c=checkedPrivateLegalQaCredentials(env);
  assert.equal(c.run,env.GITHUB_RUN_ID);
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,COVE_CF_WORKERS_METADATA_READ_TOKEN:env.CLOUDFLARE_API_TOKEN}));
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,CLOUDFLARE_ACCOUNT_ID:"other"}));
});
test("private legal QA D1 mutation path is exclusively the isolated fixture",()=>{
  const c=checkedPrivateLegalQaCredentials(env),root="/accounts/"+env.CLOUDFLARE_ACCOUNT_ID;
  assert.throws(()=>legalQaTokenFor("POST",root+"/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query",c));
  assert.throws(()=>legalQaTokenFor("POST",root+"/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query",c));
  assert.throws(()=>legalQaTokenFor("DELETE",root+"/d1/database/5e3a6b69-6f3d-4b19-b837-01f7aa56ce87/query",c));
});
test("private legal QA cannot alter production owner or backend Worker",()=>{
  const c=checkedPrivateLegalQaCredentials(env),root="/accounts/"+env.CLOUDFLARE_ACCOUNT_ID+"/workers/scripts";
  assert.equal(legalQaTokenFor("GET",root+"/cove-private-legal-proof-"+c.run+"/settings",c),c.metadata);
  assert.equal(legalQaTokenFor("DELETE",root+"/cove-private-legal-proof-"+c.run,c),c.workers);
  assert.throws(()=>legalQaTokenFor("DELETE",root+"/cove-legal-authority-production",c));
  assert.throws(()=>legalQaTokenFor("DELETE",root+"/cove-persistence-backend",c));
  assert.throws(()=>legalQaTokenFor("POST",root+"/cove-private-legal-proof-"+c.run+"/settings",c));
});
