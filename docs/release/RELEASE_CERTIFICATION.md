# Cove release certification — single evidence ledger

**Decision: NO-GO.** Checked 2026-11-23 UTC. This document is an evidence ledger, **not** a release certificate or authorization to enable production commerce.

## Contract and verified baseline

- Repository: https://github.com/JibrilMohamud/cove
- Last independently inspected protected production branch `main`: `95cf2f47d5455d85aa9d744d37f365d8cd56dab3` (merged QA gateway #861 and fail-closed independent legal checkpoint #823).
- Integration: draft https://github.com/JibrilMohamud/cove/pull/850. Reconciled October source stack remains **unmerged** because source parity alone does not prove working production replacements or external legal rights.
- Never weaken canonical legal denials, enable LIVE payments, withdraw a right, grant publication rights, or remove primary D1 authority on the basis of synthetic tests.

## Unified gate checklist

| Gate | Status | Current evidence / remaining contract |
| --- | --- | --- |
| October owner source integration | IN REVIEW — still draft | #850 contains migrated source families, November protections and the owner-context/cron-negative-receipt fixes. Earlier integrated SHA `55934bcac97ca0ec656c4bd40bc6fbfcf3766b89` passed 64 checks (16 skipped); **fresh CI is required** after forward-merging #823 at `edbc175ebe5dda209aed1714d63a492c4f178c30`. Source tests do not prove deployed production writer operations. |
| Hosted BioSync owner command | **PASS — isolated QA only** | Protected GitHub [run 45109625391](https://github.com/JibrilMohamud/cove/actions/runs/45109625391), pinned to `main` `96bd542bbce54b85de510967c261938565d9eee4`. Both authorization and hosted-write jobs succeeded. Job evidence records `ownerCommit=true`, `replay=true`, `deniedAdversarialCommands=true`, `primaryPointerAtomic=true`, `productionAccess=false`, `rightsGranted=false`; teardown step succeeded. This is not a deployed hourly replacement. |
| Production business write-owner proof | NOT CERTIFIED | Account, catalog, ingestion, checkout, refund, legal withdrawal, seven backend crons, hourly BioSync publisher, concurrent retries, recovery, exact idempotency, and rollback need protected end-to-end tests on the integrated candidate. No production cutover before all paths work without direct D1. |
| Exclusive physical primary D1 | FAIL | Read-only production Cloudflare Worker settings still show `cove-legal-authority-production/PRIMARY_DB` and `cove-persistence-backend/DB` both bind primary `4bd657ac-8789-403e-a28c-93aba8d0a989`. `COVE_RIGHTS_OWNER_ENABLED=0`. No backend binding removal/redeployment authorized yet. |
| Existing production schedules | PRESERVED, replacement NOT CERTIFIED | `cove-persistence-backend` has exactly seven live cron triggers: `* * * * *`, `*/5 * * * *`, `*/10 * * * *`, `7-57/10 * * * *`, `23 * * * *`, `17 3 * * *`, `41 4 * * *`. BioSync scheduled replacement remains unproven. |
| Scoped Cloudflare credentials / broad retirement | FAIL | Separate Cove QA account has three active scoped tokens (QA D1 Write, QA R2 Write, QA Workers Scripts Write); protected hosted QA used scoped replacements. Production account has 13 active account tokens; the broad **Cove GitHub Deployments** credential is active with ~385 permissions including D1 Write, Workers mutation and token administration. User-token inventory returned HTTP 403, so wider credential exclusion is not proven. Do not revoke until all dependent jobs and deployments work with replacements. |
| Independent legal grant and withdrawal evidence | FAIL — external evidence | Reconcile 87,742 historical grant-audit records and current withdrawals; independently resolve 116 equal-timestamp conflicts and two backdated events, territorially scoped authority, expiry, reinstatements and current owner-denial epoch. Merged #823 now rejects future-dated signed completeness checkpoints and requires independent coverage intervals, but **no genuine rightsholder authority or complete withdrawal archive was located**. Authentic rightsholder authorization and adjudicated ordering are still required. Quarantine every unsupported claim; no inferred positive grants. |
| Protected full-schema Stripe TEST QA | **PASS — reviewed `main` synthetic QA only** | Protected manual run [45112906933](https://github.com/JibrilMohamud/cove/actions/runs/45112906933) succeeded on main `200bdd79e05915aa7b2a533325ebde6cbcea5c46`: both jobs passed, signed TEST payment, entitlement, EPUB/audio/offline, refund/revocation, dedupe and owner A/B/A rollback after refund. The preexisting temporary QA Worker scripts were independently absent afterward. **Not a deployed integration #850 owner acceptance or Stripe LIVE proof.** |
| Stripe LIVE end-to-end | NOT CERTIFIED | Read-only Stripe inspection: Cove LIVE account connected; one enabled `www.covereads.com` webhook with payment/refund/dispute events, and zero LIVE PaymentIntents. No charge was created. A legally permitted actual charge, refund and immediate owner revocation remain blocked by missing rights and owner cutover. |
| Catalog/storefront reliability and 500/503 | NOT CERTIFIED | Actual Vercel read-only runtime-error groups show backend aborts (16), closed bootstrap failures (3) and TLS ECONNRESET (1), last observed through 2026-11-18; no proof that intermittent storefront 503s are gone. Audit search/count/facet/filter/sort/pagination and legal eligibility parity on the exact serving version. Vercel apex redirects 308 to www; both aliases still pin `dpl_HrWWUHUhMkDQjbFmZ5TW8g8dHWBr` (commit `c959eaed64c58f7d9675c0c8b6852c70f4914dec`). |
| Australian regional EPUB pointers | NOT CERTIFIED | Repair only externally verified object-to-rights pointers; preserve denial/quarantine on conflicts. |
| Protected rollback | **PASS — synthetic QA owner A/B/A only; production NOT CERTIFIED** | Protected full-schema TEST run 45112906933 exercised actual isolated owner A/B/A deployment versions and verified retained negative legal/payment state. Production rollback of pinned Vercel aliases and Cloudflare Worker versions, with canonical write continuity and same-epoch withdrawal/entitlement preservation, is still mandatory and has not been executed. |
| Performance | NOT CERTIFIED | After all safety gates: cold/warm TTFB **strictly <800 ms**, concurrency **1/4/8/16/32**, two 20-second 100-RPS phases of **2,000 valid responses each**, zero drops, p95 **<600 ms**, p99 **<750 ms**, max **<800 ms**, repeatable ORD/LAX/IAD/DFW. No excluded failures or softened definitions. |

## Actual integrations under review

The draft #850 correction preserves private routing context across first-primary sessions, read-only canonical D1, and commerce-specific D1 wrappers while keeping both raw-SQL denial fences. It also rejects resolved `{ok:false}` receipts and propagates scheduled queue/erasure failures. CI source checks and fresh cross-domain test results, **including on the latest HEAD**, are required before source-merger review. Source tests cannot certify physical writer exclusivity.

## External-only evidence still required

Provide authoritative rightsholder grant provenance, all withdrawals including completeness/coverage and ordering for the disputed cohort, and authoritative adjudication of backdated/equal-time records. Do not substitute D1's historical audit log for independently verified rightsholder authority. Once available, run protected full replay against the then-current owner denial epoch, certify only supported rights, and leave all other titles denied.

## Production safety locks

Production legal owner stays disabled; backend D1 binding and seven cron schedules stay deployed until tested owner replacements and protected rollback exist; broad token remains active only until safely replaceable; retail LIVE flows stay denied. **Any gate marked source-only, isolated QA or NOT CERTIFIED is a release blocker.**

Final decision can be changed to GO only after every required gate carries an exact commit SHA, workflow/job artifacts, production verification, owner/withdrawal provenance and signed release acceptance.
