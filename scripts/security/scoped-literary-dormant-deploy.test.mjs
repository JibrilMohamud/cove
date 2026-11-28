/* eslint-disable prettier/prettier -- Credential partition safety in dormant production publishers. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
const workflows=[
  ".github/workflows/literary-prod-handoff-dormant-deploy.yml",
  ".github/workflows/literary-prod-publisher-dormant-deploy.yml",
];
test("dormant literary workflows require three distinct narrow scopes, not broad token",()=>{
  for(const path of workflows){
    const w=read(path);
    assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"),path);
    for(const name of ["COVE_CF_PROD_MAINTENANCE_TOKEN","COVE_CF_STAGE_D1_READ_TOKEN","COVE_CF_WORKERS_METADATA_READ_TOKEN"])
      assert.ok(w.includes("secrets."+name),path+" missing "+name);
    assert.ok(w.includes('test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_STAGE_D1_READ_TOKEN"'));
    assert.ok(w.includes('test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"'));
    assert.ok(w.includes('test "$COVE_CF_STAGE_D1_READ_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"'));
    assert.ok(w.includes("inputs.reviewed_main_sha == github.sha"));
    assert.ok(w.includes("environment: cove-production-release-audit"));
  }
});
test("dormant literary auditors partition Worker metadata GET and D1 SELECT",()=>{
  for(const path of [
    "scripts/staging/deploy-literary-handoff-disabled.mjs",
    "scripts/staging/verify-literary-publisher-disabled.mjs",
  ]){
    const source=read(path);
    for(const key of ["process.env.COVE_CF_STAGE_D1_READ_TOKEN",
      "process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN",
      "process.env.CLOUDFLARE_API_TOKEN",
      "d1Query?d1ReadToken:workerRead?workerReadToken:null",
      "new Set([deployToken,d1ReadToken,workerReadToken]).size===3",
      "assert.match(sql.trim(), /^SELECT\\b/i"])
      assert.ok(source.includes(key),path+" credential separation missing "+key);
    assert.ok(!source.includes("const token = process.env.CLOUDFLARE_API_TOKEN"));
  }
});
