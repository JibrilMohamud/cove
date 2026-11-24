/* eslint-disable prettier/prettier -- Exact protected audit workflow guard; no network or secrets. */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";

const source=readFileSync(".github/workflows/cove-protected-bulk-certification.yml","utf8");
assert.match(source,/timeout-minutes: 120/);
assert.match(source,/environment: cove-production-release-audit/);
assert.match(source,/github\.ref == 'refs\/heads\/main'/);
assert.match(source,/inputs\.reviewed_main_sha == github\.sha/);
// These are the exact protected source families that previously merged
// without triggering hosted evidence. No test-only or PR event may dispatch
// the manually protected child workflows.
for(const file of [
  "scripts/staging/prove-private-paid-owner.mjs",
  "scripts/staging/verify-literary-postpublication-readonly.mjs",
  "scripts/staging/check-strangler-data-plane-preflight.mjs",
  "scripts/staging/check-protected-canonical-real-d1-differential.mjs",
  "scripts/staging/rights-differential-coverage.mjs"
])assert.ok(source.includes('      - "'+file+'"'),
  "A production certification-sensitive source file is missing from main batch dispatch");
// A verifier-only edit has its own protected metadata-only push workflow;
// preserve completed hosted proofs whose runtime/source did not change.
const userFlow=readFileSync(".github/workflows/cove-protected-user-token-readonly.yml","utf8");
const bulkPush=source.slice(source.indexOf("  push:"),source.indexOf("  workflow_dispatch:"));
assert.ok(!bulkPush.includes('      - "scripts/release/certify-exclusive-primary-d1.mjs"'));
assert.match(userFlow,/push:\s+branches: \[main\]/);
assert.ok(userFlow.includes('      - "scripts/release/certify-exclusive-primary-d1.mjs"'));
assert.match(userFlow,/environment: cove-production-release-audit/);
const start=source.indexOf("      - name: Dispatch and verify child workflows in concurrency-safe lanes");
const first=source.indexOf("        run: |\n",start);
const end=source.indexOf("      - uses: actions/upload-artifact@v4",first);
assert.ok(start>0 && first>start && end>first,"Protected batch run block missing");
const bash=source.slice(first+"        run: |\n".length,end).split("\n").map(line=>
  line.startsWith("          ")?line.slice(10):line).join("\n");
execFileSync("bash",["-n"],{input:bash});
const names=[...bash.matchAll(/\bverify\s+([a-z0-9-]+\.yml)\s+/g)].map(m=>m[1]);
assert.equal(names.length,11);
assert.equal(new Set(names).size,11);
const block=(name,next)=>{
  const a=bash.indexOf(name+"() {");
  const b=next?bash.indexOf(next+"() {"):bash.indexOf("pids=\"\"");
  assert.ok(a>=0&&b>a,"Missing or reordered lane "+name);
  return bash.slice(a,b);
};
const paid=block("paid","biosync");
const biosync=block("biosync","rollback");
const rollback=block("rollback","capacity_writer");
const capacity=block("capacity_writer","legal");
const legal=block("legal","tokens");
const tokens=block("tokens","differential");
const diff=block("differential",null);
for(const [part,workflow] of [[paid,"paid-legal-full-schema-private-qa.yml"],[biosync,"cove-biosync-owner-cutover-offline.yml"],[rollback,"cove-stage-protected-worker-rollback.yml"],[tokens,"cove-protected-user-token-readonly.yml"],[diff,"cove-protected-stage-canonical-rights-differential.yml"]])
  assert.ok(part.includes(workflow));
assert.ok(capacity.indexOf("strangler-hosted-capacity-evaluation.yml")<capacity.indexOf("cove-exclusive-primary-d1-writer-audit.yml"));
assert.ok(legal.indexOf("cove-protected-full-primary-historical-rights.yml")<legal.indexOf("cove-protected-primary-grant-event-replay.yml"));
assert.ok(legal.indexOf("cove-protected-primary-grant-event-replay.yml")<legal.indexOf("cove-protected-external-source-withdrawal-audit.yml"));
assert.ok(legal.indexOf("cove-protected-external-source-withdrawal-audit.yml")<legal.indexOf("cove-protected-real-rights-spot-readonly.yml"));
assert.ok(bash.includes("for pid in $pids; do wait"));
assert.ok(bash.includes("identity-drift"));
assert.ok(bash.includes("UNVERIFIED CHILD"));
assert.ok(!/deploy-persistence-backend|production-legal-owner-locked|publish-cloudflare-worker/.test(bash));
console.log("PASS: 11 exact protected workflows, conflict-free lanes, verified child outcomes, main SHA guard, and no production cutover.");
