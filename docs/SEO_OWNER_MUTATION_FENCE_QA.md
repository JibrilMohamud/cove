# Owner-wide SQL mutation fence: isolated prototype

The current QA SEO bridge instruments only source withdrawal. That cannot
establish that a global owner counter observes other legal/commerce denials
before their later primary-D1 reconciliation. This prototype tests a broader
mechanism at the owner's SQLite statement boundary, without enabling a
production owner or serving proof.

`seo-owner-mutation-fence-qa.ts` is **not imported by the shipping owner or
sitemap**. The test verifies that separation using actual esbuild input
graphs, including transitive imports. Its distinct
`cove.qa.owner-mutation-fence.v1` receipt says `authorizing:false`; the actual
SEO serving validator rejects it even when otherwise valid count evidence
is supplied. There is no new public/private production route or environment
switch.

## Mechanism and enrollment

The manifest names all **24 SQL tables** created by the real legal owner's
eight constructor schema factories. An AST regression compares factory names,
order and resolved import paths with the actual constructor, rejecting an
unreviewed new call. The fixture then executes those genuine schema factories.

Enrollment requires an empty SQL authority/history, except the one exact
initial publication-recovery cursor. A preexisting source, market, refund,
entitlement or publication record cannot silently become epoch zero. Both
metadata tables, the complete original table DDL manifest and all triggers
are installed in one supplied real `transactionSync`.

- **72 AFTER triggers** observe INSERT, UPDATE and DELETE on every reviewed
  table. Their counter advancement commits or rolls back with the same
  SQLite statement as the state mutation. No later D1 acknowledgment is used
  as a substitute for that owner-first boundary.
- **Six metadata guards** prevent counter insertion/replacement, deletion, reset/decrease,
  owner-version replacement and manifest insertion/update/deletion. Counter
  updates must advance by exactly one; exhaustion aborts the original state
  write instead of accepting an untracked transition.
- Each receipt read checks the complete visible table/view inventory,
  original table DDL, exact trigger names/targets/bodies and counter/version
  inside one owner transaction. Missing, replaced or unexpected schema fails.
  Re-enrollment validates existing metadata; it **never repairs a missing
  trigger**, resets a counter, or conceals an interval of unobserved writes.
- This counts **all row mutations**, including positive transitions and
  bookkeeping. It is deliberately conservative. No-op UPDATEs also advance;
  ignored INSERTs and real command replays without DML do not. Reducing false
  invalidations would need separate correctness and performance evidence.

Cloudflare exposes its internal `__cf_kv` table in metadata but prohibits SQL
access to its contents. Only that exact internal table and SQLite internal
objects are excluded. **KV-backed legal state is not covered**; a shipping
integration would have to prove all relevant authority uses the reviewed SQL
state or provide an independent KV mutation protocol.

## Executed evidence

`scripts/check-seo-owner-mutation-fence.mjs` uses synthetic data only:

1. Exercise every INSERT/UPDATE/DELETE trigger against the actual owner DDL,
   including the paid-scope foreign-key parent fixture.
2. Run **nine real command paths**: source withdrawal, market withdrawal,
   product distribution denial, retail hold, contract/grant subject denial,
   whole-order refund denial, paid-entitlement denial and publication hold.
   Each advances the global counter before any primary reconciliation;
   exact replays do not advance again. A positive source-state transition
   also invalidates the old counter.
3. Inject failure after a denial inside the transaction; both denial and
   counter roll back. Reject unreviewed tables/views, changed table DDL,
   missing/replaced triggers, metadata writes, historical enrollment,
   missing counter and exhausted counter. A damaged fence is never repaired.
4. Repeat real commands/transactions in the repository's pinned **workerd**
   runtime using an actual SQLite-backed Durable Object. Compare its new
   denial counter with an unchanged, separate Node SQLite primary snapshot;
   the old snapshot is immediately distinguishable before reconciliation.
5. Stop workerd, create a new process over the same temporary on-disk object
   store and confirm the counter survives. This tests restart persistence,
   **not** PITR/backup rollback safety.

The runtime is loopback-only. Its namespace, storage directory and test
bundle are temporary; no Cloudflare account, production D1, real customer,
Stripe or external credentials are used. The existing credential-free SEO
workflow runs these checks alongside the prior generation/CAS, deny-first,
expiry, gateway and TypeScript suites.

## Remaining release work

This verifies a SQL invalidation primitive, not complete legal ownership or
a deployable protocol. Production integration, historical-owner migration,
fresh authenticated/version-bound serving attestations, primary-D1 owner
epoch reconciliation/CAS, complete denial-route and real-catalog review,
effective-time horizon derivation, KV/other storage coverage and protected
deployed staging evidence remain required. The live owner remains disabled.

Triggers do not observe legal changes made outside this owner. Exclusive
physical D1 writers, independent rights/offer correctness and current per-URL
authorization remain mandatory. Clock-only expiry still requires the separate
legal horizon. Privileged schema tampering or restoring old legal state
requires external operational controls and the protected rollback protocol.

No production migration, Worker deployment, token, legal flag, traffic,
payment or entitlement change is included. No latency/503, full-catalog,
LIVE-commerce, rollback or dependency-security gate is certified. Keep the
parent PR draft and the release decision **NO-GO** until the independent
release prerequisites are met.
