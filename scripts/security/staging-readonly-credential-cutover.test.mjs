/* eslint-disable prettier/prettier -- Explicit QA audit credential-retirement invariants. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
test("staging preflight uses isolated data-plane read principal and protected main dispatch",()=>{
  const w=read(".github/workflows/strangler-data-plane-preflight.yml");
  for(const s of ["secrets.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
    "environment: cove-production-release-audit",
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_protected_cloudflare_action == true",
    "github.event_name == 'workflow_dispatch'"])
    assert.ok(w.includes(s), "Missing read-only admission boundary: "+s);
  assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"),
    "The broad token must not be supplied to read-only CI");
  assert.ok(!w.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"),
    "The read-only job must not receive Worker deployment capability");
});
test("protected hosted-capacity preflight also receives read-only principal",()=>{
  const w=read(".github/workflows/strangler-hosted-capacity-evaluation.yml");
  assert.ok(w.includes("COVE_CF_STAGE_DATA_PLANE_READ_TOKEN: ${{ secrets.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN }}"));
  assert.ok(w.includes("inputs.reviewed_main_sha == github.sha"));
  assert.ok(w.includes("environment: cove-production-release-audit"));
});
for(const path of ["scripts/staging/check-strangler-data-plane-preflight.mjs",
  "scripts/staging/check-strangler-synthetic-producer-sql.mjs"]){
  test(path+" selects only narrow read-only data-plane principal",()=>{
    const code=read(path);
    assert.ok(code.includes("process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN"));
    assert.ok(code.includes("d26430caa63ec55f6612e32f36aca5e9"));
    assert.ok(!code.includes("token = process.env.CLOUDFLARE_API_TOKEN"));
    assert.ok(!code.includes("wrangler deploy"));
  });
}
