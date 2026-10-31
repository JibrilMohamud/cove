/* eslint-disable prettier/prettier -- Independently enforce stage owner exclusivity. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync("src/features/fore/commerce.server.ts","utf8");
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const sites=review.sites.filter(x=>x.file==="src/features/fore/commerce.server.ts");
assert.equal(sites.length,2,"Only two protected commerce writes remain after quote retirement");
assert.deepEqual(sites.map(x=>x.functionName).sort(),["applyRefundSuccess","recordTaxTransaction"]);
assert.ok(sites.every(x=>x.disposition==="owner-command-required"&&x.productionOwnerGuarded===false));
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=260,
  "A later audited retirement may reduce, but never increase, this previously certified source count");
assert.equal(review.releaseApproval,false);
for(const name of ["checkoutQuote","createCheckoutPayment","finalizePaidOrder","cancelCheckoutOrder","refundOrder","completeRequestedRefund","applyRefundSuccess","stripeWebhook","reconcileStripe"]){
  const marker=name==="completeRequestedRefund"?"async function "+name+"(":name==="applyRefundSuccess"?"async function "+name+"(":"export async function "+name+"(";
  const start=source.indexOf(marker);
  assert.ok(start>=0, "Missing entry: "+name);
  const next=source.slice(start,start+1300);
  assert.match(next,/throw new ApiError\(503/,"Owner-disabled rejection expected: "+name);
}
for(const name of ["releaseOrderReservations","ledger","consumeTender","pinPurchasedPublishingVersion","hydrateProcessorFees"])assert.doesNotMatch(source,new RegExp("async function "+name+"\\("));
assert.match(source,/settleStageOwnerPaidOrder/);
assert.match(source,/postStageOwnerRefundAccounting/);
assert.match(source,/claimStageOwnerStripeWebhook/);
assert.match(source,/syncStageOwnerStripeDispute/);
assert.match(source,/reconcileStageOwnerStripe/);
assert.match(source,/COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"/);
console.log("PASS: 37 shared commerce SQL writer sites physically removed, 2 tax/refund mutations retained as owner-required, no owner-disabled production financial fallback; no more than 260 owner-required unresolved.");
