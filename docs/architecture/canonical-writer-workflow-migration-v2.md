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


## Fast, strictly attested source review rebasing

A file-level SHA change invalidates every SQL `siteId` in that file, even if
only one of its many protected statements was retired. Use
`scripts/rebase-canonical-writer-review.mjs` to carry forward only **exactly
unchanged** site signatures (file, function, table, operation and literal SQL
SHA-256), while recomputing line numbers and source-bound IDs. It cannot create
a new SQL review, change an exception disposition, claim owner certification,
or lift the release gate.

Before running it, independently review **every changed caller and guard**,
not just SQL text, and add a source attestation file under `docs/` with:

```json
{
  "schema": "cove.canonical-writer-source-attestation.v1",
  "releaseApproval": false,
  "rationale": "At least 80 characters explaining the actual independent review of the changed source and how no production writer bypass was introduced.",
  "files": [{
    "path": "src/features/fore/publishing.server.ts",
    "sha256": "<exact lowercase SHA-256 of the reviewed source file>",
    "review": "At least 40 characters describing the reviewed caller and authorization guards."
  }],
  "retirementEvidence": "docs/architecture/<actual-owner-cutover-evidence>.md"
}
```

The retirement evidence file must describe removed production paths, the
replacement typed owner commands, preservation of business behavior and tests,
the external/deployed principal inspection, recovery and rollback. Removing
sites requires that evidence; editing the SQL itself must instead get a new,
independent per-site review and cannot be automatically rebased.

Run `node scripts/rebase-canonical-writer-review.mjs
--review-attestation=docs/architecture/<actual-attestation>.json` for a
read-only preview, then repeat with `--write` after review. The existing
canonical writer inventory, frozen exception lineage, owner command regression
tests and **independent failed release gate** remain mandatory. This is a
bookkeeping accelerator for genuine deletions, **not** a production owner
certification or a way to lower the count without retiring code.
