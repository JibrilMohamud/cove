/* eslint-disable prettier/prettier -- Owner-only quote normalization safety regression. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(join(tmpdir(),"cove-owner-checkout-draft-"));
try {
  const entry="src/storefront-strangler/checkout-draft-owner-plan.ts";
  const out=join(temp,"checkout-draft.mjs");
  await build({entryPoints:[entry],outfile:out,bundle:true,platform:"node",
    target:"node22",format:"esm",logLevel:"silent"});
  const {planOwnerCheckoutDraft,checkoutDraftCommand}=await import(pathToFileURL(out).href);
  const now="2026-10-30T05:00:00.000Z";
  const command={
    userId:"buyer_original_20261030",quoteId:"quote_original_20261030",
    idempotencyKey:"checkout:original:20261030:1",
    cartFingerprint:"sha256:independent_reprice_fingerprint_value",
    captureMethod:"automatic_async"
  };
  const line=(id,amount,discount,tax)=>({
    productId:id,offerId:"offer_"+id,title:"Original test title",
    amountMinor:amount,discountMinor:discount,taxMinor:tax,taxBehavior:"exclusive",
    rightsSnapshot:{salesChannel:"retail",territory:"US"},
    publisherDiscountFundingMinor:0,foreDiscountFundingMinor:discount
  });
  const items=[line("prd_original_001",499,50,36),line("prd_original_002",399,0,28)];
  const quote={
    id:command.quoteId,user_id:command.userId,cart_fingerprint:command.cartFingerprint,
    currency:"USD",territory_code:"US",
    expires_at:"2026-10-30T05:30:00.000Z",consumed_at:null,
    items_json:JSON.stringify(items),subtotal_minor:898,promo_discount_minor:50,
    tax_minor:64,tax_inclusive_minor:0,gift_card_minor:100,
    store_credit_minor:112,total_minor:912,stripe_due_minor:700,
    billing_address_json:"{}",stripe_tax_calculation_id:null,
    promo_code_hash:"a1",gift_card_hash:"b2"
  };
  let counter=0;
  const makeId=()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,"0")}`;
  const plan=planOwnerCheckoutDraft(command,quote,now,makeId);
  assert.equal(plan.orderId,"ord_00000000-0000-4000-8000-000000000003");
  assert.equal(plan.lines.length,2);
  assert.equal(plan.lines.reduce((n,l)=>n+l.totalMinor,0),912);
  assert.equal(plan.lines[0].totalMinor,485);
  assert.equal(plan.lines[1].totalMinor,427);
  assert.equal(plan.lines[0].rightsSnapshotJson,JSON.stringify(items[0].rightsSnapshot));
  assert.equal(plan.quote.stripe_due_minor,700);
  assert.ok(plan.invoice.startsWith("FORE-202610-"));
  const deny=(c,q,pattern)=>assert.throws(
    ()=>planOwnerCheckoutDraft(c,q,now,makeId),pattern);
  deny({...command,userId:"other_buyer_original_2026"},quote,/quote_stale/);
  deny({...command,cartFingerprint:"sha256:changed_cart_fingerprint"},quote,/quote_stale/);
  deny(command,{...quote,consumed_at:now},/quote_stale/);
  deny(command,{...quote,expires_at:now},/quote_stale/);
  deny(command,{...quote,stripe_due_minor:701},/money_mismatch/);
  deny(command,{...quote,promo_discount_minor:51},/money_mismatch/);
  deny(command,{...quote,gift_card_hash:null},/money_mismatch/);
  deny(command,{...quote,items_json:JSON.stringify([...items,items[0]])},/duplicate_product/);
  deny(command,{...quote,items_json:JSON.stringify(items.map(x=>({...x,
    rightsSnapshot:{salesChannel:"subscription"}})))},/nonretail_scope/);
  deny({...command,orderId:"ord_forged"},quote,/unrecognized_key|Unrecognized key/i);
  assert.equal(checkoutDraftCommand.safeParse({...command,sql:"DROP TABLE x"}).success,false);
  deny(command,{...quote,items_json:JSON.stringify(items.map(x=>({...x,
    foreDiscountFundingMinor:0})))},/discount_allocation/);
  const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
  assert.ok(owner.includes('if(route==="/commercial/checkout/materialize-draft")'));
  const start=owner.indexOf('if(route==="/commercial/checkout/materialize-draft")');
  const end=owner.indexOf('if(route==="/commercial/checkout/register-stripe-customer")',start);
  assert.ok(end>start);
  const code=owner.slice(start,end);
  assert.match(code,/await db\.batch\(statements\)/);
  assert.match(code,/INSERT INTO commerce_orders/);
  assert.match(code,/INSERT INTO commerce_order_items/);
  assert.doesNotMatch(code,/commerce_settlement_receipts|entitlements|Stripe\.com|payment_intents\//);
  assert.match(code,/riskAssessed:false/);
  assert.match(code,/tenderReserved:false/);
  assert.match(code,/paymentAuthorized:false/);
  const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
  assert.equal(review.releaseApproval,false);
  const open=review.sites.filter(s=>s.disposition==="owner-command-required").length;
  assert.ok(open>0&&open<=371,
    "A genuine source retirement may lower open counts; this QA checkout draft cannot approve production");
  console.log("PASS: owner checkout draft canonical quote totals, strict scope, expiry, idempotency identity, private atomic order+lines only; "+open+" owner-required sites and production denial preserved");
}finally{rmSync(temp,{recursive:true,force:true});}
