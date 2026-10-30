# Retirement of shared checkout and monetary-administration D1 writers — 2026-10-30

This change physically removes **16** source-bound owner-command-required SQL mutations from `commerce.server.ts`: nine checkout-creation writes, two gift/store-credit reservations, one promotion reservation, one Stripe-customer identity upsert, and three monetary-admin mutations. The historical 56-site commerce inventory is now **40**; repository-wide owner-required findings move **359 → 343**, subject to independent CI verification. No disposition has been relaxed, and all remaining exact literals are rebound to the new source fingerprint.

## Safety and feature paths

- Non-enrolled production `createCheckoutPayment` rejects **before** reading payment state, creating orders, reserving tender or contacting Stripe. There is no shared-D1 fallback on a failed private owner RPC.
- Enrolled isolated-QA checkout retains quote freshness checks, idempotent owner materialization, fraud/rights denial, tender reservation, provider identity attachment, and Stripe TEST certification through `createStageOwnerCheckoutPayment`. The account customer upsert exclusively uses the private owner.
- The existing `/admin/commerce/{promo,gift-card,store-credit}` stage branch routes independently authorized and idempotent money commands to `executeStageOwnerMonetaryAdmin`. Shared non-enrolled admin functions now return 503, rather than mutating protected money tables.
- This is a **security-first disabled-state migration**. Production commerce remains unavailable until live Stripe secret/mode binding, private owner authority, writer-principal retirement, real payment/refund/revocation test, and rollback certification. Do **not** enable `COVE_RIGHTS_OWNER_ENABLED`, paid access or public routing from this change.

## Historical obligations and rollback

Previous read-only evidence from the production canonical D1 and Stripe live account found no production orders, paid entitlements, refunds or live PaymentIntents at the review instant; the snapshot is not a perpetual zero-data assertion. Retain readable historical order/invoice projections and never discard existing money records. Rollback is a source revert while the private owner is disabled; after any actual private-owner money settlement, reverting to shared-D1 writers is forbidden without an independently reconciled migration and explicit privilege cutover. The private owner SQL and replay/idempotency rules remain the only execution path in isolated QA.

Evidence is source-based and negative-only; it does not represent production owner certification or a successful deployed charge. The protected audit and owner TEST workflows must pass before merging.
