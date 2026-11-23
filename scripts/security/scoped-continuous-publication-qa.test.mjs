/* eslint-disable prettier/prettier -- Exact staged principal partition is an authorizing security contract. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=path=>readFileSync(path,"utf8");

test("continuous publication QA is protected and cannot use the broad bearer",()=>{
  const w=read(".github/workflows/continuous-publication-qa.yml");
  assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
  for(const name of ["COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN","COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
    "COVE_CF_WORKERS_METADATA_READ_TOKEN"])
    assert.ok(w.includes("secrets."+name),"Missing scoped principal "+name);
  for(const pair of [
    'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_STAGE_DATA_PLANE_READ_TOKEN"',
    'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"',
    'test "$COVE_CF_STAGE_DATA_PLANE_READ_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"'
  ])assert.ok(w.includes(pair),"Missing pairwise principal-isolation guard");
  assert.ok(w.includes("inputs.reviewed_main_sha == github.sha"));
  assert.ok(w.includes("github.event_name == 'workflow_dispatch'"));
  assert.ok(w.includes("environment: cove-production-release-audit"));
  assert.ok(!w.includes("  schedule:"));
});
test("publication deployer separates Worker metadata and isolated D1 GET",()=>{
  const s=read("scripts/staging/deploy-continuous-publication-qa.mjs");
  for(const v of ["process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
    "process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN",
    "process.env.CLOUDFLARE_API_TOKEN","new Set([deployToken, dataReadToken, metadataReadToken])",
    "const bearer = d1Read ? dataReadToken : metadataReadToken",
    'assert.ok(d1Read || workerRead'])
    assert.ok(s.includes(v),"Missing deployed principal segregation: "+v);
  assert.ok(!s.includes('authorization: "Bearer " + deployToken'));
  assert.ok(s.includes('config.workers_dev, false'));
  assert.ok(s.includes('config.preview_urls, false'));
});
test("market verifier is D1 SELECT-only, isolated-db-only and R2-read-only",()=>{
  const s=read("scripts/staging/verify-continuous-publication-qa.mjs");
  assert.ok(s.includes("process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN"));
  assert.ok(s.includes("new Set([dataReadToken, deployToken, metadataReadToken]).size"));
  assert.ok(s.includes('assert.equal(method, "POST"'));
  assert.ok(s.includes('path === `/accounts/${account}/d1/database/${id}/query`'));
  assert.ok(s.includes("assert.match(String(payload?.sql || \"\""));
  assert.ok(s.includes("Bearer \" + dataReadToken"));
  assert.ok(!s.includes('authorization: "Bearer " + deployToken'));
  assert.ok(s.includes("cove-strangler-private-presentation-stage"));
});
