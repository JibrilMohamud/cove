/* eslint-disable prettier/prettier -- Strict isolated-legal-owner account and credential QA negatives. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {checkedPrivateLegalQaCredentials,legalQaTokenFor} from "./legal-qa-cloudflare-credentials.mjs";
import {QA_ACCOUNT,QA_LEGAL_D1,PRODUCTION_ACCOUNT,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
const workers="qa-worker-scoped-credential-xxx";
const env={CLOUDFLARE_ACCOUNT_ID:QA_ACCOUNT,GITHUB_RUN_ID:"45000012345",
  COVE_CF_QA_WORKERS_DEPLOY_TOKEN:workers,CLOUDFLARE_API_TOKEN:workers};
test("private legal QA accepts only a QA-account Worker token, no D1 or production bearer",()=>{
  const c=checkedPrivateLegalQaCredentials(env);
  assert.equal(c.workers,workers);
  assert.notEqual(QA_ACCOUNT,PRODUCTION_ACCOUNT);
  assert.notEqual(QA_LEGAL_D1,PRODUCTION_D1);
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,CLOUDFLARE_ACCOUNT_ID:PRODUCTION_ACCOUNT}));
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,CLOUDFLARE_API_TOKEN:"legacy-broad-production-token"}));
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,COVE_CF_QA_D1_MUTATION_TOKEN:"qa-full-sql-token"}));
  assert.throws(()=>checkedPrivateLegalQaCredentials({...env,COVE_CF_QA_WORKERS_DEPLOY_TOKEN:""}));
});
test("private legal QA D1 mutation path is exclusively the signed Worker binding",()=>{
  const c=checkedPrivateLegalQaCredentials(env),root="/accounts/"+QA_ACCOUNT;
  for(const id of [QA_LEGAL_D1,PRODUCTION_D1])
    assert.throws(()=>legalQaTokenFor("POST",root+"/d1/database/"+id+"/query",c));
  assert.throws(()=>legalQaTokenFor("GET","/accounts/"+PRODUCTION_ACCOUNT+"/workers/scripts",c));
});
test("legal QA Worker API cannot alter production owner or backend",()=>{
  const c=checkedPrivateLegalQaCredentials(env),root="/accounts/"+QA_ACCOUNT+"/workers/scripts";
  assert.equal(legalQaTokenFor("GET",root+"/cove-private-legal-proof-"+c.run+"/settings",c),c.workers);
  assert.equal(legalQaTokenFor("DELETE",root+"/cove-private-legal-proof-"+c.run,c),c.workers);
  assert.throws(()=>legalQaTokenFor("DELETE",root+"/cove-legal-authority-production",c));
  assert.throws(()=>legalQaTokenFor("DELETE",root+"/cove-persistence-backend",c));
  assert.throws(()=>legalQaTokenFor("POST",root+"/cove-private-legal-proof-"+c.run+"/settings",c));
});
test("QA legal D1 templates stay disabled, account-isolated, unrouteable",()=>{
  for(const path of ["wrangler.legal-authority.example.jsonc","wrangler.legal-quarantine-qa.example.jsonc"]){
    const cfg=JSON.parse(readFileSync(path,"utf8"));
    assert.deepEqual(cfg.routes,[]);
    assert.equal(cfg.workers_dev,false);
    assert.equal(cfg.preview_urls,false);
    assert.deepEqual(cfg.d1_databases?.map(x=>x.database_id),[QA_LEGAL_D1]);
    assert.ok(!JSON.stringify(cfg).includes(PRODUCTION_D1));
    assert.equal(cfg.vars.COVE_RIGHTS_OWNER_ENABLED??cfg.vars.COVE_LEGAL_WRITER_ENABLED,"0");
  }
});
test("protected legal QA workflow never grants a production-account credential",()=>{
  const w=readFileSync(".github/workflows/legal-authority-private-qa.yml","utf8");
  for(const x of ["secrets.COVE_CF_QA_WORKERS_DEPLOY_TOKEN",QA_ACCOUNT,
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_protected_cloudflare_action == true",
    "environment: cove-production-release-audit"])
    assert.ok(w.includes(x),"Missing legal QA barrier "+x);
  assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!w.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"));
  assert.ok(!w.includes(PRODUCTION_ACCOUNT));
});
