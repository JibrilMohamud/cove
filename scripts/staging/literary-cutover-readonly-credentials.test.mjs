/* eslint-disable prettier/prettier -- Adversarial exact-path split of protected Cloudflare read credentials. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {checkedLiteraryCutoverReadOnlyCredentials,literaryCutoverTokenFor} from "./literary-cutover-readonly-credentials.mjs";
const root="/accounts/d26430caa63ec55f6612e32f36aca5e9";
const env={
  CLOUDFLARE_ACCOUNT_ID:"d26430caa63ec55f6612e32f36aca5e9",
  COVE_CF_PRODUCTION_AUDIT_READ_TOKEN:"separate-primary-d1-read-only-principal",
  COVE_CF_WORKERS_METADATA_READ_TOKEN:"separate-workers-metadata-read-principal",
  COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN:"separate-backend-worker-editor-principal",
  COVE_CF_STAGE_DATA_PLANE_READ_TOKEN:"separate-read-only-r2-principal"
};
test("reject missing/reused readers, production broad secret and wrong account",()=>{
  assert.throws(()=>checkedLiteraryCutoverReadOnlyCredentials({...env,CLOUDFLARE_API_TOKEN:"legacy-broad"}));
  assert.throws(()=>checkedLiteraryCutoverReadOnlyCredentials({...env,CLOUDFLARE_ACCOUNT_ID:"other"}));
  assert.throws(()=>checkedLiteraryCutoverReadOnlyCredentials({...env,COVE_CF_WORKERS_METADATA_READ_TOKEN:""}));
  assert.throws(()=>checkedLiteraryCutoverReadOnlyCredentials({...env,COVE_CF_STAGE_DATA_PLANE_READ_TOKEN:env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN}));
});
test("each exact read-only API path uses its unique principal",()=>{
  const t=checkedLiteraryCutoverReadOnlyCredentials(env);
  for(const db of ["4bd657ac-8789-403e-a28c-93aba8d0a989","400c3af3-5d40-41fd-83cc-98228e40ddac"])
    assert.equal(literaryCutoverTokenFor("POST",root+"/d1/database/"+db+"/query",t),t.tokens.d1);
  for(const resource of ["cove-literary-handoff-isolated-disabled/settings",
    "cove-literary-handoff-isolated-disabled/schedules","cove-persistence-backend/schedules"])
    assert.equal(literaryCutoverTokenFor("GET",root+"/workers/scripts/"+resource,t),t.tokens.metadata);
  assert.equal(literaryCutoverTokenFor("GET",root+"/workers/scripts/cove-persistence-backend",t),t.tokens.backendContent);
  for(const mode of ["managed","custom"])
    assert.equal(literaryCutoverTokenFor("GET",root+"/r2/buckets/cove-literary-originals-isolated-20261024/domains/"+mode,t),t.tokens.r2);
});
test("deny any unsupported D1 mutation, account, Worker version or R2 operation",()=>{
  const t=checkedLiteraryCutoverReadOnlyCredentials(env);
  for(const [method,path] of [
    ["DELETE",root+"/workers/scripts/cove-persistence-backend"],
    ["POST",root+"/workers/scripts/cove-persistence-backend/deployments"],
    ["PUT",root+"/workers/scripts/cove-legal-authority-production"],
    ["GET",root+"/workers/scripts/cove-legal-authority-production"],
    ["POST",root+"/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/execute"],
    ["DELETE",root+"/r2/buckets/cove-literary-originals-isolated-20261024"],
    ["GET",root+"/workers/scripts/cove-persistence-backend?version=unreviewed"],
    ["GET","/accounts/other/workers/scripts/cove-persistence-backend"],
  ]) assert.throws(()=>literaryCutoverTokenFor(method,path,t),/denied|unapproved/);
});
test("protected workflow contains no legacy broad token and retains exact-main manual gate",()=>{
  const w=readFileSync(".github/workflows/literary-live-cutover-preflight.yml","utf8");
  assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
  for(const marker of [
    "secrets.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN",
    "secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN",
    "secrets.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN",
    "secrets.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
    "environment: cove-production-release-audit",
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_protected_cloudflare_action == true",
    "github.event_name == 'workflow_dispatch'"
  ])assert.ok(w.includes(marker),"Missing protected read-only credential boundary "+marker);
});
