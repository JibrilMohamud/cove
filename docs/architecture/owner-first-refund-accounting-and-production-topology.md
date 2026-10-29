# Owner-first canonical refund accounting — migration slice

Status: isolated QA only. The production owner remains disabled. This is not production writer certification.

## Executable change

The enrolled refund-success path now invokes `postStageOwnerRefundAccounting` rather than calling `postRefundAccounting(env.DB,...)` directly. This exact command is typed as `commerce.post-refund-accounting` and has only two input fields: orderId and refundId. The fixed private owner route `/commercial/refund/post-accounting` is available only behind the existing short-lived synthetic QA lease, service-binding secret, and verified owner namespace. It is not a public endpoint.

The owner-side `executeOwnerRefundAccounting` checks the canonical refund-to-order relationship and persisted refund status, refuses unconfirmed Stripe refunds, requires a previously committed strong-owner whole-order denial, posts the existing atomic finance/fulfillment D1 batch using the owner's own PRIMARY_DB binding, and reads the resulting canonical succeeded marker before acknowledging. Retrying the same refund is idempotent. An owner/D1 outage cannot release the durable denial.

Production and un-enrolled flows retain their existing legacy finance writes; **their direct D1 permissions have not been migrated or certified**. The upstream refund intent reservation, Stripe webhooks, tender consumption, settlement, grants, publishing and background writers still require owner-first migration. No feature flag in this PR turns on production owner authorization.

## Owner-scoped royalty reversal and interrupted replay (next migration slice)

The enrolled QA refund-success path previously ran the atomic refund ledger under the owner, **then wrote finance royalty reversals directly using the caller's D1 handle**. That left an alternate financial mutation after the owner receipt.

The private `executeOwnerRefundAccounting` now performs `reverseRoyaltiesForRefund` after its atomic refund posting and succeeded-marker read, before sending the owner receipt. The typed gateway refuses any receipt missing `royaltiesReconciled:true`. An enrolled caller no longer executes `reverseRoyaltiesForRefund` directly. Unenrolled production behavior is preserved until it can be migrated and certified.

The existing royalty reversal generates a deterministic per-sale calculation ID and wraps its calculation, allocations and ledger in one D1 batch. If refund accounting commits and a royalty reversal subsequently fails, the owner does **not** ACK. The strong owner denial persists, and replay skips the already-posted refund while retrying any missing royalty reversals. The adversarial test covers this specific interrupted transition, verifies no duplicate refund/royalty batches and rejects a forged success receipt without reconciled royalties. This does not claim cross-database atomicity: reconciliation after a partial failure is intentionally retry-based under continued denial.

The `commerce.server.ts` edit has been reconciled against all 56 previously reviewed site identities using the actual whole-file SHA-256, unchanged SQL literal digest/function mapping, and unchanged source line positions. The conservative 426 owner-command-required sites remain unresolved; the audit has **not** reclassified any as certified. This implementation is still **isolated QA only**, not an owner-first production rollout.

## Exact SQL-site review

Editing the large `commerce.server.ts` changed its entire source-file SHA. The 56 affected v1 site IDs were re-derived after verifying that the only source modifications are one import and the guarded accounting call. Every existing SQL literal fingerprint, named function, disposition and `productionOwnerGuarded:false` status remains unchanged. This is a review bookkeeping update, not certification.

## Independently observed production topology (2026-10-29)

The live Cloudflare API reported:
- Persistence Worker `cove-persistence-backend`: direct D1 `DB` binding to `cove-production`, plus six enabled cron schedules (`* * * * *`, `*/5 * * * *`, `*/10 * * * *`, `23 * * * *`, `17 3 * * *`, `41 4 * * *`).
- Owner Worker `cove-legal-authority-production`: production `PRIMARY_DB` D1 binding and `COVE_RIGHTS_OWNER_ENABLED=0`.
- Additional write-capable canonical D1 bindings: `cove-sounds-publication` has `SOURCE_DB` to the production database and its own `11 * * * *` cron; `cove-storefront-ssr-staging` also has `DB` bound to the production database, despite being a gated staging Worker. Both were independently observed using deployed Cloudflare binding settings on October 29, 2026. Neither can be counted as isolated merely because its name includes staging or its intended code path is read-only.

Those facts verify configuration and **do not** prove every deployed code path, direct API credential or external writer is fenced.

### Account-wide live Worker binding inventory (2026-10-29)

A read-only Cloudflare API sweep inspected **450 Cove-named deployed Worker scripts** and their current bindings. **57** have direct canonical production D1 bindings: **44** legacy publication-capture Worker scripts, **7** literary-processing scripts, **2** fast-architecture/customer-gateway scripts, and **4** core/staging scripts (persistence, legal owner, Sounds publication, SSR staging). This snapshot reported **zero API errors**.

Of those 57 bound principals, **six Worker scripts have one or more active schedules**:
- `cove-persistence-backend` (six cron expressions)
- `cove-sounds-publication` (hourly at minute 11)
- `cove-pub-qa-continuous-capture` (every minute)
- `cove-literary-handoff-draining-20261025` (every minute)
- `cove-literary-infer-isolated-disabled` (every minute)
- `cove-literary-prepare-draining-20261025` (every minute)

A binding is a capability and not evidence of actual SQL mutation. Likewise, a cron schedule can remain installed even if its code is paused. Nonetheless, production writer exclusivity is **not certified** while these principals retain direct canonical database access without isolated read-only credentials, independently verified guards, or controlled retirement. Do not blindly delete them: identify dependencies and remove/disable schedules and routes with a rollback plan.

The source-only topology checker covers the documented production configs; it is **not** a replacement for an account-wide deployed Worker and external D1 API credential audit.

 The release must remain blocked.

## Remaining production acceptance before owner cutover

1. Move checkout, settlement, paid grants, raw refund intent and webhook mutations behind a separately credentialed canonical executor; certify Stripe signed event, duplicate, outage, replay, refund and chargeback behavior.
2. Migrate grants, contracts, markets, offers, evidence, publication versions, release schedules, catalog reactivation and background ingestion through typed owner commands with deny-first withdrawal and verified positive publication.
3. Reconfigure actual production bindings to remove canonical D1 mutation capabilities from the API/persistence Worker and all six cron jobs. Audit every other Worker, Vercel function, queue consumer, operator token and external D1 API principal. Do not rely on a source-only lock or deny-all proxy as sufficient proof.
4. Independently attest production owner state, deployment versions, service-binding identities, reachable mutation callers, legal epochs, and real end-to-end paid authorization.
5. Separately pass Cloudflare hosted capacity, geography, and protected rollback gates before changing public routing.

`node scripts/check-production-writer-topology.mjs --release-gate` intentionally fails even if source configuration is synthetically changed to look safe. External production evidence and security review are mandatory.
