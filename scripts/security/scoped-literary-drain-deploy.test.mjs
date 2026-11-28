/* eslint-disable prettier/prettier -- Fail-closed protected deployment credential partition. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
const workflows=[
  ".github/workflows/literary-drain-worker-deploy.yml",
  ".github/workflows/literary-isolated-replay-handoff-deploy.yml"
];
test("protected literary drain and replay use independent narrow deployment and read credentials",()=>{
  for(const path of workflows){
    const body=read(path);
    assert.ok(!body.includes("secrets.CLOUDFLARE_API_TOKEN"),path);
    assert.ok(!body.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"),path);
    const profile=path.includes("replay")?"literary-replay":"literary-drain";
    const guard=body.indexOf("node scripts/release/verify-temporary-worker-maintenance.mjs "+profile);
    assert.ok(guard>=0&&guard<body.indexOf("wrangler deploy --config"),path+" missing pre-deploy provider scope verification");
    for(const name of [
      "COVE_CF_PROD_MAINTENANCE_TOKEN",
      "COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
      "COVE_CF_WORKERS_METADATA_READ_TOKEN"
    ]) assert.ok(body.includes("secrets."+name),path+": "+name);
    for(const pair of [
      'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_STAGE_DATA_PLANE_READ_TOKEN"',
      'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"',
      'test "$COVE_CF_STAGE_DATA_PLANE_READ_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"'
    ]) assert.ok(body.includes(pair),path+" missing distinct principal fence");
    assert.ok(body.includes("environment: cove-production-release-audit"));
    assert.ok(body.includes("inputs.reviewed_main_sha == github.sha"));
  }
});
test("literary D1 and R2 preflight remains read-only and refuses broad deploy bearer",()=>{
  const a=read("scripts/staging/verify-literary-drain-predeploy.mjs");
  const b=read("scripts/staging/verify-literary-replay-upgrade.mjs");
  for(const s of [a,b]){
    assert.ok(s.includes("process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN"));
    assert.ok(s.includes("token!==deployToken"));
    assert.ok(s.includes(String.raw`/^SELECT\b/i`));
    assert.ok(!s.includes("const token = process.env.CLOUDFLARE_API_TOKEN;"));
  }
  assert.ok(a.includes("Only D1 SELECT or R2 metadata GET permitted"));
  assert.ok(a.includes("isReadOnlyQuery"));
  assert.ok(a.includes("isR2List"));
  const c=read("scripts/staging/verify-literary-drain-workers.mjs");
  assert.ok(c.includes("process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  assert.ok(c.includes("Metadata audit may only GET Worker configuration"));
  assert.ok(c.includes("token!==deployToken"));
});
