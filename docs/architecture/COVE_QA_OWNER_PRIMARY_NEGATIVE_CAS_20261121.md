# Cove: owner-first negative primary-D1 generation CAS (isolated QA)

**Release state: NO-GO. Source-only prototype; no deployment, no primary migration.**

## Problem and enforceable boundary

Cove's strongly consistent legal-owner Durable Object can acknowledge an
immediate withdrawal while its corresponding primary-D1 transaction remains
in-flight or fails. A D1-only rights/offer projection can then be stale.
PR #805 added an independent owner-current read bracket. This PR adds a
**negative-only atomic D1 publication operation** to advance the owner epoch
under a single SQL compare-and-swap, without giving a catalog reader the
ability to publish its own positive authorization.

The current QA owner journal's receipt explicitly says `authorizing:false`.
It is a durable **negative invalidation witness**, not an approval to
publish books, settlements, entitlements or commerce. Any attempt to use that
receipt to reopen `dirty=0` would be unsafe and is not implemented.

## Source and SQL

- `src/storefront-strangler/owner-primary-denial-publication.stage.ts`
  obtains the existing QA owner journal epoch using a fresh private
  challenge-bound `/qa/current-mutation-fence` request. It accepts only one
  of two isolated QA D1 UUIDs, a fixed journal version and a private owner
  binding. The caller cannot supply the epoch, operation type, SQL or route.
- A **fresh first-primary D1 session** reads the sealed publication row,
  then a **different first-primary session** runs a *single* parameterized
  `UPDATE ... WHERE owner_mutation_epoch=? AND publication_revision=?`
  statement with `RETURNING`. Both epoch and publication revision advance
  monotonically. The update exclusively sets `dirty=1`, increments
  `pending_withdrawals`, and sets `eligibility_valid_until_ms=0`.
  It cannot mark a product or projection eligible.
- After the D1 CAS, another fresh primary read and **another independent
  private owner challenge** must still match. Lost races, invalid or stale
  owner receipts, repaired/rolled-back D1 reads and malformed record
  schemas fail closed. An equal epoch only acknowledges an already-dirty,
  zero-horizon, pending-withdrawal row as a harmless idempotent replay.
- `scripts/staging/qa-owner-negative-primary-publication.prototype.sql`
  creates a *new isolated SQLite fixture*, initially sealed/dirty with
  zero eligibility horizon. It is not in `drizzle/`, `wrangler*`, or any
  deployable migration. A trigger rejects every UPDATE except the allowed
  monotonic negative transition; additional triggers reject INSERT/DELETE.
  It does not enroll a historical production owner or create a clean row.

## Verified locally in CI (not protected live staging)

`scripts/check-qa-negative-owner-primary-publication.mjs` executes the real
CAS SQL in Node SQLite, including normal publication, replay, a competing
publisher, transaction rollback, a falsely acknowledged but rolled-back
write, revision exhaustion, direct attempts to set `dirty=0` or extend
expiry, changed owner identity/version, denied owner, and a withdrawal
between the CAS and final owner challenge.

The existing `scripts/check-current-owner-mutation-fence.mjs` now drives
the same publisher using **the actual `CoveLegalAuthority` Durable Object
handler** and 24-table/78-trigger journal. Only the isolated primary D1
transport is emulated by a real local SQLite database. It simulates a primary
D1 failure **after** a genuine owner ACK and verifies the owner denial stays
durable, the D1 row stays behind, and an idempotent retry advances D1 but
**still keeps the catalog sealed**.

Both tests run on every relevant PR through the existing
`cove-current-owner-mutation-fence-offline` workflow alongside native
Workerd restart/rollback, the paid-owner denials, disabled-production owner
guard and canonical-writer inventory.

## Not yet solved

1. Production legal-owner activation, a legally reconciled historical
   owner journal, independent owner KV coverage, and full catalog
   entitlement/withdrawal provenance. The QA fixture's virgin epoch and
   synthetic identity are **not** transferable to the 82,247-title catalog.
2. A **positive** atomic owner-authorized publication with immutable
   legally current catalog snapshot, complete authority lineage, positive
   grant/expiry proof, same-transaction D1 source mutation triggers, dirty
   and pending-state reconciliation, and a version-bound eligibility horizon.
   This PR deliberately does not permit `dirty=1 -> dirty=0`.
3. Exclusive physical primary-D1 writer, including all live backend cron
   and HTTP writer consumers, and Cloudflare API-token write principals.
   Triggers alone cannot defeat credentials with schema-modification rights.
4. A final serving boundary linearized with withdrawal acknowledgement,
   real-catalog parity, verified storefront 503 elimination, strict
   four-region/100-RPS capacity, Stripe LIVE payments/refunds/revocations,
   and protected rollback rehearsal.

The stage SQL is not applied remotely and no source code here is imported
into customer-serving Worker entrypoints. No production D1 migration, Worker
deploy, legal-mode switch, credential modification, DNS alias change or
Stripe transaction is performed. Release remains **NO-GO**.
