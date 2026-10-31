/* eslint-disable prettier/prettier -- Exact owner-retired publisher tax verification regression. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=x=>readFileSync(x,"utf8");
const src=read("src/features/fore/risk-tax.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const ln=JSON.parse(read("docs/architecture/retired-publisher-tax-status-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(ln.releaseApproval,false);
assert.equal(ln.productionCertified,false);
assert.equal(ln.sourceBefore,6);
assert.equal(ln.sourceAfter,5);
assert.equal(createHash("sha256").update(src).digest("hex"),ln.currentSha256);
assert.equal(ln.retired.length,1);
assert.equal(ln.retired[0].table,"publishing_accounts");
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=5);
assert.ok(!review.sites.some(x=>x.siteId===ln.retired[0].siteId));
const a=src.indexOf("export async function registerPublisherTaxVerification(");
const b=src.indexOf("\n}",a);
assert.ok(a>=0&&b>a);
assert.match(src.slice(a,b),/return dispatchPrivatePublisherTaxVerification\(db,raw\);/);
assert.doesNotMatch(src,/UPDATE publishing_accounts SET tax_status=/);
assert.doesNotMatch(src,/UPDATE publishing_tax_profiles SET status=/);
assert.doesNotMatch(src,/INSERT OR IGNORE INTO publisher_tax_verification_events/);
assert.match(gateway,/"risk\.publisher-tax-verification":\{path:"\/risk\/private-publisher-tax-verification"/);
assert.match(gateway,/case "risk\.publisher-tax-verification":/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Publisher tax verification requires private authority."\)/);
assert.match(owner,/if\(route==="\/risk\/private-publisher-tax-verification"\)/);
for(const guard of ["COVE_TAX_VERIFIER_URL","COVE_TAX_VERIFIER_TOKEN",
  "proof.accountId!==profile.account_id","verifiedAt<Date.now()-24*3600_000",
  "x.status===\"verified\"&&!previous","previous.status!==x.status",
  "UPDATE publishing_tax_profiles SET status=","UPDATE publishing_accounts SET tax_status=",
  "INSERT INTO publisher_tax_verification_events","await db.batch([",
  "profile.tax_status!==x.status"])
  assert.ok(owner.includes(guard),"Missing positive independent tax status guard: "+guard);
console.log("PASS: direct publisher tax-status writer retired (historical 6→5), positive provider proof and deny-first replay required, production locked.");
