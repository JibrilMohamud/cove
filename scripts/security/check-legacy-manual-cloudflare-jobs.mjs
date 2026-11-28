/* eslint-disable prettier/prettier -- Exact negative-string mutations preserve audited admission guards. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const jobs=[
  ["literary-drain-worker-deploy","protected-deploy"],
  ["literary-guarded-owner-drain","protected-post-drain-observation"],
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
  const qaOnly = ["protected-real-service-binding","protected-real-d1-r2-canary"].includes(name);
  const approval = job.indexOf("environment: cove-production-release-audit");
  if(qaOnly){
    assert.ok(!job.includes("secrets.CLOUDFLARE_API_TOKEN"));
    assert.ok(job.includes("CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b"));
    const credentials=["COVE_CF_QA_D1_MUTATION_TOKEN","COVE_CF_QA_R2_STORAGE_TOKEN"];
    if(name==="protected-real-service-binding")credentials.push("COVE_CF_QA_WORKERS_DEPLOY_TOKEN");
    for(const field of credentials)assert.ok(job.indexOf(field+": ${{ secrets."+field+" }}")>approval);
  }else if(name==="protected-publish"){
    assert.ok(!job.includes("secrets.CLOUDFLARE_API_TOKEN"));
    assert.ok(job.indexOf("secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN")>approval);
    assert.ok(job.includes("run: node scripts/staging/verify-literary-postpublication-readonly.mjs"));
    assert.ok(!/wrangler deploy|run: node scripts\/staging\/(?:promote|rollback|fence-prior)-/.test(job));
    assert.deepEqual([...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m=>m[1]),["COVE_BIOSYNC_PROD_D1_READ_TOKEN"]);
  }else if(name==="physically-isolated-publication"){
    assert.ok(!job.includes("secrets.CLOUDFLARE_API_TOKEN"));
    for(const token of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_STAGE_DATA_PLANE_READ_TOKEN","COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN"])
      assert.ok(job.indexOf("secrets."+token)>approval);
  }else if(name==="protected-staging-only"){
    assert.ok(!job.includes("secrets.CLOUDFLARE_API_TOKEN"));
    for(const token of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_STAGE_DATA_PLANE_READ_TOKEN","COVE_BIOSYNC_PROD_D1_READ_TOKEN"])
      assert.ok(job.indexOf("secrets."+token)>approval);
  }else if(name==="authenticated-commerce"){
    assert.ok(!job.includes("secrets.CLOUDFLARE_API_TOKEN"));
    assert.ok(job.includes("CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b"));
    for(const token of ["COVE_CF_QA_WORKERS_DEPLOY_TOKEN","COVE_CF_QA_D1_MUTATION_TOKEN","COVE_CF_QA_R2_STORAGE_TOKEN"])
      assert.ok(job.indexOf("secrets."+token)>approval);
  }else if(name==="protected-post-drain-observation"){
    assert.ok(!source.includes("secrets.CLOUDFLARE_API_TOKEN"),"Retired drain must not regain broad credentials");
    assert.ok(!/^  protected-activate:\s*$/m.test(source),"Retired drain mutation job reintroduced");
    assert.ok(job.indexOf("CLOUDFLARE_API_TOKEN: ${{ secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN }}")>approval);
    assert.ok(job.includes("CLOUDFLARE_ACCOUNT_ID: d26430caa63ec55f6612e32f36aca5e9"));
    assert.ok(job.includes("run: node scripts/staging/verify-literary-postpublication-readonly.mjs"));
    // Historical filenames may appear only in path filters or exact syntax-only
    // checks. Reject execution even in a multiline shell or chained command.
    const retiredScript=/(?:activate-literary-drain|rollback-literary-drain|verify-literary-drain-progress)\.mjs/;
    const syntaxOnly=/^      - run: node --check scripts\/staging\/(?:activate-literary-drain|rollback-literary-drain|verify-literary-drain-progress)\.mjs$/;
    const pathFilter=/^      - "scripts\/staging\/(?:activate-literary-drain|rollback-literary-drain|verify-literary-drain-progress)\.mjs"$/;
    for(const line of source.split(/\r?\n/)){
      if(retiredScript.test(line))assert.ok(syntaxOnly.test(line)||pathFilter.test(line),"Retired drain executable reference");
    }
    assert.ok(!retiredScript.test(job),"Protected observer must not invoke retired scripts");
    assert.ok(!/\bwrangler\b/.test(job));
    const secretRefs=[...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m=>m[1]);
    assert.deepEqual(secretRefs,["COVE_BIOSYNC_PROD_D1_READ_TOKEN"]);
  }else{
    assert.ok(job.indexOf("CLOUDFLARE_API_TOKEN:")>approval);
  }
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
const retiredDrain=readFileSync(".github/workflows/literary-guarded-owner-drain.yml","utf8");
const observation="protected-post-drain-observation";
for(const [from,to] of [
  ["secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN","secrets.CLOUDFLARE_API_TOKEN"],
  ["secrets.COVE_BIOSYNC_PROD_D1_READ_TOKEN","secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"],
  ["run: node scripts/staging/verify-literary-postpublication-readonly.mjs","run: node scripts/staging/activate-literary-drain.mjs"],
  ["run: node scripts/staging/verify-literary-postpublication-readonly.mjs","run: node scripts/staging/rollback-literary-drain.mjs"],
  ["run: node --check scripts/staging/activate-literary-drain.mjs","run: node scripts/staging/activate-literary-drain.mjs"],
  ["run: node --check scripts/staging/rollback-literary-drain.mjs","run: node --check scripts/staging/rollback-literary-drain.mjs && node scripts/staging/rollback-literary-drain.mjs"],
  ["run: node --check scripts/staging/verify-literary-drain-progress.mjs","run: |\n          node scripts/staging/verify-literary-drain-progress.mjs"]
]){
  const changed=retiredDrain.replace(from,to);
  assert.notEqual(changed,retiredDrain);
  assert.throws(()=>check(changed,observation),"Retired drain privilege restored");
}
assert.throws(()=>check(retiredDrain+"\n  protected-activate:\n    runs-on: ubuntu-latest\n",observation));
const music=readFileSync(".github/workflows/hosted-music-supply-disabled-qa.yml","utf8");
assert.ok(!music.includes("secrets.CLOUDFLARE_API_TOKEN"));
for(const field of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_WORKERS_METADATA_READ_TOKEN","COVE_CF_STAGE_D1_READ_TOKEN"])
  assert.ok(music.includes("secrets."+field));
const inspector=readFileSync("scripts/staging/deploy-music-supply-qa-shadow.mjs","utf8");
assert.ok(inspector.includes("authorization: \"Bearer \" + metadataToken"));
assert.ok(inspector.includes("authorization: \"Bearer \" + qaReadToken"));
assert.match(inspector, /new Set\(\[deployToken,\s*metadataToken,\s*qaReadToken\]\)\.size,\s*3/);
assert.ok(!inspector.includes('authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN'));
console.log("PASS: twelve protected jobs require exact-main manual authorization; retired drain is read-only and disabled music QA splits principals");
