# Isolated R2 catalog runtime validation — November 14, 2026

**Release remains blocked.** These are functional backend measurements against
the existing isolated 50,000-document D1 fixture, not production catalog or SSR
performance certification. Full samples are in
[`2026-11-14-presentation-r2-stage.json`](2026-11-14-presentation-r2-stage.json).

## Independently confirmed production failures

The production default catalog failed after 11,880 ms application time. Temporary
Worker diagnostics then recorded `D1 DB is overloaded. Too many resources
consumed within a 10 second window` on the following recommendation request.
This explains why even locale/context requests can fail immediately after a
large catalog read. A trivial successful `SELECT 1` cannot certify this path.
The original production observability setting was restored after diagnosis.

Separately, `ops_error_events` repeatedly records `too many SQL variables` for
`/api/fore/recommendations/home`. Its 450–500-candidate primary rights recheck
expanded one parameter per ID, exceeding hosted D1's limit. The independent
fix in PR #666 binds one JSON array through `json_each(?)`. The new fixture
guard reproduces the old failure and preserves complete current-rights
ranking at 99/100/160/450/500 candidates, including stale replica withdrawals.
A read-only production probe rejected the old 450-parameter form and accepted
the JSON form in 0.83 ms SQL with zero writes (nonexistent probe IDs only).

## Deployed candidate and authorization boundary

Candidate source is PR #665 commit `88cf8040` plus PR #666's recommendation fix.
Backend bundle SHA-256 is
`ae212a4e11a82fbf1fdaf7a7e63de594ef7774cbd31a1273615fdc7b3dea35d8`.
The final active candidate version is `55b7a151-fcfe-4d35-8bd7-ad50f31b4860`.

Only synthetic D1 `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3` and dedicated
`cove-public-presentation-stage-20261114` R2 are bound. No production DB,
media, owner, cron or Stripe credential is present. `FORE_ENVIRONMENT` uses
production **read behavior** so development catalog seeding cannot contaminate
the measurements. Customer routing and production catalog flags are unchanged.

The disposable gateway allows only catalog, bootstrap and health GETs after
the existing staging credential gate. It removes supplied identity, country,
public-origin and backend-token headers, forwards provider network metadata,
rejects cookies and writes, and holds no DB/media/owner binding. Missing and
forged credentials returned exact Worker-issued **401**, before backend access.
Source regression coverage is included in the existing R2 persistence checks.

## Actual R2 completion and withdrawal

The first request returned 24 books and a pending lower bound of 25 in 644 ms
application time. A subsequent request returned 24 books with the completed
exact display total of 46,564 and both pending flags false, demonstrating real
background R2 completion. Its application time was 685 ms.

With the R2 facet result still warm, synthetic grant `perf-grant-1` was changed
from active to revoked. The next catalog response excluded
`perf-synth-000001`, included the next ranked eligible book and retained a full
24-book page. The old display total remained 46,564: that presentation cache
did not authorize the withdrawn book. The exact synthetic fixture grant was
then restored and verified. No production right was changed.

## Forced outer-cache misses and remaining latency

The first deployment omitted production's existing guest edge-admission
binding and fell back to durable D1 rate counters. This staging parity gap was
corrected with a separate 180-request/60-second limiter in namespace `731905`;
production's `991731904` and native staging's `731903` counters are not shared.
Source checks now prevent that omission. Both campaigns are retained, with the
parity-corrected campaign used as the final functional result below.

Each request used a unique ignored query parameter to prevent the existing
outer public-response cache from substituting a cached page. Parsed search
filters, the facet partition and current-rights predicates stayed identical.
All offered requests were counted; no failures were removed.

| Concurrency | Valid / offered | Initial, missing limiter | Corrected admission parity |
| --- | ---: | ---: | ---: |
| 1 | 1 / 1 | 374 ms | 522 ms |
| 4 | 4 / 4 | 410 ms | 765 ms |
| 8 | 8 / 8 | 533 ms | 546 ms |
| 16 | 16 / 16 | 793 ms | 781 ms |
| 32 | 32 / 32 | 1,250 ms | 1,140 ms |

These are `cove_api` application durations, **not external TTFB**. Workspace
proxy TTFB is retained separately and cannot certify the geographic release
budget. This 61-request functional campaign is not sustained 100-RPS testing.
Existing public-response caching and non-guest abuse counters still use D1;
the opt-in migration removes facet-cache writes only. Production already uses
edge admission for these anonymous catalog reads. Canonical writer exclusivity
remains independently blocked.

A candidate-only experiment overlapped admitted catalog reads with fresh locale
context. It preserved all denial checks but still reached 1,244 ms at 32 and
1,321 ms at 8. It did not establish a latency improvement and was **removed**.
That experiment preceded the admission binding correction. The remaining
bottleneck requires reducing foreground database work and round trips; this
campaign has not established a strict capacity pass.

The original version was restored through Cloudflare's deployment API; a fresh
post-rollback request returned 200 and 24 books, including the restored fixture
book. This is an isolated code rollback check, not a production rollback
certificate. That rollback preceded the final admission binding correction.
D1 and R2 were not rolled back with code. Both gateway and backend
workers.dev and preview ingress were explicitly disabled after the campaign.

True cold SSR across three fresh deployments, strict external <800 ms at every
concurrency, ORD/LAX/IAD/DFW repeatability, two 2,000-response 100-RPS phases,
production availability, legal/payment certification and production protected
rollback remain unpassed. No threshold or release gate was relaxed.
