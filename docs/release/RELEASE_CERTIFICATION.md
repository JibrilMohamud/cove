# Cove release certification — single evidence ledger

**Decision: NO-GO.** Checked 2026-11-23 UTC. This document is an evidence ledger, **not** a release certificate or authorization to enable production commerce.

## Contract and verified baseline

- Repository: https://github.com/JibrilMohamud/cove
- Last independently inspected production branch `main`: `96bd542bbce54b85de510967c261938565d9eee4` (merged #855–#860).
- Integration: draft https://github.com/JibrilMohamud/cove/pull/850. Reconciled October source stack remains **unmerged** because source parity alone does not prove working production replacements or external legal rights.
- Never weaken canonical legal denials, enable LIVE payments, withdraw a right, grant publication rights, or remove primary D1 authority on the basis of synthetic tests.

## Unified gate checklist

| Gate | Status | Current evidence / remaining contract |
| --- | --- | --- |
| October owner source integration | IN REVIEW | #850 includes migrated source families, November protections and new dual-facade/cron-negative-result fixes. CI must pass on the **latest** integration HEAD; does not yet prove production writer operations. |
| Hosted BioSync owner command | **PASS — isolated QA only** | Protected GitHub [run 45109625391](https://github.com/JibrilMohamud/cove/actions/runs/45109625391), pinned to `main` `96bd542bbce54b85de510967c261938565d9eee4`. Both authorization and hosted-write jobs succeeded. Job evidence records `ownerCommit=true`, `replay=true`, `deniedAdversarialCommands=true`, `primaryPointerAtomic=true`, `productionAccess=false`, `rightsGranted=false`; teardown step succeeded. This is not a deployed hourly replacement. |
| Production business write-owner proof | NOT CERTIFIED | Account, catalog, ingestion, checkout, refund, legal withdrawal, seven backend crons, hourly BioSync publisher, concurrent retries, recovery, exact idempotency, and rollback need protected end-to-end tests on the integrated candidate. No production cutover before all paths work without direct D1. |
| Exclusive physical primary D1 | FAIL | Read-only production Cloudflare Worker settings still show `cove-legal-authority-production/PRIMARY_DB` and `cove-persistence-backend/DB` both bind primary `4bd657ac-8789-403e-a28c-93aba8d0a989`. `COVE_RIGHTS_OWNER_ENABLED=0`. No backend binding removal/redeployment authorized yet. |
| Existing production schedules | PRESERVED, replacement NOT CERTIFIED | `cove-persistence-backend` has exactly seven live cron triggers: `* * * * *`, `*/5 * * * *`, `*/10 * * * *`, `7-57/10 * * * *`, `23 * * * *`, `17 3 * * *`, `41 4 * * *`. BioSync scheduled replacement remains unproven. |
| Scoped Cloudflare credentials / broad retirement | FAIL | Separate Cove QA account has three active scoped tokens (QA D1 Write, QA R2 Write, QA Workers Scripts Write); protected hosted QA used scoped replacements. Production account has 13 active account tokens; the broad **Cove GitHub Deployments** credential is active with ~385 permissions including D1 Write, Workers mutation and token administration. User-token inventory returned HTTP 403, so wider credential exclusion is not proven. Do not revoke until all dependent jobs and deployments work with replacements. |
| Independent legal grant and withdrawal evidence | FAIL — external evidence | Reconcile 87,742 historical grant-audit records and current withdrawals; independently resolve 116 equal-timestamp conflicts and two backdated events, territorially scoped authority, expiry, reinstatements and current owner-denial epoch. Authentic rightsholder authorization, an independently complete withdrawal archive, and adjudicated ordering are required. Quarantine every unsupported claim; no inferred positive grants. |
| Protected full-schema Stripe TEST QA | NOT CERTIFIED ON INTEGRATION | Run full-schema signed-webhook, settlement, entitlement, EPUB/audio/offline, refund, replay/duplicate/retry, withdrawal races and teardown against exact tested candidate; offline PR checks do not substitute. |
| Stripe LIVE end-to-end | NOT CERTIFIED | Real permitted production transaction, refund and revocation with authoritative Stripe and owner evidence require rights/owner clearance and financial safety. Current enabled Stripe account alone does not certify commerce. |
| Catalog/storefront reliability and 500/503 | NOT CERTIFIED | Real-data count/search/facet/filter/sort/pagination/legal eligibility parity; no remaining production catalog, taxonomy, storefront 5xx, complete browser/customer QA. |
| Australian regional EPUB pointers | NOT CERTIFIED | Repair only externally verified object-to-rights pointers; preserve denial/quarantine on conflicts. |
| Protected rollback | NOT CERTIFIED | Rehearse actual pinned Worker/Vercel versions, ownership, writes, withdrawals and entitlements, preserving customer safety and no accidental grants. |
| Performance | NOT CERTIFIED | After all safety gates: cold/warm TTFB **strictly <800 ms**, concurrency **1/4/8/16/32**, two 20-second 100-RPS phases of **2,000 valid responses each**, zero drops, p95 **<600 ms**, p99 **<750 ms**, max **<800 ms**, repeatable ORD/LAX/IAD/DFW. No excluded failures or softened definitions. |

## Actual integrations under review

The draft #850 correction preserves private routing context across first-primary sessions, read-only canonical D1, and commerce-specific D1 wrappers while keeping both raw-SQL denial fences. It also rejects resolved `{ok:false}` receipts and propagates scheduled queue/erasure failures. CI source checks and fresh cross-domain test results, **including on the latest HEAD**, are required before source-merger review. Source tests cannot certify physical writer exclusivity.

## External-only evidence still required

Provide authoritative rightsholder grant provenance, all withdrawals including completeness/coverage and ordering for the disputed cohort, and authoritative adjudication of backdated/equal-time records. Do not substitute D1's historical audit log for independently verified rightsholder authority. Once available, run protected full replay against the then-current owner denial epoch, certify only supported rights, and leave all other titles denied.

## Production safety locks

Production legal owner stays disabled; backend D1 binding and seven cron schedules stay deployed until tested owner replacements and protected rollback exist; broad token remains active only until safely replaceable; retail LIVE flows stay denied. **Any gate marked source-only, isolated QA or NOT CERTIFIED is a release blocker.**

Final decision can be changed to GO only after every required gate carries an exact commit SHA, workflow/job artifacts, production verification, owner/withdrawal provenance and signed release acceptance.
