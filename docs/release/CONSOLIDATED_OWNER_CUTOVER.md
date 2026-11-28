# Consolidated production owner: cutover boundary

This change advances PR #895 on top of the production owner and the implementation merged from #944. It does not deploy, move Durable Object state, revoke credentials, or certify production exclusivity.

## Implemented candidate

The canonical owner captures product membership and legal scopes in bounded, resumable pages. The descriptor binds the owner epoch, withdrawal sequence, counts and rolling page digest. Products without discoverable scopes remain unavailable by default. A capture must finish before a baseline can be sealed.

`quarantine-all` is an explicit negative decision over the captured catalog, not evidence of a grant. It requires no fabricated reviewer signature. Unknown/new scopes remain denied. Independently reviewed allowances use the separate signed publication protocol: pinned, distinct normalized P-256 publisher/reviewer keys, digest-bound batches and atomic generation publication. Pending generations cannot grant access; withdrawals invalidate stale work, including interrupted publication. Retries recover the same capture page and generation instead of advancing twice.

The production quarantine configuration requires `COVE_RIGHTS_OWNER_ENABLED=1`, `COVE_PRODUCTION_QUARANTINE_OWNER_ENABLED=1`, the existing physical production enrollment, and a persisted, complete zero-allow baseline. Flags alone do not admit business operations. A later positive generation closes this quarantine-only admission; this candidate does not implement positive production serving from that generation.

Quarantine preserves the original authenticated account/reader maintenance routes and adds the original RBAC refund handler. Refunds use only four exact typed negative/financial owner commands, preserve provider validation and durable revocation, and cannot obtain a generic SQL writer. Checkout, settlement, delivery and other positive public business operations remain denied. Existing private BioSync and literary publication protocols retain their independent enrollment, authentication and data boundaries.

The backend candidate has no D1 binding. Owner-native business code receives a fenced facade. Rollback stays within the owner boundary; it must never restore the backend's primary D1 binding.

## Local acceptance

The native suites use actual workerd service bindings and all 95 migrations. They read persisted rows, exercise restart/replay and record explicit `productionAccess:false` and `hosted:false`. Local evidence is not hosted acceptance.

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
node scripts/release/check-owner-integration-current-source.mjs
node --test scripts/release/current-legal-baseline.test.mjs scripts/test-current-legal-scope-discovery.mjs
node scripts/test-current-legal-owner-baseline.mjs
node scripts/release/build-production-consolidation.mjs
```

Run the native proof scripts through the pinned Wrangler/Miniflare invocation in `.github/workflows/cove-consolidated-owner-native.yml`. That workflow checks both ordinary isolated commerce and production quarantine refunds, plus reader/account persistence, seven schedules, failed-job recovery and owner-bound restart/rollback. `production-consolidated-owner-candidate.yml` separately checks the existing production BioSync bridge.

## Preparing independently reviewed publication

Collect the owner's sealed capture descriptor and all indexed pages through the private capture-status/capture-page protocol. The offline capture file contains `primaryId`, `inventorySha256`, `descriptor` and `pages`. Obtain independent signed review and pinned reviewer trust for the exact flattened scope inventory; do not treat canonical grant rows as independent evidence.

```sh
node scripts/release/prepare-current-legal-owner-publication.local.mjs \
  capture.json independent-review.json reviewer-trust.json NEXT_GENERATION prepared.json
```

The preparer verifies the complete captured partition and the independent review, then emits bounded batches and a header. Its output is nonauthorizing and must receive the separately pinned publisher and reviewer signatures before owner begin/append/seal. Do not send private keys to the owner. Capture epoch/withdrawal changes require fresh capture/review. The diagnostic inspect endpoint never grants access.

## Observed production blockers

Read-only Cloudflare observation at **2026-11-28 14:03:55 UTC**:

| Gate | Observation | Required before retirement/cutover |
| --- | --- | --- |
| Owner enablement | `COVE_RIGHTS_OWNER_ENABLED=0` | Deploy reviewed candidate and complete canonical inventory/quarantine publication; do not merely flip a flag. |
| Owner configuration | Seven required backend bindings absent | Provision the existing matching secret/config values through protected secret handling, preserving backend compatibility. |
| Competing physical binding | `cove-persistence-backend.DB` still targets primary `4bd657ac-8789-403e-a28c-93aba8d0a989` | Prove hosted replacement operations before deploying the D1-unbound gateway. |
| Standing staging credential | `COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN` remains active | Complete detached replacement workflows/data, prove dependencies, then revoke at Cloudflare. |
| Standing production upload credential | `Cove Protected Worker Version Upload` remains active | Complete replacement and owner-bound rollback under temporary exact-Worker authorization, then revoke at Cloudflare. |

Absent owner bindings: `COVE_SOUNDS_SNAPSHOT_ENABLED`, `FORE_BACKEND_TOKEN_SHA256`, `FORE_INGESTION_SIGNING_KEY`, `FORE_OFFLINE_AUDIO_SIGNING_JWK`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`. Cloudflare metadata exposes names, not transferable secret values. Never replace those with invented values or print them into logs.

Detached staging provisioning is not data migration or acceptance. The attempted additional isolated music D1 was rejected by the provider database quota. The attempted synthetic source export was rejected because it contains virtual tables. Neither attempt copied data. Resolve capacity and use schema-aware copying/rebuilt search indexes before declaring those consumers migrated. Do not co-locate the isolated music domain in primary D1 to bypass quota.

## Coordinated cutover sequence

1. Complete and review CI for this branch. Provision missing owner configuration using protected credentials. Inventory every staging/deployment consumer and complete detached data migration and hosted replacement acceptance.
2. Upload a reviewed zero-traffic production owner version preserving its existing namespace, BioSync/literary protocols and bindings. Preserve an owner-bound rollback version with compatible persistent state. Independently verify the uploaded bindings and secrets by name and protected functional checks.
3. Publish the actual canonical inventory and complete deny/quarantine partition. Verify persisted publication status, unknown-scope denial and withdrawal continuity. Positive production access requires independently authorized scope evidence and a separately completed consumer path; quarantine is not commercial release certification.
4. Exercise the real gateway and owner, authenticated account writes, all seven schedules, BioSync, refund/revocation/retries, operational persistence and owner-bound rollback in protected hosted acceptance. Check rows and receipts, not only HTTP status.
5. Activate the coordinated owner/gateway/schedule replacement. Physically remove the backend primary D1 binding; preserve service identity and client authentication. Roll back only to an owner-bound version if a gate fails.
6. Independently verify no required consumer depends on either standing deployment credential, revoke each exact token at Cloudflare, and remove obsolete GitHub secrets. A source reference scan is not revocation proof.
7. Run the unchanged protected `cove-exclusive-primary-d1-writer-audit.yml` against the deployed topology, active versions and credential inventory. Require a fresh passing result; this document and local tests cannot substitute for it.

The deployment remains a no-go while any of these prerequisites is incomplete. Preserve source attestations as historical evidence; their byte-preserving delta checks do not re-certify legal authority or physical exclusivity.
