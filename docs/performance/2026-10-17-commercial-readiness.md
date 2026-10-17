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

## First deployed comparison

Commit 4b283c3f53997cd2a0dc6d08cf772494ec9b1b68 was measured after its
deployment succeeded, in Actions run 39015091262 (artifact 12094572248).
The 07:53 UTC browser observations and preceding route observations are
committed alongside the baseline. All 28 browser and 90 HTTP observations
succeeded. These are sequential runs with substantial backend/cache variance,
not a randomized experiment or proof of causal LCP improvement.

| Observation                                         |    Before | First deployed fixes |
| --------------------------------------------------- | --------: | -------------------: |
| Fresh-context offline asset requests, every journey |         4 |                    0 |
| Mobile audiobook CLS, both observations             |     0.270 |                    0 |
| Desktop fresh search LCP                            | 11,160 ms |             7,804 ms |
| Desktop fresh homepage LCP                          |  1,452 ms |             1,632 ms |
| Mobile fresh homepage LCP                           |  2,544 ms |             2,568 ms |
| Mobile fresh book LCP                               |  3,100 ms |             6,768 ms |
| Mobile fresh book CLS                               |         0 |                0.221 |

The book-page regression was traced to its footer moving from the small
loading area to below the viewport when details arrived. The next fix reserves
a complete loading region and prioritizes the main cover. Slower responses
remain visible in the report: desktop search's context/account/page/taxonomy
calls overlap at roughly 4–5 seconds, with catalog finishing after 7 seconds.

Account bootstrap now follows identity resolution directly, without unrelated
storefront locale/payment queries. Its existing ownership and entitlement
filters remain in the account implementation. Tests reject any attempted
storefront configuration lookup for guest and authenticated account bootstrap.
Guest UI context is cached for 30 seconds under the existing country/language/
preference partition, with authenticated/session requests bypassed. Commerce
and rights endpoints still resolve live legal state independently. Five-market
tests exercise actual misses, hits, selected language payloads and bypasses.

Book-detail query identity now includes reader, country, locale and currency;
obsolete requests cancel. The lab additionally records content readiness so
a fast header paint cannot be mistaken for fast result availability.

## Heavy personal library

The 5,000-book synthetic fixture exposed a distinct query-plan problem. The
old active-entitlement index scanned a reader's entire active set while checking
each library row. Migration 0073 adds an entitlement covering index keyed by
reader and product, and a stable reading-state page index including the product
tie-breaker. The change is additive and compatible with the previous app; a
code rollback can leave the indexes in place.

In a same-database, same-query comparison on 17 October at 08:05 UTC, the
101-row lookahead query took 2,672.2 ms before indexes and 0.4 ms afterwards,
returning exactly equal ordered rows. These single local SQL observations are
not production D1 latency claims. The plan now seeks the product entitlement
through a covering index and avoids the temporary page-order sort.

Library hydration uses at most two bounded metadata queries for 100 books,
with an independent personal-import ownership predicate. The lookahead row is
not returned as a replacement for an unavailable row, preventing duplicates
on the next offset. The executed fixture returns 4,997 eligible books across
50 pages from 5,000 stored records: a foreign import and two expired/revoked
entitlements remain excluded; the reader's own private import remains visible.
The local application API page p95 was 14 ms in that run. Production network,
concurrent capacity and authenticated device timings remain to be measured.
The fixture, exact ordered-row equivalence and query-plan checks are required
by the existing large-library security CI step.

Request-local API `Server-Timing` now exposes numeric identity, storefront
context, logging and total-handler durations. The browser lab records these
alongside API resource waterfalls. No SQL, identities, country, locale, URL
query, credentials or book content enter the timing values. This provides a
way to distinguish slow backend work from proxy/network time while Vercel
team observability access remains unavailable.

## Production catalog membership query

Read-only D1 profiling found that the DISTINCT retail-rights view becomes a
catalog-wide coroutine inside a correlated EXISTS. A 25-book popular shelf
read 421,425 rows and took 477.6 ms of SQL time. Removing the DISTINCT boundary
for membership checks, while retaining every live legal predicate, returned
the same ordered 25 products with 225 rows read in 7.1 ms. The full count still
requires a catalog scan: 43,754 matching products took 754.9 ms before and
721.5 ms with the candidate rewrite. Those measured SQL times exclude network
and rendering and are not whole-page performance claims.

Migration 0074 exposes a flattenable live membership view and preserves the
existing DISTINCT retail view as its wrapper. Search uses membership only in
EXISTS; all other consumers retain the original public view contract. Popular
shelves use the stable catalog index as the outer loop. No rights rule is
relaxed, and duplicate grants cannot multiply results inside EXISTS. Tests
compare membership against both the original retail contract and the separate
generic channel authority as grants, denials and DRM change.

At 08:10 UTC the provider returned a current D1 Time Travel bookmark and
recognized a requested point one hour earlier. This verifies available provider
checkpoints, not an executed production restore, retention guarantee or measured
production RPO/RTO. The account currently has no Vectorize indexes; no semantic
index or new infrastructure was provisioned by this release.

## Diagnostic writes outside response latency

The deployed phase timings then identified a guest account response with
1,712 ms spent entirely in diagnostic logging. The Worker now passes its
existing execution context into the API. Request logs and storefront-context
diagnostics retain their lifetime with `waitUntil` and no longer block the
response. Runtimes without a lifetime mechanism continue to await the writes.
Authentication, rights checks, reading progress, notifications and all product
mutations remain awaited. A held-write regression proves that Worker responses
finish before diagnostics, the retained work later persists, and the fallback
runtime still waits. Queued-log timing is labelled as queued rather than
reported as zero database execution time.
