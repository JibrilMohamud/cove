# Retired unowned positive copyright-restoration and royalty-release writers — October 30, 2026

## Physical migration and safety boundary

The legacy shared-D1 `restore` (7 protected SQL sites), `releaseHolds` (3 protected SQL sites), and scheduled restoration state write (1 site) were **physically removed** from `src/features/fore/publishing-trust.server.ts`. The original SHA-256 SQL identities and site IDs are frozen in `docs/architecture/retired-unowned-restoration-lineage.json`. Exact audit dispositions remain attached to every surviving SQL literal and `releaseApproval=false`. This is **11 source-level writer retirements**, from 260 to 249 total and publishing-trust 53 to 42. It is not a live owner cutover and does not certify publishing-rights reinstatement.

The public/staff `resolveRightsDispute` denies any `restoreContent` or requested/mandatory `release` **before** writing dispute, moderation, financial or legal state. Infringement-confirmed disputes with no release continue through their existing path. The deadline scheduler reads due disputes but denies with 503 before writing or falsely notifying either party of restored content. This intentionally leaves due cases for operator review, rather than resurrecting content or unfreezing funds without an owner. The scheduler failure must trigger operational alerting; do not suppress these 503 errors.

## Why this is a blocked functionality, not a completed replacement

Restoration and payment release are positive authority transitions. Legacy code trusted the current lifecycle state, a staff actor and a deadline clock, none of which by itself proves that the original copyright/legal withdrawal has been cleared. A safe private owner replacement must independently validate a fresh, current legal resolution/counter-notice/court-evidence chain, litigation-hold status, target publication version, contract and territory, and denial epoch. It must atomically reconcile royalty holds, ledger balances, all related product availability, offline delivery and subscription entitlements. Cross-worker replay and crashes need idempotent receipts and no old D1 bypass.

Before enabling this functionality, add strict typed owner commands, a read-only public receipt, a verified operation identity, dead-letter handling/operational legal escalation, adversarial reinstatement tests, post-refund/revocation proof, independent principal privilege retirement and a protected rollback rehearsal. Restoration must never be 'fixed' by recreating these SQL statements in the API, by widening SQL audit exceptions, or by setting production `COVE_RIGHTS_OWNER_ENABLED=1` without certification.

## Rollback and release decision

The branch does **not** change production routing, Cloudflare bindings, secrets, Stripe mode, rights withdrawals, or audit release approval. Rollback to an older shared-D1 restoration function is **unsafe after** independent owner evidence epochs or entitlement revocation have begun. Maintain a human legal-case escalation path for counter-notices awaiting restoration; hold payout releases and public availability until the owner can prove positive authority. The source attestation `docs/architecture/retired-unowned-restoration-source-attestation-20261030.json` pins the exact code; the CI check `scripts/check-retired-unowned-restoration.mjs` prevents silent reintroduction of these shared writes.
