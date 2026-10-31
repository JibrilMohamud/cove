/* eslint-disable prettier/prettier -- Independently authorized commercial bearer grant source regression. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/delivery.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const ln=JSON.parse(read("docs/architecture/retired-epub-delivery-grant-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(ln.releaseApproval,false);
assert.equal(ln.productionCertified,false);
assert.equal(ln.sourceBefore,11);
assert.equal(ln.sourceAfter,10);
assert.equal(createHash("sha256").update(source).digest("hex"),ln.currentSha256);
assert.equal(ln.retired.length,1);
assert.equal(ln.retired[0].table,"commercial_delivery_grants");
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=10);
assert.ok(!review.sites.some(x=>x.siteId===ln.retired[0].siteId));
assert.doesNotMatch(source,/INSERT INTO commercial_delivery_grants\(/);
assert.match(source,/dispatchPrivateCommercialEpubGrant\(db,/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Commercial EPUB grant requires private legal authority\."\)/);
assert.match(gateway,/"delivery\.issue-epub-grant":\{path:"\/delivery\/private-issue-epub-grant"/);
assert.match(gateway,/case "delivery\.issue-epub-grant":/);
assert.match(owner,/if\(route==="\/delivery\/private-issue-epub-grant"\)/);
for(const token of ["readPaidAccess(sql,","marketIsWithdrawn(sql,x.territory)",
 "commercial_delivery_policies","source_name NOT IN ('gutenberg','upload')",
 "asset_versions av JOIN digital_assets da","risk_holds h JOIN commerce_order_items",
 "expiry-issued>Number(policy?.token_ttl_seconds||300)*1000",
 "x.maxUses>Number(policy?.token_max_uses||2)",
 "INSERT INTO commercial_delivery_grants(","e.status='active'"])
 assert.ok(owner.includes(token),"Private paid EPUB owner guard absent: "+token);
console.log("PASS: owner-verified commercial EPUB bearer grant, commercial EPUB issuance retired; production remains locked.");
