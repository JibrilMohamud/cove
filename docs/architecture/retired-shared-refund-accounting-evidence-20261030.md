# Shared refund-accounting writer retirement — 2026-10-30

## Pre-retirement verified production state

Read-only primary D1 query on production database `4bd657ac-8789-403e-a28c-93aba8d0a989`: `commerce_orders=0`, `commerce_orders WHERE status='paid'=0`, `commerce_refunds=0`, `entitlements WHERE entitlement_type='purchase'=0`. Independent read-only live Stripe account `acct_1UWEozIfG1q45dEc` listed zero payment intents (limit=1, has_more=false) and zero webhook endpoints. These are point-in-time observations, not an ongoing guarantee, proof of all possible provider obligations, or production owner certification. The Vercel `cove` project had no Stripe secrets in the inspected project environment. No customer payments were created for this check.

## Exact source retirement

All **11** reviewed owner-required SQL literals previously located in `src/features/fore/refund-accounting.server.ts` have been physically removed from the deployed shared module. Its historical implementation was preserved byte-for-byte solely in `scripts/test-refund-accounting-legacy-source.ts`, under the scanner's test-only path prefix, to keep parity and financial failure-path regression coverage. The production module now throws HTTP 503 without preparing or submitting any D1 SQL; no fabricated success is returned.

The actual private legal-authority Durable Object still owns `postRefundAccountingPrivate`, with the same exact legacy ledger, tender restoration, entitlement revocation, preorder rollback, promotion adjustment, completion marker and D1 batch semantics. The private command independently requires a durable paid-order revocation before posting, checks persisted Stripe refund provenance and reconciles royalties. Its existing QA-only owner lease remains unchanged.

To prevent a **provider refund without the canonical ledger**, `refundOrder` in `commerce.server.ts` now rejects **all owner-unenrolled production requests at function entry**, before any existing refund, Stripe provider, D1 tender or bookkeeping path can run. QA-enrolled refunds continue to use private owner RPC and existing tested provider reconciliation. There are no production refund records to migrate in the verified snapshot. Re-enabling production refunds requires a newly certified live owner route, not a restoration of the legacy executor.

The exact fingerprint rebase verified all 56 unmodified SQL candidates in `commerce.server.ts` against their prior SHA-256 IDs and changed only their file-bound source hashes/line offsets. No authorizing SQL classifications were changed. Reviewed total falls from 425 to 414; owner-required falls from **370 to 359**, conditional on the independent CI source inventory passing. The 56 commerce SQL sites remain unresolved.

## Rollback and activation boundaries

Rollback is **not** re-enabling a direct writer by toggling an environment flag. A rollback of this source change would restore the old refund engine and refund API guard together, but it must only be considered with independent proof there are no owner-vs-legacy concurrent writes, no pending provider refund and no already settled private ledger. Currently safe rollback is to retain a closed refund endpoint and investigate. Never interpret the 11-site reduction as production paid-access approval. Production owner remains disabled, live Stripe webhook setup and owner-only commerce production routing remain outstanding.
