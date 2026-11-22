/* eslint-disable prettier/prettier -- Principal separation must survive future CI changes. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
test("deployed worker fleet audit requires separately authorized zone route reader",()=>{
 const w=read(".github/workflows/deployed-canonical-d1-principal-audit.yml");
 const src=read("scripts/audit-live-canonical-d1-principals.mjs");
 for(const x of ["secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN","secrets.COVE_CF_ZONE_ROUTES_READ_TOKEN",
  "inputs.reviewed_main_sha == github.sha","inputs.confirm_readonly_cloudflare_audit == true",
  "environment: cove-production-release-audit","github.event_name == 'workflow_dispatch'"])
  assert.ok(w.includes(x),"missing live fleet audit guard: "+x);
 assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
 assert.ok(src.includes("apiGet(fetcher,zoneToken,\"/zones/\"+zone+\"/workers/routes\")"));
 assert.ok(src.includes("assert.notEqual(token,zoneToken"));
 assert.ok(!src.includes("process.env.CLOUDFLARE_API_TOKEN"));
});
test("production topology audit uses metadata token for Worker settings, zone token for routes",()=>{
 const w=read(".github/workflows/production-cutover-topology-audit.yml");
 const src=read("scripts/check-live-production-cutover.mjs");
 for(const x of ["secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN","secrets.COVE_CF_ZONE_ROUTES_READ_TOKEN",
  "inputs.reviewed_main_sha == github.sha","environment: cove-production-release-audit"])
  assert.ok(w.includes(x),"missing topology audit guard: "+x);
 assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
 assert.ok(src.includes('cloudflareGet("/zones/"+zone+"/workers/routes",zoneToken)'));
 assert.ok(src.includes("token===zoneToken"));
 assert.ok(!src.includes("process.env.CLOUDFLARE_API_TOKEN"));
});
test("the backend-deploy owner binding check never falls back to broad token",()=>{
 const s=read("scripts/check-production-owner-binding.mjs");
 assert.ok(s.includes("process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
 assert.ok(!s.includes("process.env.CLOUDFLARE_API_TOKEN"));
});
