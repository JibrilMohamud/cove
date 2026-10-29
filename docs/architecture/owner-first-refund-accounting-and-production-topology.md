# Owner-first canonical refund accounting — migration slice

Status: isolated QA only. The production owner remains disabled. This is not production writer certification.

## Executable change

The enrolled refund-success path now invokes `postStageOwnerRefundAccounting` rather than calling `postRefundAccounting(env.DB,...)` directly. This exact command is typed as `commerce.post-refund-accounting` and has only two input fields: orderId and refundId. The fixed private owner route `/commercial/refund/post-accounting` is available only behind the existing short-lived synthetic QA lease, service-binding secret, and verified owner namespace. It is not a public endpoint.

The owner-side `executeOwnerRefundAccounting` checks the canonical refund-to-order relationship and persisted refund status, refuses unconfirmed Stripe refunds, requires a previously committed strong-owner whole-order denial, posts the existing atomic finance/fulfillment D1 batch using the owner's own PRIMARY_DB binding, and reads the resulting canonical succeeded marker before acknowledging. Retrying the same refund is idempotent. An owner/D1 outage cannot release the durable denial.

Production and un-enrolled flows retain their existing legacy finance writes; **their direct D1 permissions have not been migrated or certified**. The upstream refund intent reservation, Stripe webhooks, tender consumption, settlement, grants, publishing and background writers still require owner-first migration. No feature flag in this PR turns on production owner authorization.

## Exact SQL-site review

Editing the large `commerce.server.ts` changed its entire source-file SHA. The 56 affected v1 site IDs were re-derived after verifying that the only source modifications are one import and the guarded accounting call. Every existing SQL literal fingerprint, named function, disposition and `productionOwnerGuarded:false` status remains unchanged. This is a review bookkeeping update, not certification.

## Independently observed production topology (2026-10-29)

The live Cloudflare API reported:
- Persistence Worker `cove-persistence-backend`: direct D1 `DB` binding to `cove-production`, plus six enabled cron schedules (`* * * * *`, `*/5 * * * *`, `*/10 * * * *`, `23 * * * *`, `17 3 * * *`, `41 4 * * *`).
- Owner Worker `cove-legal-authority-production`: production `PRIMARY_DB` D1 binding and `COVE_RIGHTS_OWNER_ENABLED=0`.
- Additional write-capable canonical D1 bindings: `cove-sounds-publication` has `SOURCE_DB` to the production database and its own `11 * * * *` cron; `cove-storefront-ssr-staging` also has `DB` bound to the production database, despite being a gated staging Worker. Both were independently observed using deployed Cloudflare binding settings on October 29, 2026. Neither can be counted as isolated merely because its name includes staging or its intended code path is read-only.

Those facts verify configuration and **do not** prove every deployed code path, direct API credential or external writer is fenced. The release must remain blocked.

## Remaining production acceptance before owner cutover

1. Move checkout, settlement, paid grants, raw refund intent and webhook mutations behind a separately credentialed canonical executor; certify Stripe signed event, duplicate, outage, replay, refund and chargeback behavior.
2. Migrate grants, contracts, markets, offers, evidence, publication versions, release schedules, catalog reactivation and background ingestion through typed owner commands with deny-first withdrawal and verified positive publication.
3. Reconfigure actual production bindings to remove canonical D1 mutation capabilities from the API/persistence Worker and all six cron jobs. Audit every other Worker, Vercel function, queue consumer, operator token and external D1 API principal. Do not rely on a source-only lock or deny-all proxy as sufficient proof.
4. Independently attest production owner state, deployment versions, service-binding identities, reachable mutation callers, legal epochs, and real end-to-end paid authorization.
5. Separately pass Cloudflare hosted capacity, geography, and protected rollback gates before changing public routing.

`node scripts/check-production-writer-topology.mjs --release-gate` intentionally fails even if source configuration is synthetically changed to look safe. External production evidence and security review are mandatory.
