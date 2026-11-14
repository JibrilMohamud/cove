# Catalog single-snapshot and D1 cache isolation campaign

**Release remains unapproved.** This November 14 follow-up measured the real
backend against the isolated 50,000-document D1 fixture and actual R2. The
[complete samples](2026-11-14-catalog-single-snapshot.json) retain every variant,
including the intermediate tail regression. Production flags and routing stay
unchanged.

## Changes with preserved authority

1. A materialized 96-ID popularity seed now lives inside the same primary SQL
   statement as the original current-rights predicates. This removes a complete
   database service round trip and 96 ID parameters. Ordering, all product and
   territory filters, the 25th-book Next witness and sparse full-query fallback
   remain exact. SQLite plan tests prove materialization, stable index ordering
   and bounded product-ID seeks.
2. The opt-in R2 path skips the unused legacy D1 search-page lookup. The outer
   public-response cache also bypasses that same explicit guest/public/filter
   scope, removing a second lookup and its background three-statement D1
   prune/upsert transaction. The original deferral predicate is shared rather
   than widened. Ordinary, filtered, account and non-opted-in caching stays on
   its existing path.
3. Cookie-free R2 catalog requests use the existing single-statement anonymous
   market/locale/payment/translation snapshot. Preferences and accounts retain
   their complete resolver. The actual outer cache and API-handler integration
   test proves one admission call, current primary rights, zero D1 cache reads
   or cache writes, one metadata statement, and preference-aware fallback.

The 34 protected canonical mutation SQL identities and containing functions
(33 API, one search) are unchanged. Their existing review dispositions were
preserved after source review; this retires no canonical writer and grants no
production owner approval.

## Bounded read-only production SQL proof

A single bounded read of the new production-shaped shortlist SQL against the
real production primary returned 25 eligible IDs in **11.9 ms SQL**, reading
**346 rows** and writing **zero**. This verifies the query on real data; it
does not measure frontend/Worker/external latency or prove the complete
production catalog endpoint. No production rights or credentials changed.

## Hosted application measurements

Each variant offered one wave at 1/4/8/16/32 concurrency. Every variant returned
61/61 valid 24-book responses. Unique ignored request parameters prevented old
outer response-cache hits during comparisons. The final code explicitly
returned `BYPASS` for all samples while reading the R2 facet projection.

| Variant | Max at 1 | Max at 4 | Max at 8 | Max at 16 | Max at 32 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Prior admission-corrected candidate | 522 | 765 | 546 | 781 | 1,140 |
| Single primary shortlist statement | 359 | 411 | 415 | 441 | 788 |
| Plus inner D1 cache bypass | 359 | 387 | 319 | 529 | 842 |
| Plus outer D1 cache bypass | 510 | 495 | 336 | 498 | 663 |
| Plus combined anonymous context | 321 | 327 | 275 | 491 | 639 |

All durations are **milliseconds of `cove_api` application time**, not external
TTFB. The final 32-request application p95 was **637 ms**, maximum **639 ms**;
all 61 samples were retained. The intermediate 842 ms result is included rather
than discarded. These sequential, proxy-transported runs are diagnostic, not a
randomized geographic comparison or a sustained 100-RPS release test.

The candidate still records HTTP operation metrics through its isolated D1;
production already sends successful anonymous metrics to Analytics Engine.
That telemetry binding/flag parity must be completed before a production-shaped
100-RPS campaign. The cache-write assertions concern `api_cache` only, not all
noncanonical telemetry writes.

Final backend SHA-256:
`6dab1e935e6eea53c533669cdb93484f736aa15f0799521e690dbd8a2c1cc08f`.
Final active version: `0eda9e87-bf61-4616-9634-b8175d4ffa08`.

## Withdrawal, rollback and cleanup

With the R2 facet result warm, the synthetic grant for `perf-synth-000001` was
revoked. The next ordinary catalog request returned 200 and 24 books in 223 ms
application time, excluded that book and included the next ranked eligible
book. Its R2 total remained 46,564 and both pending flags remained false. The
synthetic grant was restored; no production grant was changed.

The candidate was rolled back to `3da1f2f7-72a9-40db-a5f8-0d54d80d4e2f`, which
returned 200/24 books. Restoring the final version also returned 200/24 books
including the restored fixture book. This is isolated code compatibility
evidence, not a production protected-rollback certificate. Both Workers'
workers.dev and preview ingress were then disabled.

The remaining acceptance work is real-catalog serving without renewed primary
facet pressure, true cold SSR across three fresh deployments, strict external
TTFB at every concurrency, ORD/LAX/IAD/DFW repeatability, two complete 100-RPS
phases, and the independent production owner/payment/writer/rollback gates.
No performance threshold or authorization gate was relaxed.
