/* eslint-disable prettier/prettier -- Existing source identities and private owner R2 proof. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const path="src/features/fore/commercial-audio.server.ts",
  source=read(path),owner=read("src/storefront-strangler/legal-authority.worker.ts"),
  router=read("src/storefront-strangler/publication-owner-routing.server.ts"),
  gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const att=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-upload-attestation-20261030.json"));
const lineage=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-upload-lineage.json"));
assert.equal(createHash("sha256").update(source).digest("hex"),att.files[0].sha256);
assert.equal(lineage.updatedSourceSha256,att.files[0].sha256);
assert.equal(lineage.retiredCount,6);
assert.equal(review.releaseApproval,false);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,209);
assert.equal(review.sites.filter(x=>x.file===path&&x.disposition==="owner-command-required").length,3);
for(const row of lineage.rows)assert.ok(!review.sites.some(x=>x.siteId===row.siteId));
assert.ok(!source.includes("async function queueCommercialAudioQc("));
const start=source.indexOf("export async function uploadCommercialAudioFile("),
  end=source.indexOf("export async function completeCommercialAudioQc(",start);
assert.ok(start>=0&&end>start);
const upload=source.slice(start,end);
assert.match(upload,/dispatchCommercialAudioUploadMetadata\(env\.DB,/);
assert.doesNotMatch(upload,/\b(?:INSERT INTO|DELETE FROM|UPDATE)\s+commercial_audio_/i);
assert.match(owner,/registerPrivateCommercialAudioUpload/);
assert.match(owner,/privateAudioMetadata\.requireAudioUploadEdition/);
assert.match(owner,/bucket\.head\(input\.key\)/);
assert.match(owner,/await db\.batch\(statements\)/);
assert.ok(owner.includes('if(route==="/publishing/audio/register-upload")'));
assert.match(gateway,/"publishing\.audio-register-upload":\{path:"\/publishing\/audio\/register-upload"/);
assert.match(gateway,/case "publishing\.audio-register-upload":/);
assert.match(router,/dispatchCommercialAudioUploadMetadata/);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
console.log("PASS: R2 upload and QC queue shared writers retired; after independently reviewed support retirement, 209 unresolved, independent production owner still locked");
