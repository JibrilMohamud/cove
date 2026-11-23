# Preorder writer retirement — 15 source sites, QA ONLY

This review **moves** the protected preorder writer bodies and their event helper from `preorder.server.ts` into an unexported implementation enclosed in `legal-authority.worker.ts`. The shared server exports keep the same call signatures but now make fixed private-owner RPC calls; there is no generic SQL command and no fallback to public D1. The private route rejects unauthorized/nonleased requests and parses strict per-action command payloads before running against a separately bound QA D1.

Source-audit owner-required counts: **209 → 194**, with 15 original site IDs and SQL digests preserved in `retired-preorder-owner-lineage.json`.

**Invariants intentionally fail-closed:** paid preorder registration requires independently verified Stripe settlement; release entitlement and immutable owner-version grant pinning are blocked until an independently verified legal grant/payment proof can be published under a strong owner epoch; and provider refund-success receipt cannot originate from the caller-provided job flag. `advancePreorders` preflights all due paid lines before any state changes, so it cannot partially release a paid buyer on an unavailable authority proof. Negative cancellation/retry and QA scheduling have owner-controlled, source-equivalent paths; they are **not** a production-certified replacement.

This is stacked on draft PR #498 and draft PR #497. **Do not merge or deploy into production.** Customer checkout/preorder/return flows can remain unavailable until stronger certification. Real production D1 privilege retirement, paid legal positive attestation, live Stripe refund/payment evidence, credential/ownership locks, and protected rollback are still open. `releaseApproval` remains false.
