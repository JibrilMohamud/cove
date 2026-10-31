/* eslint-disable prettier/prettier -- Source exact non-bypass retirement of 13 partner SQL sites. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=p=>readFileSync(p,"utf8"),source=get("src/features/fore/traditional-publishing.server.ts"),
 owner=get("src/storefront-strangler/legal-authority.worker.ts"),
 router=get("src/storefront-strangler/publication-owner-routing.server.ts"),
 gateway=get("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(get("docs/architecture/canonical-writer-review.json")),
 lineage=JSON.parse(get("docs/architecture/retired-traditional-partner-owner-lineage.json"));
assert.equal(lineage.retiredCount,13);
assert.equal(new Set(lineage.siteReview.map(s=>s.siteId)).size,13);
assert.equal(review.releaseApproval,false);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,113);
assert.equal(review.sites.filter(x=>x.file==="src/features/fore/traditional-publishing.server.ts"&&x.disposition==="owner-command-required").length,0);
assert.ok(lineage.siteReview.every(s=>!review.sites.some(x=>x.siteId===s.siteId)));
for(const name of ["certifyPartnerProfile","issuePartnerCredential","revokePartnerCredential","submitPartnerFeed","matchAssetExpectations","uploadPartnerAsset","assignPublisherContract","reconcilePublicDomainWorks"]){
 const start=source.indexOf("function "+name+"(");
 assert.ok(start>=0,name+" facade absent");
 const end=source.indexOf("\n}\n",start);
 const body=source.slice(start,end);
 assert.doesNotMatch(body,/\.prepare\(|\.batch\(/,name+" facade still writes D1");
 assert.match(body,/dispatchPrivatePartnerAction|throw new ApiError\(503/);
}
assert.match(owner,/const privateTraditionalPartner=\(\(\)=>/);
assert.match(owner,/if\(route==="\/publishing\/partner\/private-action"\)/);
assert.match(owner,/SELECT user_id FROM staff_principals WHERE user_id=\? AND status='active'/);
assert.match(owner,/SELECT app_id FROM auth_accounts WHERE app_id=\?/);
assert.match(owner,/\["paused","terminated"\]/);
assert.match(gateway,/"publishing.partner-private-action":\{path:"\/publishing\/partner\/private-action"/);
assert.match(router,/if\(!context\)throw new ApiError\(503,"Partner mutations require a privately bound owner/);
console.log("PASS: 13 partner SQL source sites privately owned in QA; 113 remain; positive commercial trust locked");
