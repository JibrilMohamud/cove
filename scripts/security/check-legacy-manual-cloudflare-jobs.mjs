/* eslint-disable prettier/prettier -- Exact negative-string mutations preserve audited admission guards. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const jobs=[
  ["literary-drain-worker-deploy","protected-deploy"],
  ["literary-guarded-owner-drain","protected-activate"],
  ["literary-isolated-replay-handoff-deploy","protected-redeploy"],
  ["literary-private-binding-stage-canary","protected-real-service-binding"],
  ["literary-progressive-canonical-publication","protected-publish"],
  ["literary-remote-staging-e2e","protected-real-d1-r2-canary"],
  ["hosted-music-supply-disabled-qa","verify-nonpublic-shadow"],
  ["strangler-hosted-capacity-evaluation","protected-staging-only"],
  ["deployed-commerce-browser-acceptance","authenticated-commerce"],
  ["strangler-data-plane-preflight","verify-existing-isolated-stage-resources"],
  ["publication-source-isolation-qa","physically-isolated-publication"],
  ["storefront-strangler-safe-integration","hosted-acceptance"],
];
const guards=[
  "github.repository == 'JibrilMohamud/cove'",
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/main'",
  "inputs.confirm_protected_cloudflare_action == true",
  "inputs.reviewed_main_sha == github.sha"
];
function check(source,name){
  const sourceOn=source.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1]||"";
  for(const name of ["reviewed_main_sha","confirm_protected_cloudflare_action"])
    assert.ok(sourceOn.includes("      "+name+":"));
  assert.match(sourceOn,/^        required: true\s*$/m);
  assert.match(sourceOn,/^        default: false\s*$/m);
  const jobHead=source.indexOf("  "+name+":\n");
  assert.ok(jobHead>=0,"Missing job "+name);
  const rest=source.slice(jobHead);
  const next=rest.search(/\n  [a-z][a-z0-9-]+:\n/);
  const job=next<0?rest:rest.slice(0,next);
  const admission=job.match(/^    if: >-\n([\s\S]*?)(?=^    environment:)/m)?.[1];
  assert.ok(admission,"Missing protected admission for "+name);
  for(const guard of guards)assert.ok(admission.includes(guard),"Missing "+guard);
  assert.ok(!admission.includes("github.event_name == 'push'"));
  assert.ok(!admission.includes("github.event_name == 'schedule'"));
  assert.match(job,/^    environment: cove-production-release-audit\s*$/m);
  assert.ok(job.indexOf("environment: cove-production-release-audit")<job.indexOf("CLOUDFLARE_API_TOKEN:"));
  assert.match(source,/^permissions:\n  contents: read\s*$/m);
  return true;
}
for(const [name,job] of jobs){
  const file=".github/workflows/"+name+".yml";
  const source=readFileSync(file,"utf8");
  assert.ok(check(source,job));
  for(const [from,to] of [
    ["github.event_name == 'workflow_dispatch'","github.event_name == 'push'"],
    ["inputs.confirm_protected_cloudflare_action == true","true"],
    ["inputs.reviewed_main_sha == github.sha","true"],
    ["    environment: cove-production-release-audit\n",""]
  ]){
    const changed=source.replace(from,to);
    assert.notEqual(changed,source);
    assert.throws(()=>check(changed,job),"Unprotected mutation accepted in "+name);
  }
}
const music=readFileSync(".github/workflows/hosted-music-supply-disabled-qa.yml","utf8");
assert.ok(!music.includes("secrets.CLOUDFLARE_API_TOKEN"));
for(const field of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_WORKERS_METADATA_READ_TOKEN","COVE_CF_STAGE_D1_READ_TOKEN"])
  assert.ok(music.includes("secrets."+field));
const inspector=readFileSync("scripts/staging/deploy-music-supply-qa-shadow.mjs","utf8");
assert.ok(inspector.includes("authorization: \"Bearer \" + metadataToken"));
assert.ok(inspector.includes("authorization: \"Bearer \" + qaReadToken"));
assert.ok(inspector.includes("new Set([deployToken,metadataToken,qaReadToken]).size,3"));
assert.ok(!inspector.includes('authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN'));
console.log("PASS: twelve legacy privileged jobs require exact-main protected manual authorization; disabled music QA splits deploy/metadata/D1-read principals");
