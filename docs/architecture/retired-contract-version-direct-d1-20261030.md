# Retirement evidence: direct distribution contract-version SQL

**Date:** 2026-10-30. **Scope:** exactly the nine audited authorizing mutation sites in `traditional-publishing.saveContractVersion` in `src/features/fore/traditional-publishing.server.ts`.

## Actual source retirement

The previous API-facing implementation used a direct D1 `db.batch` for contract version replacement, territory/format/channel replacement, supersession, activation and the associated contract audit. That source-level implementation has been removed from the API-importable module, not marked "non-authorizing" and not renamed into a scanner-blind string. Its SQL is now inside `src/storefront-strangler/legal-authority.worker.ts`, in the physical `CoveLegalAuthority` private service-binding-only worker. The owner executor invokes the physical writer only after validating staff identity, contract state, current version, idempotency journal, and deny-first handling of any non-draft transition. The executor receives a private callback; it does not import an API-accessible D1 writer. A legacy direct caller receives HTTP 503 from the `saveContractVersion` API symbol.

## Behavior and isolation

Isolated QA under a short-lived, separately bound owner lease continues to save a draft, activate a version, return an exact replay receipt, reject forged staff identities, and fail closed if the owner is unavailable. This is a deliberate administrative capability pause **outside enrolled QA**: production staff cannot edit distribution contract versions until its writer-only authority is independently certified. No other publishing, commerce, publishing-trust or traditional-publishing SQL has been retired by this change. The other 417 open authorizing findings and all existing production privileges remain blockers.

## Rollback, external verification, and unresolved risk

Rollback must never restore the direct writer in a public backend while an owner fence is active. Safe rollback is to keep production contract-version creation disabled, revert application routing only after first quiescing owner commands, and reconcile all owner command receipts against canonical D1 version/audit rows. An interrupted private D1 batch is journaled as pending and cannot be blindly retried or treated as a successful rights grant. Before enabling production: verify physical production D1 and private binding, test invalid staff/expired lease, denial before supersession, exact retry/lost ACK, no legacy live deployments, recovery of pending commands, immediate paid-access withdrawal, and operator privilege revocation. Static inventory retirement is **not** deployed owner-only or public routing certification.
