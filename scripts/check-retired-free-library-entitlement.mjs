/* eslint-disable prettier/prettier -- Public-domain free library grant must be privately authorized. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const api=read("src/features/fore/api.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const proof=JSON.parse(read("docs/architecture/retired-free-library-entitlement-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(proof.releaseApproval,false);
assert.equal(proof.productionCertified,false);
assert.equal(proof.sourceBefore,12);
assert.equal(proof.sourceAfter,11);
assert.equal(createHash("sha256").update(api).digest("hex"),proof.currentSha256);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=11);
assert.equal(proof.retired.length,1);
assert.equal(proof.retired[0].table,"entitlements");
assert.ok(!review.sites.some(s=>s.siteId===proof.retired[0].siteId));
assert.doesNotMatch(api,/INSERT INTO entitlements\(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at\)/);
assert.match(api,/await dispatchVerifiedFreeLibraryEntitlement\(db,/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Free library entitlement requires private authority\."\)/);
assert.match(gateway,/"catalog\.grant-verified-free-library":\{path:"\/catalog\/private-grant-free-library"/);
assert.match(gateway,/case "catalog\.grant-verified-free-library":/);
assert.match(owner,/if\(route==="\/catalog\/private-grant-free-library"\)/);
for(const field of ["readAuthorizedPresentations(sql,","marketIsWithdrawn(sql,input.territory)",
 "c.rights_status='public-domain'","c.commercial_use_status='approved'",
 "e.status='approved'","c.source_id='pg_us' AND c.copyright=0",
 "ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active' DO NOTHING",
 "prior.status='revoked'"])
 assert.ok(owner.includes(field),"Missing independently authorized free library grant invariant: "+field);
console.log("PASS: free library entitlement requires private positive jurisdictional owner proof; 11 source SQL findings, production locked.");
