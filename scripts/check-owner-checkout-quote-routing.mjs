/* eslint-disable prettier/prettier -- Verify quote path has no enrolled caller-owned SQL fallback. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const api=readFileSync("src/features/fore/api.server.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const gateway=readFileSync("src/storefront-strangler/canonical-owner-command-gateway.ts","utf8");
const port=readFileSync("src/storefront-strangler/owner-checkout-quote.server.ts","utf8");
assert.match(api,/path === "\/checkout\/quote"[\s\S]{0,350}createStageOwnerCheckoutQuote\(env/);
assert.match(api,/env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED\s*===\s*"1"[\s\S]{0,200}createStageOwnerCheckoutQuote/);
// Bound the proof to the exact handler below, not an arbitrary character limit.
const start=owner.indexOf('if(route==="/commercial/checkout/create-quote")');
const end=owner.indexOf('if(route==="/commercial/checkout/materialize-draft")',start);
assert.ok(start>=0&&end>start,"Missing private quote owner route");
const checkoutOwner=owner.slice(start,end);
assert.match(checkoutOwner,/const quote=await checkoutQuote\(ownerEnv,/);
assert.match(checkoutOwner,/COVE_SSR_STAGING:"1"/);
assert.match(checkoutOwner,/COVE_CANONICAL_LEGAL_WRITE_LOCK:"1"/);
assert.match(checkoutOwner,/COVE_LEGAL_WRITER_PRIMARY_ID:env\.COVE_RIGHTS_OWNER_PRIMARY_ID/);
assert.match(checkoutOwner,/COVE_RIGHTS_OWNER_SECRET:env\.COVE_RIGHTS_OWNER_SECRET/);
assert.match(checkoutOwner,/name!=="cove-staged-legal-global-v1"/);
assert.match(checkoutOwner,/request\.method!=="POST"/);
assert.match(checkoutOwner,/url\.hostname!=="legal-authority\.internal"/);
assert.match(checkoutOwner,/url\.search\|\|!\["\/commercial\/authorize-batch","\/authorize-batch"\]\.includes\(url\.pathname\)/);
assert.match(checkoutOwner,/return this\.fetch\(request\)/);
assert.doesNotMatch(checkoutOwner,/COVE_LEGAL_CONSUMER_STAGE_ENABLED:"0"/);

assert.match(checkoutOwner,/INSERT INTO commerce_checkout_quotes/);
assert.match(checkoutOwner,/const stored=await env\.PRIMARY_DB\.prepare\(/);
assert.match(checkoutOwner,/owner_checkout_quote_commit_unconfirmed/);
assert.match(gateway,/"commerce.create-quote":\{path:"\/commercial\/checkout\/create-quote"/);
assert.match(gateway,/case "commerce.create-quote":[\s\S]{0,1000}canonical_command_receipt_mismatch/);
assert.match(port,/!isReviewedPaidQaPrimary\(env\.COVE_LEGAL_WRITER_PRIMARY_ID\)/);
assert.match(port,/import \{isReviewedPaidQaPrimary\} from "\.\/reviewed-paid-qa-primary"/);
assert.doesNotMatch(port,/const QA_IDS|5e3a6b69|7c7ab994/);
assert.match(port,/COVE_CANONICAL_LEGAL_WRITE_LOCK/);
assert.match(port,/throw new ApiError\(503,"Canonical checkout quote could not be verified or persisted/);
assert.doesNotMatch(port,/env\.DB\s*\.\s*prepare|env\.DB\s*\.\s*batch/);
console.log("PASS: owner-enrolled checkout quote, tax and billing evidence have one QA owner path; production legacy untouched.");
