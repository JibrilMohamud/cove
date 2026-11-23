/* eslint-disable prettier/prettier -- Exact QC writer retirement and source review. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const path="src/features/fore/commercial-audio.server.ts";
const source=read(path),owner=read("src/storefront-strangler/legal-authority.worker.ts"),
  gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts"),
  routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json")),
  att=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-qc-attestation-20261030.json")),
  lineage=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-qc-lineage.json"));
assert.equal(createHash("sha256").update(source).digest("hex"),att.files[0].sha256);
assert.equal(lineage.updatedSourceSha256,att.files[0].sha256);
assert.equal(lineage.retiredCount,7);assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=223,"Further source-retired writers may only decrease count");
assert.ok(review.sites.filter(x=>x.file===path&&x.disposition==="owner-command-required").length<=2);
for(const row of lineage.rows)assert.ok(!review.sites.some(x=>x.siteId===row.siteId));
for(const name of ["leaseCommercialAudioQcJobs","completeCommercialAudioQc"]) {
  const start=source.indexOf("export async function "+name+"(");
  const end=source.indexOf("\n}\n",start);
  assert.ok(start>=0&&end>start);
  const body=source.slice(start,end+3);
  assert.match(body,/dispatchCommercialAudioQcJob\(db,/);
  assert.doesNotMatch(body,/\b(?:INSERT INTO|DELETE FROM|UPDATE)\s+commercial_audio_/i);
}
assert.ok(owner.includes('if(route==="/publishing/audio/qc-jobs")'));
assert.match(owner,/privateAudioQcQueues/);
assert.match(gateway,/"publishing\.audio-qc-jobs":\{path:"\/publishing\/audio\/qc-jobs"/);
assert.match(gateway,/case "publishing\.audio-qc-jobs":/);
assert.match(routing,/dispatchCommercialAudioQcJob/);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
console.log("PASS: seven audiobook QC writers private to QA legal owner; 223 still owner-required, production locked");
