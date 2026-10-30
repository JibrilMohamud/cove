# Owner-independent Stripe refund proof (2026-10-30)

## Scope and production status

This change hardens the **existing private, QA-leased canonical refund provider writer**.
It does **not** switch production payment/refund/webhook callers, retire a legacy
production D1 writer, reclassify SQL, enable production legal authority, remove
external D1 credentials, or authorize paid delivery. The conservative source
review remains **371 owner-command-required SQL sites of 426 candidates**.

## Owner-controlled evidence

The owner previously trusted the private adapter's forwarded refund status,
which was backed by either the caller's Stripe API response or HMAC-checked
webhook. Before writing canonical refund provider identity or status, the
separately authenticated private legal owner now independently fetches the
exact Stripe Refund using its **own** private Stripe credential:

- Fixed HTTPS Stripe /v1/refunds/{id} endpoint only; the caller chooses no URL,
  no key, no arbitrary SQL, no redirects, and no alternate provider.
- Exact Stripe object, refund ID, original PaymentIntent ID, amount, currency,
  livemode, and originating order/refund metadata must match the already
  checked canonical refund and order. Credential and fetch failures deny writes.
- Only Stripe's **currently fetched status** is authoritative. A caller cannot
  assert succeeded when Stripe disagrees. Stale pending events cannot
  downgrade a previously confirmed succeeded state.
- The pre-existing Durable Object whole-order denial must be committed before
  fetching provider evidence or mutating primary D1; the existing canonical
  conditional write and persisted readback protect idempotency and collisions.

The original payment-refund operation writes fore_order_id and fore_refund_id
into Stripe Refund metadata. A Stripe-originated refund lacking those exact
origin fields is intentionally **not** automatically reconciled by this
owner command: it needs a separately reviewed provider-only recovery workflow.
This is preferable to accidentally authorizing an unrelated refund.

## Test and rollback

The real bundled owner handler suite now mocks the fixed Stripe endpoint
and tests current/forged provider responses, object/metadata/PI/amount/currency
mismatch, livemode, missing key, owner veto, replay, stale webhook, network
and canonical D1 failures. Execute the protected paid legal owner CI suite,
canonical writer reconciliation, security, typecheck and browser gates before
merging.

Rollback of the module must never imply refund completion; the owner should
remain disabled in production and private QA disabled until its verified
path is available. No previous negative owner tombstone is automatically
lifted by rollback. Before any production cutover: prove live Stripe signed
event/request provenance and dashboard-initiated exceptions, owner-only
production principal access, each commerce API/webhook/cron/admin writer,
idempotent Stripe retry after lost response, independent grant/revoke/media,
and an actual deployed rollback rehearsal.
