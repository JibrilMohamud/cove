# Cove release certification — current evidence

**NO-GO for unrestricted production release.** Updated November 23, 2026 (America/New_York). This ledger replaces its stale draft-integration checklist; older observations remain in Git history. It is not a release certificate.

## Integrated baseline and retained passes

The full October writer integration was merged through [#867](https://github.com/JibrilMohamud/cove/pull/867), followed by integrated QA corrections through [#886](https://github.com/JibrilMohamud/cove/pull/886). Runtime evidence below belongs to merged `54009bc47a47960809625e558360e39de215ed99`. Historical draft #850 is its predecessor, not another migration to repeat.

| Protected evidence | Result on integration `54009bc` | Boundary |
| --- | --- | --- |
| Hosted BioSync owner publication/replay | [45321904423](https://github.com/JibrilMohamud/cove/actions/runs/45321904423) passed | Actual isolated synthetic owner commit, adversarial denials and cleanup; not production hourly publisher acceptance |
| Full-schema Stripe TEST commerce | [45321902706, attempt 2](https://github.com/JibrilMohamud/cove/actions/runs/45321902706/attempts/2) passed | Signed initial payment settlement, ledger/outbox, buyer entitlement, EPUB/audio/offline access, refund/revocation, replay, concurrency and actual owner A/B/A rollback |
| Hosted capacity | [45321902326](https://github.com/JibrilMohamud/cove/actions/runs/45321902326) passed | Isolated staging candidate, not four-region production acceptance |
| Protected Worker rollback | [45321902888](https://github.com/JibrilMohamud/cove/actions/runs/45321902888) passed | Isolated QA, not production cutover rollback |
| Historical primary-rights checks | [45321902227](https://github.com/JibrilMohamud/cove/actions/runs/45321902227) passed | Bounded read-only audit, not independent positive rightsholder authority |
| Grant event replay | [45322038363](https://github.com/JibrilMohamud/cove/actions/runs/45322038363) passed | Historical sequence verification, not adjudication of disputed histories |
| Canonical rights differential | [45321902378](https://github.com/JibrilMohamud/cove/actions/runs/45321902378) passed | Synthetic witnesses/canonical-view parity |
| External-source withdrawal audit | [45323130879](https://github.com/JibrilMohamud/cove/actions/runs/45323130879) passed | Bounded source observations, not complete independently authoritative withdrawal history |
| Real-rights spot check | [45323275478](https://github.com/JibrilMohamud/cove/actions/runs/45323275478) passed | Spot comparison, not whole-catalog legal certification |

The commerce run's first attempt stopped on an owner-readiness HTTP 500 **before any payment**. Only its failed job was rerun. Attempt 2 passed and independently verified teardown. Its 32-way native D1 samples were 32/32 valid, maximum 728.89 ms and SQL maximum 5.84 ms. These samples do not constitute geographic or sustained production performance certification. No measured requests or financial mutations were silently retried.

## Physical authority and token verification

[Writer audit 45322445843](https://github.com/JibrilMohamud/cove/actions/runs/45322445843) inspected 465 active Worker versions. It still found two primary binders: disabled `cove-legal-authority-production/PRIMARY_DB` and `cove-persistence-backend/DB`. It also identified three privileged account credentials: `COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN`, `Cove GitHub Deployments`, and `Cove Protected Worker Version Upload`. Exclusivity is not established.

[User-token audit 45321902989](https://github.com/JibrilMohamud/cove/actions/runs/45321902989) failed with `active_user_token_permission_unreviewed/read_group_alias_identifier_mismatch_unrecognized`. PR #887 adds positive exact-ID evidence from four fixed provider scope catalogs, preserving all unknown/write/malformed/conflicting identity denials. The fresh protected main-push audit [45327243998](https://github.com/JibrilMohamud/cove/actions/runs/45327243998) still failed: `read_group_provider_capability_not_readonly`. Provider identity was resolved, but the capability did not satisfy the approved read-only classification. The live provider catalog was then queried read-only and confirmed canonical Read names containing colons and commas. The candidate permits that grammar only after fresh exact-ID and scope verification, while policy labels remain conservatively classified. Adversarial tests retain all write/unknown/malformed/unmatched denials. A fresh protected user inventory is still required; no unknown permission was waived.

Token-verifier-only changes now trigger only the separately protected metadata preflight. Runtime-critical owner, commerce and capacity changes retain the full protected batch; manual full batches still require all eleven child workflows. Orchestration-only edits require source-contract checks. Completed unchanged hosted QA is retained rather than repeatedly executed for unrelated metadata logic. No omission from a partial provider catalog proves an absent or harmless capability.

## Scheduled execution migration — 2026-11-24 candidate

The previous diagnostic on `2215177` found six cron families attempting operational writes through the read-only transport, including swallowed failures. The candidate fixes that shared execution boundary: the D1-unbound backend sends only a fixed schedule and minute slot to the isolated QA owner. The owner executes the existing scheduled business functions against a native handle wrapped with both canonical legal and commerce fences. Canonical mutations still require their original typed commands. No SQL, environment overrides, actor identities or arbitrary job names cross this new RPC.

The private schedule path requires staging, the isolated paid QA primary, US/USD scope, a secret and a maximum 15-minute lease. It explicitly denies production, LIVE Stripe credentials, competing fences and native caller bindings. The native `PRIMARY_DB` is removed from the business environment. Durable per-tick pending/complete/failed receipts prevent concurrent execution and repeated writes following replay or a lost acknowledgement. Failed ticks are not automatically retried.

Local execution now covers **all seven actual entrypoints and 95 migrations** with synthetic catalog fixtures, a populated expired recommendation lease, controlled US/Commons responses and fake audio-trigger acknowledgements. Every positive tick passed and exact replay repeated no writes. A second populated test proves a failing recommendation job remains pending with backoff and produces a failed cron receipt. A third proves missing legal authority and unavailable upstream discovery cannot become successful receipts. Contract tests separately cover wrong credentials, malformed commands, production/expiry/mode denial, domain write fences, concurrent pending requests and lost acknowledgement.

The same change fixes source-observation batch sizing without enlarging the owner's existing 256-KiB ceiling; oversized records are rejected before any chunk is submitted. A status aggregation was rewritten as equivalent nested SELECTs, retaining the SQL fence's CTE prohibition. Negative catalog/maintenance results, minute maintenance errors, status/cache failures and soundtrack discovery failures now propagate to cron receipts.

**This is local engineering evidence.** Regional sources are marked fresh in the positive fixture; fake audio acknowledgements do not prove external audio work. Native Worker/D1 execution, populated customer-operation coverage, production hourly BioSync, legal authority and cutover remain uncertified. No production binding, cron configuration, credential or serving deployment was changed. Existing hosted passes above remain valid for their recorded source; the changed owner/backend candidate requires fresh protected hosted evidence before promotion.

## Current production reliability evidence

Read-only Cloudflare deployment reads before and after a 20-minute analytics query matched backend version `401f2af2-6e69-4611-8110-1d127af6eecf` at 100%, deployment `9df84b20-0599-4fe9-a14e-2c11a4f25133`.

For **2026-11-24 03:55–04:15 UTC** (November 23, 10:55–11:15 p.m. EST), sampled analytics reported two HTTP 200 requests and one **HTTP 500 with one invocation error**, at 04:09 UTC. A cron invocation error was also present at 04:00 UTC. No HTTP 503 appeared in this sparse sample. This does not establish zero-503 reliability, identify the failing HTTP route or root cause, or certify the source candidate. A narrow persisted-log query returned no matching error events; it supplied no exception diagnosis. No customer traffic was generated by these analytics reads.

## Remaining production gates

| Gate | Status / required proof |
| --- | --- |
| Independent legal authority | Genuine territorial/format/channel authority, disputed history adjudication, complete withdrawals and reconciliation with a current independent owner denial epoch remain unavailable. Passing source/replay/spot workflows does not supply those records. |
| Exclusive owner and credentials | Implement and prove every remaining account/catalog/commerce/scheduled writer and the actual hourly BioSync replacement; then activate only legally supported authority, remove competing bindings and retire privileged credentials with rollback coverage. |
| Stripe LIVE | Controlled legally permitted real payment, fulfillment, refund and immediate revocation remain unproven. TEST evidence does not substitute for LIVE. No customer was charged here. |
| Production reliability | Fresh backend failure remains observed. Prove catalog/search/counts/facets/filters/sorts/pagination, protected content and scheduled workloads on the exact serving candidate. |
| Australian EPUB pointers | Repair only independently verified object-to-rights mappings; retain denials/quarantine for unsupported records. |
| Production rollback | Verify pinned frontend/backend rollback with write continuity and preserved withdrawals, refund/revocation state and owner epochs. Isolated QA rollback is retained but does not certify production. |
| Geographic performance | Exact serving candidate must meet ORD/LAX/IAD/DFW cold/warm TTFB strictly <800 ms at 1/4/8/16/32 concurrency, two 20-second 100-RPS phases with 2,000 valid responses each, zero drops, p95 <600 ms, p99 <750 ms and max <800 ms. |

Production legal owner stays disabled, existing backend D1/schedules remain in place, and unrestricted LIVE sales remain denied. These safeguards cannot be removed using synthetic, source-only, no-op or historical evidence.
