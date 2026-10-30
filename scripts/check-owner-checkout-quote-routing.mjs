/* eslint-disable prettier/prettier -- Verify quote path has no enrolled caller-owned SQL fallback. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const api=readFileSync("src/features/fore/api.server.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const gateway=readFileSync("src/storefront-strangler/canonical-owner-command-gateway.ts","utf8");
const port=readFileSync("src/storefront-strangler/owner-checkout-quote.server.ts","utf8");
assert.match(api,/path === "\/checkout\/quote"[\s\S]{0,350}createStageOwnerCheckoutQuote\(env/);
assert.match(api,/env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED\s*===\s*"1"[\s\S]{0,200}createStageOwnerCheckoutQuote/);
assert.match(owner,/route==="\/commercial\/checkout\/create-quote"[\s\S]{0,1800}checkoutQuote\(ownerEnv/);
assert.match(owner,/quote=await checkoutQuote\(ownerEnv,[\s\S]{0,1500}owner_checkout_quote_commit_unconfirmed/);
assert.match(gateway,/"commerce.create-quote":\{path:"\/commercial\/checkout\/create-quote"/);
assert.match(gateway,/case "commerce.create-quote":[\s\S]{0,1000}canonical_command_receipt_mismatch/);
assert.match(port,/QA_IDS\.has\(env\.COVE_LEGAL_WRITER_PRIMARY_ID/);
assert.match(port,/COVE_CANONICAL_LEGAL_WRITE_LOCK/);
assert.match(port,/throw new ApiError\(503,"Canonical checkout quote could not be verified or persisted/);
assert.doesNotMatch(port,/env\.DB\s*\.\s*prepare|env\.DB\s*\.\s*batch/);
console.log("PASS: owner-enrolled checkout quote, tax and billing evidence have one QA owner path; production legacy untouched.");
