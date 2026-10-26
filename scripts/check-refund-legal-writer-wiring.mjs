import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
const writer=readFileSync("src/storefront-strangler/legal-quarantine-qa.writer.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const core=readFileSync("src/storefront-strangler/commercial-entitlement-core.ts","utf8");
const refund=commerce.slice(commerce.indexOf("async function applyRefundSuccess("),
  commerce.indexOf("export async function stripeWebhook("));
assert.ok(refund.length>3000,"Could not inspect refund webhook");
const revoke=refund.indexOf("if (full) await stageRevokeRefundEntitlements(");
const succeeded=refund.indexOf("UPDATE commerce_refunds SET status='succeeded'");
const canonical=refund.indexOf("UPDATE entitlements SET status='revoked'");
assert.ok(revoke>=0&&succeeded>revoke&&canonical>succeeded,
  "Full refund strong-owner denial must happen before financial acknowledgement and legacy grant revoke");
assert.match(refund,/if \(env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"\)\s+await db/);
assert.ok(commerce.includes('env.COVE_SSR_STAGING !== "1"')&&
  commerce.includes('env.COVE_CANONICAL_LEGAL_WRITE_LOCK !== "1"')&&
  commerce.includes('env.COVE_LEGAL_QUARANTINE_WRITER_STAGE !== "1"'),
  "Strong owner refund route must remain QA-only and require locked legacy legal writes");
assert.ok(writer.includes('const isRefundBatch=pathname==="/commercial/entitlement/revoke-order"'));
assert.ok(writer.includes('e.order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?)'));
assert.ok(writer.includes('ORDER BY e.id LIMIT 26'));
const writerBody=writer.slice(writer.indexOf("if(isRefundBatch){"),
  writer.indexOf("if(isEntitlement){"));
assert.ok(writerBody.indexOf("/commercial/entitlement/deny-batch")>=0&&
  writerBody.indexOf("/commercial/entitlement/deny-batch")<
  writerBody.indexOf("await env.PRIMARY_DB.batch("),
  "Owner receipt MUST come before canonical refund entitlement writes");
assert.ok(owner.includes('if(route==="/commercial/entitlement/deny-batch")'));
assert.ok(owner.includes("storage.transactionSync(()=>")||
  owner.includes("storage.transactionSync(() =>"));
assert.ok(core.includes("denyPaidEntitlementsBatch("));
console.log("PASS: full-refund Stripe webhook fails closed before financial acknowledgment; one bounded private owner denial before canonical buyer batch; no production activation");
