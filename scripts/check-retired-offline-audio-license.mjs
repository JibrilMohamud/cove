/* eslint-disable prettier/prettier -- Verify physically retired commercial offline-license SQL. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/commercial-audio.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-offline-audio-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.releaseApproval,false);
assert.equal(lineage.productionCertified,false);
assert.equal(lineage.sourceBefore,8);
assert.equal(lineage.sourceAfter,6);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.currentSha256);
assert.equal(lineage.retired.length,2);
assert.ok(lineage.retired.every(x=>x.disposition==="owner-command-required"));
assert.ok(lineage.retired.every(x=>!review.sites.some(r=>r.siteId===x.siteId)));
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=6);
assert.doesNotMatch(source,/UPDATE audio_offline_licenses SET status='revoked',revoked_at=/);
assert.doesNotMatch(source,/INSERT INTO audio_offline_licenses\(/);
assert.match(source,/await dispatchPrivateOfflineAudioLicense\(db,/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Offline audio license requires private legal authority."\)/);
assert.match(gateway,/"audio\.issue-offline-license":\{path:"\/audio\/private-offline-license"/);
assert.match(gateway,/case "audio\.issue-offline-license":/);
assert.match(owner,/if\(route==="\/audio\/private-offline-license"\)/);
for(const guard of ["readPaidAccess(sql,","marketIsWithdrawn(sql,x.territory)",
  "narration_agreement_terminations","sourceSnapshot.commercialAudio",
  "JSON.stringify(chapters.map(c=>[c.id,c.sha256]))","entitlement_type='purchase'",
  "audio_offline_licenses","await db.batch(["])
  assert.ok(owner.includes(guard),"Missing independent offline owner guard: "+guard);
console.log("PASS: two commercial offline audio license writers retired; later retirements are monotonic, no production approval.");
