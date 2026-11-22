/* eslint-disable prettier/prettier -- Exact protected delivery source audit assertions. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/delivery.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-negative-commercial-delivery-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.sourceAfter,48);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=48);
assert.equal(lineage.retired.length,5);
assert.equal(lineage.retired.filter(x=>x.disposition==="owner-command-required").length,4);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.sourceShaAfter);
for(const x of lineage.retired)assert.ok(!review.sites.some(y=>y.siteId===x.siteId));
for(const term of ["INSERT INTO commercial_delivery_policies(","INSERT INTO publication_version_distribution_controls(","UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason=?","UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason='customer_revoked'"]){
 assert.ok(!source.includes(term),"Shared delivery writer still exists: "+term);
 assert.ok(owner.includes(term),"Private owner missing reviewed replacement: "+term);
}
assert.match(owner,/if\(route==="\/delivery\/private-negative"\)/);
assert.match(owner,/previous\?\.distribution_status==="recalled"/);
assert.match(owner,/INSERT OR IGNORE INTO publication_version_distribution_events/);
assert.match(owner,/commerce.manage/);
assert.match(owner,/p.allowBrowserRead\|\|p.allowFileDownload/);
assert.match(gateway,/case "delivery.private-negative":/);
assert.match(routing,/dispatchNegativeDeliveryOwner/);
console.log("PASS: four protected delivery writes and one event projection moved privately; no positive rights relaxation");
