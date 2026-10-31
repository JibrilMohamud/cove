/* eslint-disable prettier/prettier -- Independently byte-bound regional EPUB owner metadata retirement. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const api=read("src/features/fore/api.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const proof=JSON.parse(read("docs/architecture/retired-regional-epub-metadata-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(proof.releaseApproval,false);
assert.equal(proof.productionCertified,false);
assert.equal(proof.sourceBefore,15);
assert.equal(proof.sourceAfter,14);
assert.equal(createHash("sha256").update(api).digest("hex"),proof.currentSha256);
assert.equal(proof.retired.length,1);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,14);
assert.ok(proof.retired.every(x=>x.functionName==="cachePendingEpubs"&&
  !review.sites.some(y=>y.siteId===x.siteId)));
assert.doesNotMatch(api,/UPDATE gutenberg_source_cache SET\s*title=CASE WHEN \?<>'' THEN \? ELSE title END/);
assert.match(api,/await dispatchVerifiedRegionalEpubMetadata\(db,/);
assert.match(gateway,/"catalog\.regional-epub-metadata":\{path:"\/catalog\/verified-regional-epub-metadata"/);
assert.match(gateway,/case "catalog\.regional-epub-metadata":/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Regional EPUB metadata requires private authority\."\)/);
assert.match(owner,/if\(route==="\/catalog\/verified-regional-epub-metadata"\)/);
for(const proof of ["epub_status='downloading'","await validateStoredEpub(bytes)",
  'crypto.subtle.digest("SHA-256",bytes)',
  "canonicalizeRegionalEpub(bytes,eligible.source_id)","result.meta?.changes"])
  assert.ok(owner.includes(proof),"Owner must independently verify regional metadata: "+proof);
assert.ok(!review.sites.some(x=>x.file==="src/features/fore/api.server.ts"&&
  x.functionName==="cachePendingEpubs"&&x.table==="gutenberg_source_cache"));
console.log("PASS: private owner verifies regional metadata against exact R2 EPUB; 14 owner-required source sites; release locked.");
