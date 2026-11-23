# Primary-D1 owner migration integration — evidence and NO-GO decision

Date: 2026-11-22
Branch: `integration/zero-owner-required-sql-20261122`
Pull request: [#826](https://github.com/JibrilMohamud/cove/pull/826)
Production cutover: **NOT PERFORMED**

## What was integrated

The October `security/private-catalog-source-upsert-20261031` zero-source-writer stack was compared against pinned November main `686f937660549377b183d651cd7d64158e5c8066`. The candidate brought forward 217 October-only paths, reconciled nine files modified by both histories, and retained main's current legal mutation-journal, owner-denial, source SQL, privacy and EPUB-history protections.

The source inventory is **46 exact reviewed SQL sites, zero `owner-command-required`**. This number is limited to source-labeled SQL; it neither certifies Cloudflare privileges nor counts other-language scripts. The BioSync scheduled Python script was separately identified as a direct primary-D1 mutation client. Its proposed replacement uses a QA-only, strictly typed owner command, separate D1-read and R2 credentials, an unbound QA gateway and a transactionally checked timing-map publication. The replacement's synthetic owner, Python, gateway and TypeScript checks ran in independent PR CI. This is not yet a protected hosted cutover.

## Independent real-data/cloud audit status

A read-only Cloudflare API inventory on November 22 checked current settings of all **460 Worker scripts** (zero API errors). Exactly **two current Worker settings** reference the production primary D1 database:

- `cove-persistence-backend`, primary-D1 binding `DB` (still a competing physical writer).
- `cove-legal-authority-production`, primary-D1 binding `PRIMARY_DB`, with `COVE_RIGHTS_OWNER_ENABLED=0`.

An independent exhaustive Cloudflare API walk then inspected the latest deployments for **all 460 scripts** and **all 460 positive-traffic active versions** (no API errors). Exactly those two currently active versions have the primary-D1 binding, each at 100% traffic: backend version `401f2af2-6e69-4611-8110-1d127af6eecf` and production legal owner version `3463ff93-f077-40bf-a4d5-fb7bfc143cd5`. The legal owner is disabled. The QA staging Worker binds an isolated QA database and remains separately disabled. The broad legacy GitHub deployment token still has powerful D1/Workers permissions; narrow D1 Read and Workers script deploy tokens exist. The account API cannot establish all user-scoped tokens and must not be treated as proof of credential exclusivity. This snapshot covers the latest active deployments but not older zero-traffic versions or privileges outside Cloudflare Workers.

**Therefore physical primary-D1 write authority is not exclusive.** Do not remove the backend binding or revoke its credentials until replacement business operations are proven, because that could break accounts, checkout, catalog, ingestion, refunds, and withdrawals.

## Evidence gate and CI

The combined QA regression collection includes real-schema checkout preparation and idempotence, account/owner commands, rights races, positive/negative QA generation CAS, current owner denial and journal epoch checks, private regional EPUB history denial, synthetic BioSync atomicity/receipt tests, and a real owner / full-schema **synthetic public-domain free-library grant** test. The free-library test proves exact retry, wrong-market refusal, newer owner withdrawal and source-evidence invalidation. These do **not** prove current legal authority for the live 82,247-book catalog.

Known integration failures must remain visible:

1. **Historical source attestations:** a read-only independent CI diagnosis found 38 mismatched historical source-hash claims among 63 examined file references. Historical attestations were not silently rehashed or falsely approved. Their original source versions remain historical records; fresh, independent review of changed guards, call sites and legal SQL is required before a new source attestation can replace them.
2. **Privacy source guard:** a diagnostic workflow requires the entire `api.server.ts` to remain byte-for-byte identical to main. This is incompatible with incorporating the October API owner-command migration in one branch. The guard has **not** been bypassed; migration needs a separately reviewed workflow scope or a positive reviewed source comparison rather than an unconditional waiver.
3. **Local service/browser fixtures:** earlier tests assumed an ownerless public-domain library entitlement could succeed. That must fail closed. The service fixture now tests ownerless denial and a self-owned synthetic personal import for ordinary reading behavior; a separate actual-owner QA test covers positive entitlement grants. Both standard `verify` CI jobs passed after this separation. Browser/device regressions still need independently passing verification.
4. **External legal chain:** disputed historical grant ordering, backdated events, missing independent withdrawal completeness and current owner denial epoch are not resolved by code or synthetic tests. There is no valid production positive certificate.
5. **Scheduled BioSync:** proposed cutover removes the old hourly direct-writer scheduling. Do not merge or enable it until the replacement has verified QA credentials, source inputs, an R2 bucket, real protected end-to-end results and an operational schedule/rollback.
6. **Other release gates:** production 503 elimination, Stripe LIVE fulfillment/refund/revocation, protected rollback and strict geographic/100-RPS performance remain independent NO-GO requirements.

## Safe executable decision order

Keep the PR draft and locked. Independently re-review source and rights history; perform real-schema protected QA for every typed owner writer family, including legitimate positive commerce and ingestion, withdrawals and races; validate the real BioSync replacement with read-only D1 creds; verify no pending owner write journal/denial fence mismatches; then re-enumerate **active deployed versions plus account/user tokens** and retire backend D1/broad write credentials through a rehearsed rollback-capable change. Enable a production owner or authorize sales **only after** the external chain of legal authority and current withdrawals has been independently established.

No owner production toggle, route, token, live database, or customer commerce state was changed by preparing this evidence.
