# Literary preparation lane — physically isolated claims (draft)

## What is implemented

The independent literary `CONTENT_DB` now holds the
`literary_prepare_jobs` table, atomic claims/leases, bounded retries and
final private-R2 evidence receipts. The existing primary D1 is consulted
**read-only** for authoritative source status and source-matched active
territorial grants, before fetching an EPUB and again immediately before
private-R2 publication.

The processor extracts bounded real EPUB sections using the existing
archive validator, refuses malformed or hash-mismatched objects, and
stores a **private, never customer-delivered** structured preparation
bundle with beginning/middle/end section samples under
`literary/isolated-prepared-v1/<job-id>.json`.

All queue inserts, leases, retries and receipts live on the separate
CONTENT_DB. There are **no primary-D1 writes** from this path, no
unauthorized file delivery, and no new library/checkout grants.
The preparer produces evidence only. A new opt-in, operator-only
`importIsolatedLiteraryEvidence` function verifies the private R2 byte
SHA and content-addressed result, then makes **one idempotent import into
a noncustomer-facing primary D1 projection**, using a SQL INSERT whose
predicate checks current source hash, active source-matched grants and
explicit deny precedence **inside the mutation**. This import is disabled
by default and requires the separately staged primary schema
`infra/content-budget/0003_prepared_projection_primary.sql`.
It does **not** replace or publish `literary_profiles`, and it never
authorizes storefront/reader/checkout access. The current
`literary_profile_jobs` and customer profile publication paths still
run in primary D1 until a guarded canonical-profile publisher is ready.

The role is `literary-prepare`, requiring both
`FORE_CONTENT_PROCESSOR_ENABLED=1` and
`FORE_CONTENT_PREPARE_ENABLED=1`, and the CONTENT_DB domain identity
check. Flags default OFF. Its HTTP handler continues to return 404.
No automatic production seeding or newly approved background concurrency
is introduced. A separate operator-only `enqueueIsolatedLiteraryPreparation`
function allows controlled staging/canary imports from already eligible
primary catalog entries. It does not write a D1 primary outbox.

## Rights and consistency

The enqueue and execution checks require a live, source-matched,
active/unexpired ebook retail allow grant with a territory in the current
approved source's territory set; a ready, approved public-domain
Gutenberg source; an active ebook product; and a pinned content SHA.
Each EPUB is private and must pass content-type, R2 SHA metadata,
**actual SHA-256 bytes** and EPUB spine/archive validation.

After the final rights check, the source may still be revoked before or
after the private R2 PUT. A preparation artifact is not a grant; **any
future publisher must recheck rights and current catalog fingerprint
atomically in primary D1 before exposing a profile**. Publishing is
not wired into this feature, so stale prepared artifacts cannot be
served by storefront/reading systems. If the secondary database is
misbound to a catalog or rights-authority D1, execution fails closed.

## Safety / remaining migration work

1. Run independent schema migration `0002_preparation_queue.sql` against
   the staging-only CONTENT_DB, never against the production primary.
2. Provision a Worker disabled and verify its actual isolated bindings,
   cron/HTTP behavior and no active claims.
3. Run synthetic work and revocation tests on nonproduction D1/R2, then
   measure EPUB extract CPU/R2 bytes, primary eligibility read SQL,
   independent job claim rows/writes and retry behavior.
4. Implement a durable primary-to-secondary *outbox with verified cursor*;
   this first stage has manual-only job seeding. The independent evidence
   importer is already rights-gated and one-row/idempotent, but is not
   the customer-visible literary profile publisher. Do not dual-write
   primary and secondary without the handoff ledger.
5. Implement end-to-end canonical literary-profile publication, proving
   same fingerprint, revisions, chapter sequencing and UI parity with the
   current profile lifecycle.
6. Run complete mixed storefront, reader, checkout, audio and ingestion
   load suites over 60 minutes. Establish cold 60/60, 32-concurrency,
   100RPS, mobile LCP and real territory/live revocation headroom.
7. Explicit release approval and rollback; never merge to main solely
   because CI or synthetic D1 staging is green.

No changes to production Worker flags, catalog data, grants, model budgets,
music approvals or frontend routing. This is NOT commercial release.
