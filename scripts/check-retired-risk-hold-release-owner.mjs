/* eslint-disable prettier/prettier -- Source- and authorization-bound release regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/risk-tax.server.ts");
const api=read("src/features/fore/api.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-risk-hold-release-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.productionCertified,false);
assert.equal(lineage.releaseApproval,false);
assert.equal(lineage.sourceBefore,14);
assert.equal(lineage.sourceAfter,13);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.currentSha256);
assert.equal(createHash("sha256").update(api).digest("hex"),lineage.apiSha256);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,13);
assert.equal(lineage.retired.length,1);
assert.equal(lineage.retired[0].table,"risk_holds");
assert.ok(!review.sites.some(x=>x.siteId===lineage.retired[0].siteId));
assert.doesNotMatch(source,/UPDATE risk_holds SET status='released'/);
assert.match(source,/dispatchPrivateRiskHoldRelease/);
assert.match(api,/releaseRiskHold\(db, staff\.userId, await body\(request\), who\)/);
assert.match(gateway,/"risk\.release-hold":\{path:"\/risk\/private-release-hold"/);
assert.match(gateway,/case "risk\.release-hold":/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Risk release requires private legal authority\."\)/);
assert.match(owner,/if\(route==="\/risk\/private-release-hold"\)/);
for(const check of ["staff_principals","staff_principal_roles","staff_role_permissions",
  "risk.hold.manage","mfa_required","assessPayoutRisk(db,hold.subject_id)",
  "a.status='held'","pa.tax_status='verified'","pa.payout_status='verified'",
  "status='active'","hold.status!=='active'","id=? AND status='active'",
  "payout_items SET status='pending'"])
 assert.ok(owner.includes(check),"Owner-side risk release proof missing: "+check);
console.log("PASS: private risk-release owner and 13 exact source audit findings; production remains disabled.");
