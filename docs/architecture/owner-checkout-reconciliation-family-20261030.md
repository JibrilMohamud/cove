# Owner-executed checkout cancellation and complete scheduled reconciliation family

Scope: isolated staging checkout and scheduler when the private QA legal-owner lease
is explicitly enrolled. No production-only authorization is asserted.

## Previous alternate commerce writers

The scheduled `reconcileStripe` handler used caller-owned production-compatible
D1 for `commerce_reconciliation_runs`, cancellation order status and reserved
tender/promotion releases, payment processor fees, receipt amendments and
royalties. Customer `cancelCheckoutOrder` also released reservations and
updated order state directly, even when the owner checkout stage flag was set.
The owner-first settlement handler had already migrated the paid side, but the
scheduler still had a protected legacy fallback.

## New enrolled path

* All enrolled scheduled runs branch **before** legacy `reconcileStripe` SQL.
  Owner settlement recovery runs first. Each Stripe PI is read with the
  server's credential; a newly settled order uses the independently
  Stripe-and-rights-verified owner settlement. Stale incomplete checkouts
  use the same private cancellation RPC as the customer checkout API.
* The private cancellation RPC independently GETs the exact Stripe PI with
  the owner-only Stripe key, and requires a canceled provider state,
  exact metadata order identity, currency, amount, livemode and customer
  reference before touching canonical D1. A checkout with no attached PI
  is cancelable only while still in an unpaid state.
* A single atomic primary D1 batch cancels a still-unpaid order and releases
  reserved gift/store-credit and promotion claims. Every release requires
  a canonical order that is actually canceled, protecting settled tender
  from concurrent stale cancellation events. Replayed and lost-ACK calls
  verify the final canonical status and zero remaining reservations.
* Completed reconciliation diagnostics are written by the owner via a
  fixed command schema; it verifies exact replay consistency, bounded
  amounts and fields. Reports are diagnostics, never legal permissions,
  provider-payment evidence, or authorization to refund/settle.
* Owner refusal, provider outage, malformed response, changed Stripe state
  or canonical write failure produces a non-success status and **no
  enrolled legacy D1 fallback**.

## Unchanged, independently reviewable blockers

All 56 original commerce SQL statements, SQL digests, dispositions and
command families remain in the legacy unenrolled production path; their
source SHA/site IDs are rebased without changing their meaning. The verified
audit baseline remains 371 owner-required sites of 426 reviewed. No production
privileges or routes were retired. Production legal-owner
`COVE_RIGHTS_OWNER_ENABLED=0` stays unchanged. Neither the owner QA
lease nor its two synthetic D1 IDs can authorize production.

The complete 56-site production retirement still requires migrating the
remaining API/webhook/admin writer families, live Stripe and media positive/
negative end-to-end certification, removing non-owner canonical D1
capabilities, and a real deployed rollback rehearsal. A source-count
reduction without those proofs is not production owner-first certification.

## Tests and rollback

The existing all-migrations SQLite private-owner suite now exercises exact
Stripe canceled/processing state and forged amount/livemode; no-PI customer
cancellation, reserved tender and promotion release, lost-ACK idempotence,
post-payment cancellation denial, run-report idempotence and changed-replay
rejection. Production-id mutation remains fail-closed. Production's
non-enrolled legacy branch is left intact for a later approved, separately
verified cutover/rollback. Every protected CI gate must pass before merge.
