/* eslint-disable prettier/prettier -- Immutable exact-source protected consumption retirement guard. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=x=>readFileSync(x,"utf8");
const source=read("src/features/fore/delivery.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const ln=JSON.parse(read("docs/architecture/retired-epub-consumption-owner-lineage.json"));
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
assert.equal(ln.releaseApproval,false);
assert.equal(ln.productionCertified,false);
assert.equal(review.releaseApproval,false);
assert.equal(ln.sourceBefore,10);
assert.equal(ln.sourceAfter,8);
assert.equal(createHash("sha256").update(source).digest("hex"),ln.currentSha256);
assert.equal(ln.retired.length,2);
assert.ok(ln.retired.every(x=>x.disposition==="owner-command-required"));
assert.ok(ln.retired.every(x=>!review.sites.some(site=>site.siteId===x.siteId)));
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=8);
assert.doesNotMatch(source,/INSERT INTO commercial_entitlement_delivery_usage\(/);
assert.doesNotMatch(source,/UPDATE commercial_delivery_grants SET uses=uses\+1/);
assert.match(source,/await dispatchPrivateCommercialEpubConsumption\(db,/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Commercial EPUB consumption requires private authority."\)/);
assert.match(gateway,/"delivery\.consume-epub-grant":\{path:"\/delivery\/private-consume-epub-grant"/);
assert.match(gateway,/case "delivery\.consume-epub-grant":/);
assert.match(owner,/if\(route==="\/delivery\/private-consume-epub-grant"\)/);
for(const v of ["readPaidAccess(sql,","marketIsWithdrawn(sql,x.territory)",
  "commercial_delivery_policies","commercial_entitlement_delivery_usage",
  "entitlements e ON e.id=g.entitlement_id","token_hash=?","risk_holds h JOIN",
  "asset_versions av JOIN digital_assets","await db.batch(statements)"])
  assert.ok(owner.includes(v),"Paid consumption guard missing: "+v);
console.log("PASS: two protected commercial EPUB consumption writers retired, no further protected shared EPUB writes, production blocked.");
