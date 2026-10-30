# Owner-exclusive canonical D1 execution fence (pre-cutover)

## Why this is a domain-level change

The production persistence backend imports the *entire* legacy source
catalog/commerce/publishing/trust/partner and scheduler graph. Those functions
share the same `env.DB` canonical D1 binding. Replacing one checkout or
publisher route at a time cannot establish exclusive ownership while another
webhook, cron, administrator, or publisher route can still call `DB.prepare`.

The new `scopeExclusiveCanonicalD1` is applied at **both** the HTTP and cron
entrypoints, after publication-owner environment scoping and before the
handlers receive `env`. There is no per-route exception table.

When `COVE_OWNER_EXCLUSIVE_WRITER_FENCE=1`, it requires the existing
canonical legal lock, production D1 ID, and absence of QA staging modes.
It then replaces the backend-visible DB with a deliberately incomplete
read-only facade. Only single-statement, comment-free `SELECT` queries
are permitted. A caller cannot issue any INSERT/UPDATE/DELETE/DDL, writable
PRAGMA, CTE, compound SQL text, direct `exec`, `withSession`, or raw
`batch`. An allowed `batch` may contain only SELECT statements created
through the same wrapped facade. This check runs before touching D1.

The owner-exclusive fence is **off by default**, and default execution
returns the identical environment and original DB object, preserving active
production workflows and latency. An invalid or partially enabled flag
fails closed. The write fence does not grant authorization, enable legal
owner commands, create a new database binding, or modify any currently
deployed Cloudflare Worker setting.

## What is NOT certified

This is a last-mile safety control, not a workaround for migration. The
current source audit still reports **371 owner-command-required SQL sites**,
including **56 commerce, 53 publishing trust, 49 publishing, 38 traditional
publishing**. They must be replaced by independently verified owner commands
that retain customer, partner, staff, Stripe and legal-rights invariants.
**Do not flip the flag on a live Worker** until every active write path
(including webhooks and scheduled tasks) is fully converted and tested,
the production legal owner is activated with independent proof, positive
payment-to-entitlement and negative withdrawal/revocation are deployed,
all other nonowner production D1 bindings have been removed, and rollback
has been rehearsed. Enabling this flag early correctly blocks legacy
writes, but that can interrupt customer purchases, refunds and publishing.

This deliberately does not lower source audit counts, remove existing
SQL strings, or claim production owner exclusivity. It creates a common
fail-closed runtime boundary for the *whole* migration instead of
hundreds of one-off call-site guards.

## Tests

`node scripts/check-exclusive-canonical-d1-write-fence.mjs`

The test bundles the actual TypeScript module, proves the exact default
no-op behavior, exercises positive owner-cutover preconditions, rejects
stage/QA and mismatched production settings, verifies read-only SELECT
and its bound/batched forms, and adversarially probes forged/foreign
prepared statements and every class of SQLite mutation. No blocked
statement may be prepared in the underlying D1 binding.
