/* eslint-disable prettier/prettier -- Deny-first refund ordering and exact gated route are auditable invariants. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
const writer=readFileSync("src/storefront-strangler/legal-quarantine-qa.writer.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const core=readFileSync("src/storefront-strangler/commercial-entitlement-core.ts","utf8");
const refund=commerce.slice(commerce.indexOf("async function applyRefundSuccess("),
  commerce.indexOf("export async function stripeWebhook("));
assert.ok(refund.length>3000,"Could not inspect refund webhook");
const webhookRefund=commerce.slice(
  commerce.indexOf('type === "refund.updated" || type === "refund.created"'),
  commerce.indexOf('type.startsWith("charge.dispute.")'));
assert.ok(webhookRefund.includes('if (obj.status === "succeeded") {') &&
  webhookRefund.includes('await applyRefundSuccess(env, r.id, obj);'),
  "Signed Stripe refund success must be reconciled owner-first");
assert.ok(!webhookRefund.includes('UPDATE commerce_refunds SET status=?,updated_at=? WHERE id=?")'),
  "Webhook must never publish unowned provider success to canonical ledger");
assert.ok(commerce.includes('refund.status === "succeeded" ? "pending" : refund.status'),
  "Initial provider success is pending until durable owner and ledger acknowledgment");
assert.ok(commerce.includes('provider.status === "succeeded" ? "pending" : provider.status'),
  "Recovered provider success is pending until durable owner and ledger acknowledgment");
const revoke=refund.indexOf('if (full || env.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1")');
assert.ok(refund.includes("await stageRevokeRefundEntitlements(env, String(o.id), refundId)"),
  "Staged external partial refunds must conservatively deny the whole buyer order");
const refundRequest=commerce.slice(commerce.indexOf("export async function refundOrder("),
  commerce.indexOf("async function stageRevokeRefundEntitlements("));
assert.ok(refundRequest.includes("Partial refunds require an item-scoped legal owner."),
  "Customer partial refunds cannot bypass an unfinished item-scoped strong legal writer");
assert.ok(refundRequest.includes("await resumePersistedRefund(env, existing)"),
  "Repeat refund requests must reprocess owner-pending provider acknowledgments");
assert.ok(refundRequest.includes("providerAccepted = true;")&&
  refundRequest.includes("!providerAccepted && e instanceof ApiError && e.status === 400"),
  "Confirmed Stripe refunds must never be mislabeled failed after legal-owner outage");
assert.ok(refundRequest.includes("original Stripe")||
  commerce.includes("repeat ONLY the same POST"),
  "External provider refund recovery must preserve the immutable idempotency key");
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
assert.ok(writer.includes("order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?)"));
assert.ok(writer.includes("entitlement_type='purchase' AND status='active'"),
  "Reconcile only live purchase entitlements belonging to the order");
const writerBody=writer.slice(writer.indexOf("if(isRefundBatch){"),
  writer.indexOf("if(isEntitlement){"));
const denial=writerBody.indexOf("/commercial/order/deny-next");
const receipt=writerBody.indexOf("orderReceipt.applied");
const update=writerBody.indexOf("UPDATE entitlements SET status='revoked'");
assert.ok(denial>=0 && receipt>denial && update>receipt,
  "Durable order-wide denial and verified receipt MUST precede canonical entitlement writes");
const reconciliation=writerBody.indexOf("await env.PRIMARY_DB.prepare(", receipt);
assert.ok(reconciliation>receipt && reconciliation<update,
  "Canonical D1 entitlement UPDATE must start only after the owner's verified receipt");
assert.ok(!writerBody.includes("/commercial/entitlement/deny-batch"),
  "Whole-order refund cannot be truncated by a 25-item owner batch");
assert.ok(owner.includes('if(route==="/commercial/entitlement/deny-batch")'));
assert.ok(owner.includes("storage.transactionSync(()=>")||
  owner.includes("storage.transactionSync(() =>"));
assert.ok(core.includes("denyPaidEntitlementsBatch("));
const chargeback=commerce.slice(commerce.indexOf("async function syncDispute("),
  commerce.indexOf("export async function ",commerce.indexOf("async function syncDispute(")));
assert.ok(chargeback.length>1000,"Chargeback webhook implementation could not be inspected");
const stageRefund=commerce.slice(commerce.indexOf("async function stageRevokeRefundEntitlements("),
  commerce.indexOf("async function applyRefundSuccess("));
assert.ok(stageRefund.includes('"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87"')&&
  stageRefund.includes('"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"'),
  "The existing and complete canonical paid QA D1 are the only permitted staged refund sources");
assert.ok(!stageRefund.includes('"4bd657ac-8789-403e-a28c-93aba8d0a989"')&&
  !stageRefund.includes('"e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"'),
  "Never invoke the QA refund writer on production or hosted-capacity canonical DB");
assert.ok(commerce.includes('await syncDispute(env, obj, type)'),
  "Dispute handler must receive the same legal-owner env as refund handler");
const chargebackDenial=chargeback.indexOf("await stageRevokeRefundEntitlements(");
const openFreeze=chargeback.indexOf("const stageDisputeOpened =");
const lostFreeze=chargeback.indexOf('const confirmedLoss = eventType === "charge.dispute.closed"');
assert.ok(openFreeze>=0&&lostFreeze>openFreeze&&chargebackDenial>lostFreeze,
  "Fenced stage must also revoke access at dispute creation, not merely on chargeback loss");
assert.ok(chargeback.includes('(stageDisputeOpened ? "dispute-open:" : "dispute-loss:") + d.id'),
  "Stripe dispute revocation operation must use an immutable, replay-safe dispute event identity");
const disputeWrite=chargeback.indexOf("INSERT INTO commerce_disputes");
const lostEntitlement=chargeback.indexOf("UPDATE entitlements SET status='revoked'");
assert.ok(chargebackDenial>=0 && disputeWrite>chargebackDenial &&
  lostEntitlement>disputeWrite,
  "Lost dispute must durably fence the whole paid order BEFORE canonical dispute or entitlement mutation");
assert.match(chargeback,/if \(env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"\)\s+await db/,
  "The owner-controlled stage writer, not legacy webhook, reconciles revoked entitlements");
console.log("PASS: refund and chargeback owner-first webhook fencing, replay-safe whole-order denial, canonical mutation strictly afterwards");
