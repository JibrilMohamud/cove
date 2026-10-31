/* eslint-disable prettier/prettier -- Exact private ownership materialization source regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/delivery.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-commercial-ownership-snapshot-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.releaseApproval,false);
assert.equal(lineage.productionCertified,false);
assert.equal(lineage.sourceBefore,13);
assert.equal(lineage.sourceAfter,12);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.currentSha256);
assert.equal(lineage.retired.length,1);
assert.equal(lineage.retired[0].table,"entitlement_ownership_records");
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,12);
assert.ok(!review.sites.some(x=>x.siteId===lineage.retired[0].siteId));
assert.doesNotMatch(source,/INSERT INTO entitlement_ownership_records\(/);
assert.match(source,/dispatchPrivateOwnershipSnapshot\(db,/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Commercial ownership requires private authority\."\)/);
assert.match(gateway,/"delivery\.record-ownership":\{path:"\/delivery\/private-record-ownership"/);
assert.match(gateway,/case "delivery\.record-ownership":/);
assert.match(owner,/if\(route==="\/delivery\/private-record-ownership"\)/);
for(const token of ["materializeOwnerOwnershipRecord","readPaidAccess(sql,",
 "cove_paid_entitlement_scopes","INSERT INTO entitlement_ownership_records(",
 "ON CONFLICT(entitlement_id) DO NOTHING",
 "e.status='active'","publishing_entitlement_version_pins",
 "publication_scope_invalid"])assert.ok(owner.includes(token),"Private ownership proof missing "+token);
assert.ok(!review.sites.some(s=>s.file==="src/features/fore/delivery.server.ts"&&
 s.table==="entitlement_ownership_records"));
console.log("PASS: independently authorized private commercial ownership and 12 source findings; release locked.");
