# Commercial readiness: measured work log

## Browsing baseline

Production: https://cove-puce-theta.vercel.app. Evidence: GitHub Actions run
39013724368, successful job 117341404497, 17 October 2026, approximately
07:31 UTC. Raw observations are committed beside this report.

The audit inventories 55 routes and probes 45 guest-accessible paths twice.
All 90 HTTP observations succeeded. Seven journeys were exercised in fresh
and repeat Chromium contexts on desktop and an emulated Pixel 5 with 4x CPU
slowdown and 150 ms / 1.6 Mbps networking. All 28 browser observations passed
without uncaught page errors. Private-account and bearer-link routes need
separate authenticated fixtures; guest shells do not establish their speed.

| Observation                                  |  Baseline | Priority                                 |
| -------------------------------------------- | --------: | ---------------------------------------- |
| Desktop search, fresh-context LCP            | 11,160 ms | High: trace catalog request waterfall    |
| Homepage HTTP first observation              |  7,996 ms | High: variable server response latency   |
| Desktop homepage repeat TTFB                 |  6,732 ms | High: server response latency            |
| Mobile audiobook CLS                         |     0.270 | High: reserve loading layout             |
| Mobile guest library fresh LCP               |  3,984 ms | High: distinguish guest and account data |
| Mobile homepage fresh LCP                    |  2,544 ms | Medium: reduce startup work              |
| Offline asset requests on each fresh journey |         4 | Medium: prepare only on explicit request |

These are individual synthetic observations, **not field percentiles**, nor
a guarantee that server caches were cold or warm. The field targets remain
LCP p75 <= 2,500 ms, INP p75 <= 200 ms, CLS p75 <= 0.1, assessed per meaningful
traffic segment. The two-second post-readiness observation window can miss
later shifts. Reader-frame text readiness is recorded separately from the
parent document's LCP. Automation click-to-next-paint includes harness overhead;
it does not establish field INP. Resource Timing omits opaque/worker traffic,
and encoded JavaScript response size from a worker is not network bytes.

**Instrumentation limitation:** baseline repeat-navigation CPU deltas are
invalid because CDP counters reset at navigation. Exclude those deltas from
analysis. Version 2 records per-document counters directly and adds API
waterfalls and layout-shift source rectangles. Fresh-context CPU profiles
remain available in the original workflow artifact.

## First remediation

- Stop eagerly installing the offline bundle on ordinary browsing. Explicit
  saves and push opt-in prepare the service worker with a bounded registration
  and activation deadline. Existing installations and saved books remain intact.
- Keep the successful-save contract: a book is not reported ready offline
  until the complete public offline reader has been prepared.
- Reserve an audiobook result area with inert placeholders and an accessible
  loading announcement. Preserve real empty/error states and avoid reporting
  a fake zero count while loading.
- Run the public performance workflow after the exact production commit's
  deployment succeeds. Preserve before/after evidence and investigate
  regressions rather than declaring success from bundle size alone.

## Remaining release evidence

This log does not certify the seven-area release complete. Remaining evidence
includes deployed before/after observations, authenticated large-library and
cross-account performance, measured capacity, real-user vitals, complete
reader recovery journeys, grounded discovery coverage/evaluation, playable
and licensed soundtrack quality, supported-locale accessibility, and executed
alert/backup/isolated-restore/rollback drills.

Read-only production inventory earlier this morning found 48,185 products;
37,450 literary profiles (25 analyzed, 37,425 provisional); 2,031 soundtrack
recordings (206 ready, 1,813 pending review, 12 revoked). These statuses alone
do not establish full-text coverage or listening quality. Operations evidence
tables had no recorded backup, restore, or alert-delivery rows; this is an
evidence gap, not proof that provider backups do not exist.

Vercel team observability access currently returns 403. No paid monitoring,
new infrastructure, changed billing, or production restore is authorized by
this work log. Public measurements and existing test infrastructure can
continue independently of that access limitation.
