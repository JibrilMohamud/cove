/* eslint-disable prettier/prettier -- Source-only regional legal-authority retirement guard. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/api.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const ln=JSON.parse(read("docs/architecture/retired-regional-rights-evidence-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(ln.releaseApproval,false);
assert.equal(ln.productionCertified,false);
assert.equal(ln.sourceBefore,5);
assert.equal(ln.sourceAfter,1);
assert.equal(createHash("sha256").update(source).digest("hex"),ln.currentSha256);
assert.equal(ln.retired.length,4);
assert.ok(ln.retired.every(x=>x.disposition==="owner-command-required"));
assert.ok(ln.retired.every(x=>!review.sites.some(r=>r.siteId===x.siteId)));
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=1);
const a=source.indexOf("async function insertRegionalEvidence(");
const b=source.indexOf("\nasync function quarantineRegionalItem(",a);
assert.ok(a>0&&b>a);
const retired=source.slice(a,b);
assert.match(retired,/await dispatchPrivateRegionalRightsEvidence\(db,/);
assert.doesNotMatch(retired,/\b(?:INSERT INTO|INSERT OR IGNORE INTO|UPDATE|DELETE FROM)\s+(?:gutenberg_rights_evidence|gutenberg_source_cache|rights_grants)/i);
assert.match(gateway,/"catalog\.verify-regional-rights-evidence":\{/);
assert.match(gateway,/case "catalog\.verify-regional-rights-evidence":/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Regional rights evidence requires private legal authority."\)/);
assert.match(owner,/if\(route==="\/catalog\/private-regional-rights-evidence"\)/);
for(const guard of ["COVE_REGIONAL_RIGHTS_VERIFIER_URL","COVE_REGIONAL_RIGHTS_VERIFIER_TOKEN",
  "marketIsWithdrawn(sql,t)","validateStoredEpub(bytes)","canonicalizeRegionalEpub(bytes,cache.source_id)",
  "actual!==x.sha256","proof.decision!==\"public-domain\"",
  "proof.territories","proof.rightsFingerprint","proof.evidenceDigest",
  "proof.catalogHash","proof.evidenceUrl","proof.approverId",
  "verifiedAt<Date.now()-60*60_000","gutenberg_rights_evidence",
  "rights_grants SET status='suspended'","commercialCatalogStatements(db,x.cacheId,at)",
  "rights_grants SET status='active'"])
  assert.ok(owner.includes(guard),"Missing positive regional rights guard: "+guard);
console.log("PASS: four regional rights and grant writers privately retired (5→1), independent positive evidence and denial mandatory.");
