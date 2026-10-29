# Canonical writer workflow migration v2

**Status: audit infrastructure only. Production owner authorization and public routing stay disabled.**

## What the audit measures

The current SQL-site inventory finds 460 source candidates: 426 requiring an owner command,
33 reviewed as non-authorizing, and one isolated test fixture. The required sites have
155 distinct **recorded command-family names**. Those labels come from review metadata,
not independent proof that every family has exactly one live caller.

The SQL-site audit is a conservative source lower bound. It cannot prove coverage of
generated SQL, deployed historic Workers, direct D1 operator access, external jobs,
or service credentials. New audit grouping never implies a safe production migration.

## Changes

- `src/storefront-strangler/canonical-legal-tables.json` is the single 120-table deny-first registry
  consumed by the source scanner and the staging runtime D1 write lock. No table
  exclusions or runtime allowances are introduced.
- `node scripts/canonical-owner-workflow-inventory.mjs` reconciles every SQL site
  to the existing exact source-bound review before grouping required sites by
  their recorded command family. Export machine-readable evidence with
  `COVE_WORKFLOW_AUDIT_OUTPUT=/tmp/cove-workflows.json`.
- Command-family IDs are stable across unrelated source changes. They are
  **dashboard grouping keys only**: the existing per-site exact SQL fingerprint,
  surrounding-source SHA and guard/caller re-review remain unchanged.
- JSON explicitly reports `productionOwnerCertified:false`,
  `productionCertifiedCommandFamilies:0`,
  `observedRuntimeWriterBypasses:null` and `productionReleaseEligible:false`.
- Both the original `--release-gate` and the new report's `--release-gate`
  remain fail-closed; no test environment variable can approve production.
- CI uploads a machine-readable command-family report alongside the original
  line-addressed source inventory. Release approval is not a workflow artifact.

## Next implementation stage: actual typed command gateway

The inventory is preparation, **not the gateway migration itself**. Subsequent
changes must establish these properties with executable code and deployed evidence:

1. Every canonical write entry point (API, webhook, cron, staff, ingestion,
   publishing) invokes a narrowly typed command. Callers cannot supply SQL.
2. The strongly consistent owner authenticates the command principal, checks
   rights/entitlements/epochs and durably records revocations and idempotency.
3. The canonical D1 executor is the only production principal with mutation
   capability, operates with narrowly scoped credentials, and atomically
   writes each business operation's ledger and completion marker.
4. Owner-first negative operations commit a denial before primary mutations.
   Positive publication requires verified canonical persistence and an
   independently checked owner epoch. Partial failures remain denied until
   idempotent recovery.
5. Every alternate caller, deployment, direct D1 API, dynamic SQL producer,
   third-party job, operator and recovery path is tested or explicitly fenced.

## Release requirements

Production authorization requires verified **zero reachable unowned mutation
paths**, zero unclassified generated SQL and uncontrolled D1 principals, fully
certified applicable business workflows, paid media/refund/withdrawal QA, and
separate hosted capacity, geography and rollback acceptance.

Source classification, isolated QA and command grouping cannot meet these
requirements. Nothing in this change enables the production legal owner.
