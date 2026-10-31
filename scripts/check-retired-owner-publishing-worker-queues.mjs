/* eslint-disable prettier/prettier -- Exact private queue retirement and live denial. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const evidence=JSON.parse(read("docs/architecture/retired-owner-publishing-worker-queues-attestation-20261030.json"));
const lineage=JSON.parse(read("docs/architecture/retired-owner-publishing-worker-queues-lineage.json"));
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
for(const row of evidence.files)assert.equal(createHash("sha256").update(read(row.path)).digest("hex"),row.sha256);
assert.equal(lineage.retiredCount,9);
assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=230,"Later source-verified retirements may only reduce count");
for(const row of lineage.rows)assert.ok(!review.sites.some(s=>s.siteId===row.siteId));
for(const [path,names] of [
  ["src/features/fore/publishing.server.ts",["leasePublishingValidationJobs","completePublishingValidationJob"]],
  ["src/features/fore/publishing-trust.server.ts",["leaseRightsEvidenceScanJobs","completeRightsEvidenceScanJob"]]
]){
  const source=read(path);
  for(const name of names){
    const start=source.indexOf("export async function "+name+"(");
    assert.ok(start>=0,"Missing public wrapper "+name);
    const end=source.indexOf("\n}\n",start);
    const fn=source.slice(start,end+3);
    assert.match(fn,/dispatchPublishingOwnerValidationJob\(db,/);
    assert.doesNotMatch(fn,/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+publishing_/i);
  }
}
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
assert.ok(owner.includes('if(route==="/publishing/worker/jobs")'));
assert.match(owner,/privatePublishingWorkQueues/);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
assert.match(gateway,/"publishing\.worker-jobs":\{path:"\/publishing\/worker\/jobs"/);
assert.match(gateway,/case "publishing\.worker-jobs":/);
assert.match(routing,/dispatchPublishingOwnerValidationJob/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Publishing validation requires its private owner."\)/);
console.log("PASS: 9 formerly shared publisher validation/rights-scan writes private QA owner, 230 remain; production locked");
