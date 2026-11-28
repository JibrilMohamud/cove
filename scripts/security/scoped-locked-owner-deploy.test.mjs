/* eslint-disable prettier/prettier -- Never feed the broad Cloudflare bearer to protected disabled owner. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=path=>readFileSync(path,"utf8");
test("locked production owner uses separate deployment, metadata and zone-route principals",()=>{
  const w=read(".github/workflows/production-legal-owner-locked.yml");
  const owner=read("scripts/check-locked-production-legal-owner.mjs");
  for(const value of [
    "CLOUDFLARE_API_TOKEN: \${{ secrets.COVE_CF_PROD_MAINTENANCE_TOKEN }}",
    "COVE_CF_WORKERS_METADATA_READ_TOKEN: \${{ secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN }}",
    "COVE_CF_ZONE_ROUTES_READ_TOKEN: \${{ secrets.COVE_CF_ZONE_ROUTES_READ_TOKEN }}",
    "inputs.reviewed_main_sha == github.sha",
    "inputs.confirm_protected_cloudflare_action == true",
    "github.event_name == 'workflow_dispatch'",
    "environment: cove-production-release-audit",
    'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_ZONE_ROUTES_READ_TOKEN"',
    'test "$CLOUDFLARE_API_TOKEN" != "$COVE_CF_WORKERS_METADATA_READ_TOKEN"',
  ]) assert.ok(w.includes(value),"Missing exact owner credential gate: "+value);
  assert.ok(!w.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!w.includes("secrets.COVE_CF_PROD_D1_MIGRATIONS_TOKEN"));
  assert.ok(owner.includes("process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  // The protected workflow proves all three credentials are pairwise distinct.
  // The read-only checker MUST NOT even access the deploy credential.
  assert.ok(owner.includes("process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN"));
  assert.ok(!owner.includes("process.env.CLOUDFLARE_API_TOKEN"));
  assert.ok(!owner.includes("const token=process.env.CLOUDFLARE_API_TOKEN"));
  assert.ok(w.includes("node scripts/check-live-production-cutover.mjs --audit"));
});
test("production owner template stays disabled with no public ingress",()=>{
  const c=JSON.parse(read("wrangler.legal-authority.production-locked.jsonc"));
  assert.equal(c.vars.COVE_RIGHTS_OWNER_ENABLED,"0");
  assert.equal(c.workers_dev,false);
  assert.equal(c.preview_urls,false);
  assert.deepEqual(c.routes,[]);
  assert.equal(c.d1_databases[0].database_id,"4bd657ac-8789-403e-a28c-93aba8d0a989");
});
