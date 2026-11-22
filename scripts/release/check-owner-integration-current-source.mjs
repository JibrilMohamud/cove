/* eslint-disable prettier/prettier -- Exact reviewed integration source-pinning; never a production release approval. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {currentWriterSites,reconcileWriterSites} from "../reconcile-canonical-writers.mjs";

// Historical retirement attestations certify the files that existed when
// each retirement occurred. A later, legitimately migrated file MUST NOT be
// falsely represented as byte-identical to its October ancestor. Pin all
// twelve migrated or concurrently changed current files separately instead.
// These are CI-observed bytes of the 2026-11-22 integration candidate, not
// evidence of deployed physical ownership, external rights or LIVE commerce.
const PINNED_CURRENT_SOURCES=Object.freeze({
  "src/features/fore/api.server.ts":"022315ddbdb21071b73be68005adf2cc55e6be4e8874563d2d75bf086a6c812f",
  "src/features/fore/catalog-model.server.ts":"c4d03da0a2428d5290c000d5d39f6129f2491254335c975e3acb0a340c0f172b",
  "src/features/fore/commerce.server.ts":"52ba9bb4feec5b2b7c5586687d72cd3498751a0601061823b95a5adbc6ac955f",
  "src/features/fore/localization.server.ts":"02852814c24e749359ed751717a8387ab6dc75ba4ecba78d6058ecbbfba919e1",
  "src/features/fore/promotions.server.ts":"05c37488918235a18839605db9873bc9f645b465e238ffcf9680bbd4b0618047",
  "src/features/fore/publishing.server.ts":"228ca01545a8c1cd1726cca8de49c8ec2bd4155c178bd7c3fa35c8e1b84a5139",
  "src/features/fore/publishing-trust.server.ts":"7b712809bd58a2d0456ad38da3b0ecb75621688dedd070a2f8687ebef6765590",
  "src/features/fore/regional-epub-asset-repair.server.ts":"27322f92d09b409c0913cdc96e523f0b610999a685a325fd3a0642fdb98c0443",
  "src/features/fore/rights.server.ts":"a7839d53ae20ffa3351bd6fbef797bd3d06dfb30c7d390168c195be8680e5fa2",
  "src/features/fore/search.server.ts":"b4a435335c8b8009a27288931aea94082ba1785930636e1101958955a4c881fa",
  "src/features/fore/traditional-publishing.server.ts":"364406b8ed38f06563a6e307aa0512e64b41c926ee7236bf34e216e8f0166191",
  "src/storefront-strangler/legal-authority.worker.ts":"0e9e42f3f6cba28afa399c431cdfc4cbcf874072878a655171ab8f44aa60e442",
});
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
assert.equal(review.schema,"cove.canonical-writer-review.v1");
assert.equal(review.releaseApproval,false);
const current=currentWriterSites();
const reconciled=reconcileWriterSites(current,review);
assert.deepEqual(reconciled.unknown,[],"Unreviewed current SQL cannot pass");
assert.deepEqual(reconciled.stale,[],"Stale current SQL cannot pass");
assert.equal(current.length,46,"The reviewed 46-site post-October boundary changed");
const counts=Object.fromEntries(["isolated-test-fixture","non-authorizing-write","private-owner-qa-executor","owner-command-required"]
  .map(d=>[d,review.sites.filter(s=>s.disposition===d).length]));
assert.deepEqual(counts,{"isolated-test-fixture":1,"non-authorizing-write":22,"private-owner-qa-executor":23,"owner-command-required":0});
assert.ok(review.sites.every(s=>s.productionOwnerGuarded===false),
  "Current source audit cannot certify deployed ownership");
for(const [path,pin] of Object.entries(PINNED_CURRENT_SOURCES)){
  const actual=createHash("sha256").update(readFileSync(path,"utf8")).digest("hex");
  assert.equal(actual,pin,"New current source change requires independent legal/caller review: "+path);
}
assert.equal(current.filter(s=>s.file==="src/features/fore/api.server.ts").length,0,
  "Shared API regained a direct protected SQL site");
console.log("PASS: 12 exact integrated source pins; 46 literal SQL sites reconciled (0 owner-required); 38 historical attestation claims remain historical, not recertified.");
console.log("NO-GO: source closure is not active D1 binding/token exclusivity or current rightsholder authority.");
