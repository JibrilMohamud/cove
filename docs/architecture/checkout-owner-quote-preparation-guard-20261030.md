# Owner checkout: immutable monetary preparation boundary (2026-10-30)

**Scope:** Real owner-side handler hardening, not SQL writer retirement or a production cutover.

The private checkout draft previously verified the canonical quote only at creation. The next
private preparation command accepted the already-created order and *current* quote independently,
without comparing their persisted pricing, tax, tender allocation, currency, buyer, or territory.
A quote changed between these operations could authorize different reservation terms than those
attached to the committed order. The fix rejects mismatched canonical values **before** fraud
assessment, any gift/store/promo reservation, quote consumption, or Stripe PaymentIntent request.

The owner compares the persisted order and quote, rather than trusting a caller-provided
amount, cart fingerprint, or approval bit. Exact native SQLite schema integration tests mutate
seven canonical quote fields after creating the order and independently verify that each
prepare request returns 409 without any partial financial or fraud writes. Existing loss-of-ACK,
idempotent retry, durable order denial, transaction rollback, and disabled-production-owner
tests remain mandatory.

## Release and recovery

This guard is deny-only. A mismatched quote is not repaired in-place: the customer must
recalculate checkout with a newly validated quote after any previous draft is safely canceled
through an owner-controlled command. If a deployment must be rolled back, restore the previous
version *only behind the disabled private owner and blocked production paid-access gate*;
do not turn on legacy direct D1 writes or permit existing mismatched quotes to be paid.

**Not yet resolved:** The separately reviewed source audit remains at 371 owner-required SQL
sites (426 candidates). The shared production checkout/refund/webhook writers are not retired
by this change. Production legal owner enablement and public paid routing remain prohibited
until independently verified end-to-end business behavior, owner-only SQL privilege fencing,
outage/idempotency/recovery, signed Stripe events, and deployed rollback are certified.
