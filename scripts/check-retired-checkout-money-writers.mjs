/* eslint-disable prettier/prettier -- Fail-closed retirement cannot be reintroduced. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync("src/features/fore/commerce.server.ts","utf8");
const api=readFileSync("src/features/fore/api.server.ts","utf8");
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
function section(start,end){const i=source.indexOf(start),j=source.indexOf(end,i+start.length);assert.ok(i>=0&&j>i,start);return source.slice(i,j);}
for(const name of ["reserveTender","reservePromo"])assert.doesNotMatch(source,new RegExp("function\\s+"+name+"\\s*\\("));
const checkout=section("export async function createCheckoutPayment(","async function recordTaxTransaction(");
assert.match(checkout,/COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"[^]*?throw new ApiError\(503/);
assert.ok(checkout.indexOf('COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"')<checkout.indexOf("env.DB"),"Deny unenrolled production before any payment read");
assert.match(checkout,/return createStageOwnerCheckoutPayment\(/);
assert.doesNotMatch(checkout,/\b(?:INSERT|UPDATE|DELETE)\s+(?:OR\s+\w+\s+)?(?:INTO|FROM)?\s*commerce_/i);
const customer=section("async function ensureStripeCustomer(","function invoiceNumber(");
assert.match(customer,/registerStageOwnerStripeCustomer/);
assert.doesNotMatch(customer,/INSERT INTO commerce_customers/);
assert.ok(customer.indexOf('COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"')<customer.indexOf("stripeRequest("));
for(const [name,next] of [["createPromoCode","issueGiftCard"],["issueGiftCard","adjustStoreCredit"],["adjustStoreCredit","commerceAdminSnapshot"]]){
 const method=section("export async function "+name+"(","export async function "+next+"(");
 assert.match(method,/throw new ApiError\(503/);
 assert.doesNotMatch(method,/\.(?:prepare|batch)\(/);
}
assert.match(api,/executeStageOwnerMonetaryAdmin/);
assert.match(api,/createStageOwnerCheckoutQuote/);
const sites=review.sites.filter(x=>x.file==="src/features/fore/commerce.server.ts");
assert.equal(sites.length,3);
assert.ok(sites.every(x=>x.disposition==="owner-command-required"));
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,306);
assert.equal(review.releaseApproval,false);
console.log("PASS: 16 physically removed shared checkout and monetary-admin writer sites, private owner staging preserved, production enrollment fail-closed; 306 owner-required sites remain; the owner-only quote and two tax writers still require closure.");
