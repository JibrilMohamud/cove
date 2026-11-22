# Retiring the broad Cloudflare deployment credential — protected work plan

Status: **NO-GO**. Source controls on draft PR #827 do not establish successful authenticated deployment, and the user token / GitHub Actions secret inventory is not accessible to this GitHub connection.

## What is independently observed

- Account-wide `Cove GitHub Deployments` is active, last used 2026-11-22T15:15:41Z, carries production-account `D1 Write`, Workers Admin and account token issuance permissions. Cloudflare audit records show active QA Worker upload/deployment, R2 bucket creation and cleanup. Do not revoke until these calls have replacement proof.
- Production D1 is still bound by `cove-persistence-backend` as `DB`, with seven crons, and `cove-legal-authority-production` as `PRIMARY_DB`, with owner disabled. Token revocation does not remove runtime D1 bindings.
- `node scripts/release/audit-legacy-cloudflare-credential.mjs --audit` scans every GitHub Actions workflow for direct `secrets.CLOUDFLARE_API_TOKEN` uses, reports all offenders, and correctly refuses `--release-gate` until none remain. The source auditor is not a physical certificate.

## Critical replacement credentials and deployment boundaries

- `COVE_CF_FLEET_READ_TOKEN`: Worker script/metadata read, schedules, domain and route READ on production account; not D1 Write.
- Existing `COVE_CF_WORKERS_METADATA_READ_TOKEN`: production owner binding checks without deploy rights.
- `COVE_CF_PROD_WORKERS_DEPLOY_TOKEN`: **temporary, manually approved** production Worker deploy only; audit its Worker resource scope and avoid D1 Write/token issuance. Worker deployment may itself add a runtime D1 binding even without REST `D1 Write` permission. Remove this credential from GitHub and disable/revoke it after the protected cutover before claiming exclusive physical writer authority.
- `COVE_CF_PROD_D1_MIGRATIONS_TOKEN`: temporary, separate guarded D1 schema migration principal, removed **before** exclusivity certification; never available to unattended CI.
- `COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN`: existing Worker deploy principal for protected staging operations that stay in the production account; verify it does not add primary D1 bindings.
- `COVE_CF_STAGE_DATA_PLANE_READ_TOKEN`: scoped GET-only D1, R2 and Worker preflight in the existing account. The existing Cloudflare "Cove Staging Data Plane Readonly" token is a potential candidate, but confirm its Worker GET scope and store only in the protected GitHub environment.
- `COVE_CF_STAGE_R2_PROVISION_TOKEN`: scoped staging R2 bucket create/read plus D1 Read (for exact QA database preflight), **never D1 Write**; dedicated manual protected workflow, no production Worker mutation.
- `COVE_CF_QA_WORKERS_DEPLOY_TOKEN`: **different Cloudflare account** from production, for isolated paid QA Worker upload, version deployment, secret setup and cleanup. Never reuse or broaden `COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN`.
- `COVE_CF_QA_D1_MUTATION_TOKEN` and `COVE_CF_QA_R2_STORAGE_TOKEN`: dedicated **separate Cloudflare account**, not the production account. Required protected variables: `COVE_CF_QA_ACCOUNT_ID`, `COVE_CF_QA_PRIMARY_D1_ID`, `COVE_CF_QA_PRIMARY_D1_NAME`, `COVE_CF_QA_SCHEMA_SOURCE_D1_ID`, and `COVE_CF_QA_WORKERS_DEV_DOMAIN`. The staging fixture source and target D1 must be provisioned independently in that account. **2026-11-22 Cloudflare read-only account inventory returned only the existing production Cloudflare account**; no isolated QA account is available through this connection, so this protected paid QA is blocked until a separately isolated account exists and is authorized. Do not silently reroute it into production. The script rejects the production account, production primary D1 and production workers.dev domain *before* network traffic.

## Remaining consumers to migrate

The current `main` workflow tree includes many additional references beyond the first seven workflows addressed in this draft: direct scheduled BioSync, music QA, full catalog acceptance, storefront SSR, old literary workflows, isolated-data publication, commerce browser QA, legal owner staging, protected rollback, Cloudflare probes, temporary R2. They are not interchangeable operations. Move each to a protected and correctly scoped reader, staged Worker deployer, R2 mutator, or isolated QA D1 owner. Replace source references, prove work with the actual scoped secrets, and repeat the inventory and Cloudflare audit records.

## Credential revocation gate

1. All legitimate GitHub workflows migrate; orphaned/disabled workflows are deleted or rendered credential-free; account-wide inventory shows no other active clients.
2. Isolated paid end-to-end QA passes: real TEST payment, full-schema synthetic D1, original R2 byte checks, refund, denial, clean teardown and protected rollback. Repeat with isolated credentials; compare before and after Cloudflare audit events.
3. Scoped production Worker version upload/rollback and GET-only Worker/D1 audits work with narrow credentials, with no service interruption.
4. All direct `secrets.CLOUDFLARE_API_TOKEN` refs are **zero**, no external deploy users are outstanding, and Cloudflare audit logs show no recent operations by the broad credential after full cutover. Also inventory *all* other active Workers deploy and D1 mutation principals; a token that can upload a Worker and attach primary D1 is competing potential write authority even without `D1 Write`.
5. Disable/revoke the broad credential through protected Cloudflare administration. Verify status is disabled/revoked and all replacement workflows still pass. No automatic D1/rights publication as part of revocation.

## Separate, later business-owner gate

The October SQL source reconciliation is draft PR #826; its zero owner-required site count is scoped to reviewed SQL. Production owner still lacks independently authoritative full historical withdrawal/reinstatement evidence, owner-denial epoch certification and full legitimate operations (ingest, accounts, media, checkout, settlement, refund, revocation, cron) through the canonical owner. Reconcile rights first, exercise protected real-schema stage, enable signed owner commands, migrate all backend reads to a read-only service, remove the backend's direct primary-D1 binding only after positive proof and rollback rehearsal, and recheck all active Worker versions, user/account tokens, external D1 principals. Never publish positive rights without independent evidence.
