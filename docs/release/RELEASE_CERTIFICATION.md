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

[User-token audit 45321902989](https://github.com/JibrilMohamud/cove/actions/runs/45321902989) failed with `active_user_token_permission_unreviewed/read_group_alias_identifier_mismatch_unrecognized`. PR #887 adds positive exact-ID evidence from four fixed provider scope catalogs, preserving all unknown/write/malformed/conflicting identity denials. Its source tests are not a real-provider pass. The new protected main-push preflight must independently establish the provider result after merge.

Token-verifier-only changes now trigger only the separately protected metadata preflight. Runtime-critical owner, commerce and capacity changes retain the full protected batch; manual full batches still require all eleven child workflows. Orchestration-only edits require source-contract checks. Completed unchanged hosted QA is retained rather than repeatedly executed for unrelated metadata logic. No omission from a partial provider catalog proves an absent or harmless capability.

## Actual D1-unbound scheduled-operation gap

Configuration of all seven production cron triggers was already verified; that completed work was not repeated. The new `scripts/release/inspect-unbound-backend-crons.mjs` executes the actual backend entrypoint and real private owner handlers against all **95 migrations**, with disposable SQLite and **no native caller DB binding or external network**. It observes the existing strict SQL rejection without bypassing it.

The observed fixture run found these remaining operational writes:

| Cron | Rejected direct SQL categories | Observed task result |
| --- | --- | --- |
| `* * * * *` | Literary and music profile leases | Errors logged; outer task fulfilled |
| `*/5 * * * *` | Public status config, cache cleanup, catalog state | One rejected task |
| `*/10 * * * *` | Soundtrack rights-check claim | One rejected task |
| `7-57/10 * * * *` | Soundtrack ingestion lease | Error logged; outer task fulfilled |
| `23 * * * *` | Author-alert scan state | One rejected task; separate empty account/partner operations returned |
| `17 3 * * *` | None reached in this empty fixture | Audio compute deferred; no real scan proved |
| `41 4 * * *` | Recommendation job recovery | Error caught inside maintenance; outer tasks fulfilled |

This is a **local migration diagnostic**, not managed D1/Worker execution, populated queue coverage, successful production writes or a cutover permit. Fixture session bookmarks are not provider consistency evidence. Every report explicitly sets `scheduledOperationsCertified:false` and `releaseCertified:false`. Empty/no-op tasks cannot satisfy a production business-operation gate. Further populated fixtures and hosted operation proof remain necessary after the missing typed operational paths are implemented. Removing the backend binding now would break legitimate work.

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
