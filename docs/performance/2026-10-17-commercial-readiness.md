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

## Follow-up release: startup, context and recovery

The selected language catalog now travels with the existing server locale
context. All 801 phrases are checked against their original five catalogs,
including interpolation and fallback. English sends only its non-identity
translation (32 JSON bytes); other locales send their own catalog. In the
initial follow-up production build the shared sheet chunk fell from 417,930
raw / 135,376 gzip bytes to approximately 167,730 / 55,050 bytes. These are
build measurements, not deployed transfer or field performance improvements.

Audiobook and soundtrack query identity includes reader and rights context.
Soundtrack requests cancel when obsolete, changing readers/books clears prior
tracks, and an unchanged recording at a chapter boundary explicitly restarts
the ended player. Browser transport is mocked in this regression; it does not
establish the perceptual quality of a soundtrack.

Discovery controls and messages now have five-language labels. A deliberately
small vocabulary of common translated theme tags and time-limit operators
maps to canonical indexed evidence. End-to-end retrieval verifies a translated
friendship request and war exclusion against seeded profiles. This is an
improved exact-tag baseline, not semantic embeddings or arbitrary LLM intent.

Operational delivery now reclaims abandoned alert leases, bounds each transport
to ten seconds and each serving batch to twenty seconds, supplies a stable
idempotency key, and fences late completions by lease/attempt. Controlled
receiver tests exercise success, retries, backoff, exhaustion, malformed
payloads and overlapping workers. No production recipient was contacted.
Backup registration retries preserve the actual stored artifact identity.

An executed physical SQLite backup/restore drill used a completely isolated
synthetic database, checked integrity and foreign keys, then exercised the
actual application API: 5,000 private notes recovered across 50 bounded pages,
no duplicates, and another reader saw only their own note. On the local run
at 07:51 UTC, page p95 was 10 ms and restore plus application probes rounded
up to one second. Expired queue work was reclaimed and the stale worker was
rejected. These local measurements exclude production networking, D1 capacity,
provider recovery, backup retention, production rollback and real-data RPO/RTO.
The alert and restore drills are now required in security CI.
