/* eslint-disable prettier/prettier -- Verifies live deployment guard via actual Bash step. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
const source=readFileSync(".github/workflows/deploy-persistence-backend.yml","utf8");
const header="      - name: Validate deployment inputs\n";
const next="      - name: Verify strict production guest-catalog release probe behavior\n";
assert.equal(source.split(header).length,2);
const segment=source.split(header)[1].split(next)[0];
const mark="        run: |\n";
assert.equal(segment.split(mark).length,2);
const bash=segment.split(mark)[1].split("\n")
  .filter(line=>line.startsWith("          ")||line==="")
  .map(line=>line.startsWith("          ")?line.slice(10):line).join("\n");
assert.match(bash,/^set -euo pipefail/m);
assert.match(bash,/Noncanonical Worker forbidden in production deployment/);
assert.match(bash,/Production D1 ID mismatch/);
assert.match(bash,/Production media bucket mismatch/);
const defaults={
  WORKER_NAME:"cove-persistence-backend",
  D1_DATABASE_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989",
  D1_DATABASE_NAME:"cove-production",
  R2_BUCKET_NAME:"cove-production-media",
  PUBLIC_URL:"https://cove-puce-theta.vercel.app",
};
function verify(change,allowed,why){
  const env={...process.env,...defaults,...change};
  const run=spawnSync("bash",["-c",bash],{
    env,encoding:"utf8",timeout:15000,
  });
  assert.equal(run.status,allowed?0:1,
    why+" status="+run.status+" stderr="+String(run.stderr).slice(0,400));
}
verify({},true,"Canonical production resources must validate");
verify({WORKER_NAME:"cove-qa-clone"},false,"Alternate Worker must never bind production D1");
verify({D1_DATABASE_ID:"00000000-0000-0000-0000-000000000000"},false,"Alternate D1 cannot replace production");
verify({D1_DATABASE_NAME:"cove-test"},false,"D1 name must be pinned");
verify({R2_BUCKET_NAME:"cove-stage-media"},false,"Production R2 must be pinned");
verify({PUBLIC_URL:"https://staging.example.com"},false,"Worker cannot shift canonical trusted public URL");
const migration=source.match(/apply_migrations:\s*\n(?:.*\n){0,6}?\s*default:\s*(true|false)/);
assert.equal(migration?.[1],"false","Migrations must NEVER be default-on");
assert.match(source,/inputs\.apply_migrations == true/);
assert.match(source,/Deny direct production D1 schema migration/);
assert.doesNotMatch(source,/retry-production-d1-migrations\.mjs/);
assert.doesNotMatch(source,/secrets\.CLOUDFLARE_API_TOKEN/);
assert.match(source,/secrets\.COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN/);
assert.match(source,/github\.event_name == 'workflow_dispatch'/);
assert.match(source,/github\.ref == 'refs\/heads\/main'/);
assert.doesNotMatch(source,/COVE_PRODUCTION_PERSISTENCE_AUTO_DEPLOY/);
assert.doesNotMatch(source,/^  push:/m);
console.log("PASS: protected manual-only backend Editor deployment and no direct D1 migrations");
