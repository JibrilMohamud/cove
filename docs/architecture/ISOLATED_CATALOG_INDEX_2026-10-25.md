# Cove isolated catalog-index groundwork (2026-10-25)

**Release status: staged only; not a complete canonical normalization cutover. No production switch is enabled.**

## Why

The primary D1 still executes roughly thirty commercial normalization statements
per changed Gutenberg source item, including joins, FTS triggers and derived
index updates. Scheduled catalog sync and lazy book requests also run these
statements in the same domain that performs live legal/offer checks. A 1s+
D1 service queue cannot be fixed reliably with HTML or LCP tuning.

## New boundaries

```
canonical source catalog D1 (rights remains authoritative)
  -> append-only lightweight changefeed (source id + monotonic sequence only)
  -> read-only bounded capture Worker (flagged OFF)
  -> independent catalog-index D1 (normalization, metadata and FTS)
  -> [future: isolated candidate publication / search adapter]
  -> live primary D1 rights and offers check on every display/checkout/delivery
```

No customer identity, rights grant, offer, price or entitlement is copied to
the independent index. Even a missing, delayed, or obsolete index document
cannot authorize an acquisition. Immediate withdrawals are enforced by the
existing live primary authority, independent of catalog-index replication.

The migration introduces a light trigger on *source changes*, not a second
FTS or per-title graph rebuild on primary. Repeated download-count-only
heartbeats do not enqueue expensive text indexing. A `DELETE` creates a
tombstone. Publication on the independent DB uses a strict increasing revision
condition, so delayed writes cannot restore a withdrawn document.

The independent Worker takes a bounded lease, resumes a keyset backfill,
then processes at most sixteen changefeed events per run. Writes are revision
fenced; feed cursor advances only after successful writes and while its
lease is still held. Retried batches are idempotent. Disabled by default,
service-binding only: **no public HTTP route, no cron, no production write**.

## Apply / measure (not automatic)

1. Provision a genuinely separate D1 for `infra/catalog-index/0001_isolated_search.sql`.
2. Backfill in a sandbox with scrubbed source rows. Check schema identity and
   compare candidate IDs, text, languages, and deletion behavior against the
   existing canonical catalog.
3. Use `wrangler.catalog-index.example.jsonc` only as an operator template:
   replace IDs and put the worker behind a private service binding; enable
   `COVE_CATALOG_INDEX_CAPTURE_ENABLED=1` only during controlled tests.
4. Apply the primary changefeed migration in a controlled D1 maintenance window,
   measure trigger write overhead, and validate sequential changefeed coverage
   under live source updates, deletes, lease loss and replay.
5. Establish an isolated producer/publisher for all **derived** search and
   taxonomy indexes, with fresh authoritative on-display legal checks. Gate
   its deployment on no loss of candidates, no rights leaks and replay safety.
6. Move the **bulk canonical metadata normalization owner** away from primary
   only once a new schema + small, fenced, versioned canonical publication
   interface exists. The present `commercialCatalogStatements` still run
   against primary and must NOT be disabled while that publication interface
   is absent: doing so would silently break rights and purchases.
7. Separately measure D1 service vs SQL time at cold and 100 RPS under actual
   ingestion and comparison traffic; require 3/3 cold runs, 2,000/2,000 valid
   results per 20s 100 RPS phase, p95 <600ms, p99 <750ms, and max <800ms,
   plus mobile p75 LCP comfortably <2.5s. A local unit test is not proof.

## Safety invariants

- No independent index document can issue a legal grant or entitlement.
- Tombstones and later restorations advance revisions; stale workers cannot
  replace newer isolated metadata, including across retry after lost ACK.
- The primary, not this isolated index, is the final arbiter for country,
  currency, offer, purchase and protected reader delivery.
- An absent independent source or disabled worker must never trigger a
  catalog-wide synchronous fallback from a visitor request.
- Do not merge a canonical writer cutover without real crash/replay tests,
  mixed-traffic cold-tail acceptance, and withdrawal-in-flight adversarial QA.
