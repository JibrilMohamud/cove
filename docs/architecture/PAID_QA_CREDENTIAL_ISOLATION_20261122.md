# Full-schema QA credential migration — November 22, 2026

This change removes the broad `CLOUDFLARE_API_TOKEN` secret from the full-schema
paid/legal QA workflow. It does not certify exclusive production D1 authority
or authorize revocation of the broad credential while other consumers remain.

The existing protected environment contains four independent credentials used
by this workflow: staging Workers deployment, staging D1 read, Workers metadata
read, and account token inventory read. Preflight verifies the actual token IDs
and exact provider policies before any deployment. The staging deploy token
still has account-wide Workers Scripts Write; it is not a per-Worker credential
and remains a separate primary-D1 privilege retirement concern.

## Resource isolation

Five new pre-provisioned Workers are parked at pinned 401-only versions:
`cove-paid-isolated-owner`, `cove-paid-isolated-writer`,
`cove-paid-isolated-caller`, `cove-paid-isolated-settlement`, and
`cove-paid-isolated-fixture`. Both workers.dev and preview ingress are disabled.
The initial parked Workers have no D1/R2 binding. Only the owner has a fresh,
isolated Durable Object namespace. No production Worker was modified.

The private `cove-paid-credential-isolation-qa` R2 bucket was provisioned empty.
During QA, the fixture helper receives only the synthetic paid D1
`7c7ab994-f6b3-419d-a72d-71eb9ea22e7e` and this QA bucket. It accepts an
unpredictable, expiring per-run secret, never a Cloudflare credential. SQL has
no caller-selectable database; media operations allow exactly the three
synthetic QA keys. It cannot query or bind production resources at runtime.
The schema source uses the independent D1 reader and one fixed schema-only SQL
query against the separate synthetic catalog database. No account D1 Write or
R2 management credential is delivered to the job.

The owner routes a validated per-run journal identity to a fresh Durable Object.
The existing production disabled-owner branch and default legacy QA object
identity are preserved. Full Stripe TEST settlement, original EPUB/audio,
offline signatures, refund/revocation, and optional A/B/A rollback assertions
remain mandatory. No performance/customer request path is changed.

Before activation, a receipt records the pinned parked versions and exact
workflow SHA/run attempt. Cleanup restores all five disabled versions and closes
ingress, attempts every worker even if one fails, and independently verifies
the result. A separate always-run workflow step repeats restoration when the
receipt exists. A stale run, another worker, or an unreviewed version is rejected.
The fixture lease expires within 30 minutes; the existing owner/consumer leases
remain shorter. Private QA media objects are deleted during cleanup; the empty
bucket and parked Workers remain for future runs.

## Certification boundary

Local tests cover role routing, no broad fallback, subprocess credential
isolation, native SQLite schema mutations, media access, expired/forged leases,
resource substitution, parking failure fan-out and stale receipts. Existing
real owner handler/workerd tests cover fresh per-run identity, durable denial,
restart and production refusal. Hosted success must be recorded separately.

The source audit before this change found 37 workflow files still referencing
the broad secret (36 after this change). This is a workflow-file count, not a
complete external credential-user inventory. Scheduled Biosync and literary
budget work, other QA/deployment consumers, production schema migration, and
provider-scoped production deployment credentials still require migration and
live proof before the broad token can be revoked safely.
