# Commerce dispute owner-path migration — independent source review (2026-10-30)

## What was actually changed

The signed Stripe webhook previously entered `syncDispute` and, even when the
isolated QA owner was enrolled, issued direct `commerce_disputes`,
`commerce_orders`, `commerce_ledger_entries`, entitlement and royalty D1
writes from the API worker. This provided an alternate finance and permission
writer despite the private negative owner tombstone. The enrolled branch now
returns **before any old SQL**, after a fixed typed private command has
completed; a failed owner command returns HTTP 503, with no caller-owned D1
fallback. The traditional production (non-enrolled) path is unchanged.

The owner validates the command schema and authenticated QA lease, then
independently GETs Stripe's dispute from its own API key, validating immutable
dispute ID, charge ID, Stripe livemode, currency, amount, status and the
canonical Stripe charge/order relationship. The owner durably denies every
linked purchase **before** any canonical D1 mutation. Its single D1 batch
atomically verifies immutable prior dispute identity, upserts the journal,
records terminal loss or denied dispute order status, revokes online licenses,
EPUB and audio grants, and posts balanced opening and terminal dispute
ledger entries with deterministic unique identifiers. It reads back the
journal and each posted ledger amount before returning a success receipt.
A chargeback loss then reverses accrued royalties inside the owner, with
replay-safe reconciliation after an interrupted posting. A bank win never
automatically revives old purchaser access.

## Independent audit and retained findings

Only one previously reviewed source writer file changes:
`src/features/fore/commerce.server.ts`. The injected staged-owner branch
is at the beginning of `syncDispute`, before the legacy SQL call graph.
All **56 original commerce SQL mutation literals are retained**, byte-for-byte.
Every disposition, command family, table and SQL digest remains unchanged,
`productionOwnerGuarded=false` remains unchanged and no production SQL
retirement is claimed. The original 371 owner-required of 426 reviewed source
candidates therefore remains the release-blocking count. The original
source-bound site IDs and line numbers must be rebased against the complete
source SHA after manual review; this document does not certify the new
source as production-owned.

## Verification and rollback

The real bundled private owner suite uses the complete canonical D1 migration
schema, commits its SQL batches transactionally, and independently exercises
Stripe provider identity/livemode/amount/currency failures, durable denial,
balanced opening/lost financial posting, exact replay and a lost D1
acknowledgement after commit. The protected source audit, typecheck, security,
owner lock and browser tests must pass before merging.

Production paid access and production owner leases remain locked. No Cloudflare
D1 binding is removed and no customer production routes are switched. The
non-enrolled legacy dispute handler remains available as the compatibility
rollback; activating the QA mode only against its segregated synthetic database
must never be confused with authorization to enable live Stripe payments.
A production cutover still requires a separately deployed owner, live provider
provenance and webhook receipt certification, transitive writer retirement,
negative/positive paid-media verification, and independently rehearsed rollback.
