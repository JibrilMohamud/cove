/* eslint-disable prettier/prettier -- Source-bound private market owner migration regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/localization.server.ts");
const api=read("src/features/fore/api.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-private-market-admin-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.releaseApproval,false);
assert.equal(lineage.productionCertified,false);
assert.equal(lineage.sourceBefore,16);
assert.equal(lineage.sourceAfter,15);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.sourceSha256);
assert.equal(createHash("sha256").update(api).digest("hex"),lineage.apiSha256);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=15);
assert.equal(lineage.retired.length,1);
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
assert.doesNotMatch(source,/INSERT INTO storefront_markets\(/);
assert.match(source,/dispatchPrivateMarketUpsert/);
assert.match(api,/upsertMarket\(db, staff\.userId, input, who\)/);
assert.match(gateway,/"market\.admin-upsert":\{path:"\/market\/private-admin-upsert"/);
assert.match(gateway,/case "market\.admin-upsert":/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Market update requires private legal authority\."\)/);
assert.match(owner,/if\(route==="\/market\/private-admin-upsert"\)/);
for(const token of ["staff_principals","staff_principal_roles","staff_role_permissions",
 "marketIsWithdrawn(sql,m.countryCode)","denyMarket(sql,","mfa_required",
 "prior.market_status!==\"active\"","db.batch(["])
 assert.ok(owner.includes(token),"Owner verification missing: "+token);
assert.doesNotMatch(owner,/if\(route==="\/market\/private-admin-upsert"\)[\s\S]*?return Response\.json\([\s\S]*?releaseApproval:true/);
console.log("PASS: market mutator removed from shared caller, independent staff/market verification and deny-first owner; 15 owner-required sites remain; production locked.");
