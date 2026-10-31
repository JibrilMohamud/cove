/* eslint-disable prettier/prettier -- Exact 30-site source owner retirement, production stays denied. */
import {assertPublishingOwnerSourceLineage} from "./check-publishing-owner-source-lineage.mjs";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/publishing.server.ts"),
 owner=read("src/storefront-strangler/legal-authority.worker.ts"),
 gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts"),
 router=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-publishing-editor-owner-lineage.json"));
assert.equal(lineage.retiredCount,30);
assert.equal(createHash("sha256").update(source).digest("hex"),assertPublishingOwnerSourceLineage(),
 "Exact publisher source changed without audited SQL site attestation");
assert.equal(new Set(lineage.retired.map(x=>x.siteId)).size,30);
assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=113);
assert.equal(review.sites.filter(x=>x.file==="src/features/fore/publishing.server.ts"&&x.disposition==="owner-command-required").length,0);
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
for(const name of ["upsertPublishingAccount","invitePublishingMember","startIdentityVerification","submitTaxProfile","submitPayoutAccount","savePublishingTitle","savePublishingEdition","uploadPublishingAsset","signPublishingAccessibilityDeclaration","submitPublishingEdition","openPublishingRevision","setPublishingUpdatePolicy","optInOwnedPublicationUpdate","reviewPublishingSubmission"]){
 const at=source.indexOf("export async function "+name+"(");
 assert.ok(at>=0,"Missing publishing caller facade "+name);
 const body=source.slice(at,source.indexOf("\n}\n",at));
 assert.match(body,/dispatchPrivatePublishingEditor/);
 assert.doesNotMatch(body,/\.prepare\(|\.batch\(/);
}
assert.match(owner,/const privatePublishingEditor=\(\(\)=>/);
assert.match(owner,/if\(route==="\/publishing\/editor-action"\)/);
assert.match(owner,/SELECT app_id FROM auth_accounts WHERE app_id=\?/);
assert.match(owner,/SELECT user_id FROM staff_principals WHERE user_id=\? AND status='active'/);
assert.match(owner,/\["edition-submit","update-policy","owner-optin","asset-upload"\]/);
assert.match(router,/if\(!context\)throw new ApiError\(503,"Publishing editor requires a private canonical owner/);
assert.match(gateway,/"publishing.editor-action":\{path:"\/publishing\/editor-action"/);
console.log("PASS: 30 publisher editor SQL sites and the remaining helpers are private QA only; no shared publishing writer and no false production certification");
