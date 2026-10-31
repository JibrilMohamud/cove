/* eslint-disable prettier/prettier -- Auditor source identity and private owner command only. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const src=read("src/features/fore/commercial-audio.server.ts"),owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json")),lineage=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-metadata-lineage.json"));
const att=JSON.parse(read("docs/architecture/retired-owner-commercial-audio-metadata-attestation-20261030.json"));
assert.equal(createHash("sha256").update(src).digest("hex"),att.files[0].sha256);
assert.equal(lineage.sourceSha256,att.files[0].sha256);
assert.equal(lineage.removedCount,6);assert.equal(review.releaseApproval,false);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,239);
assert.equal(review.sites.filter(x=>x.file==="src/features/fore/commercial-audio.server.ts"&&x.disposition==="owner-command-required").length,16);
for(const row of lineage.rows)assert.ok(!review.sites.some(x=>x.siteId===row.siteId));
for(const method of ["saveCommercialAudioProfile","replaceCommercialAudioNarrators","addNarrationAgreement","endNarrationAgreement"]){
  const start=src.indexOf("export async function "+method+"(");
  assert.ok(start>=0);
  const next=src.indexOf("export async function ",start+20);
  const body=src.slice(start,next<0?undefined:next);
  assert.match(body,/dispatchCommercialAudioMetadata\(db,/);
  assert.doesNotMatch(body,/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(commercial_audio|narration_agreement)/i);
}
assert.ok(!src.includes("async function refreshAgreementStatus("));
assert.match(gateway,/"publishing\.audio-metadata":\{path:"\/publishing\/audio\/metadata"/);
assert.match(gateway,/case "publishing\.audio-metadata":/);
assert.match(routing,/"publishing\.audio-metadata",\{action,userId,payload,operationId\}/);
assert.ok(owner.includes('if(route==="/publishing/audio/metadata")'));
assert.match(owner,/const privateAudioMetadata=/);
assert.match(owner,/await privateAudioMetadata\.addNarrationAgreement/);
assert.match(owner,/pe\.verification_status='verified'/);
assert.match(owner,/SELECT role FROM publishing_account_members WHERE account_id=\? AND user_id=\? AND status='active'/);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
console.log("PASS: six commercial audiobook profile+narration writers retired from shared D1 to QA owner; 239 unresolved, live disabled");
