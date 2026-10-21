# Regional EPUB keyset query service-time regression (2026-10-20)

**Root cause discovered in real production D1, read-only:** the backfill
candidate selector, despite `LIMIT 4`, was planned from
`idx_products_source` and used a temporary B-tree for `ORDER BY c.id`.
A single first-page sample read **149,396 D1 rows**, requiring
**4,280.0255 ms** of D1 SQL service time to return four AU candidates.
No writes were performed. This query is emphatically **not safe** for
production backfill until optimized.

Changing only the join order with `CROSS JOIN` was insufficient: the engine
chose the source rights queue index and sorted, or when explicitly forced to
the primary key but using an empty cursor, still scanned unrelated US catalog
keys. A forced primary-key lookup from the beginning returned the same
four candidates in **2,181.7426 ms**, reading 60,459 rows.

The release candidate fixes both effects:

1. Validate the operator-supplied cursor before any normalization.
2. Floor the first cursor at `pga`, which precedes `pgau_...`,
   `pgca_...` and `pgeu_...`, while excluding unrelated `pg_...`
   US Gutenberg keys.
3. Drive the scan from `gutenberg_source_cache` first by the explicit
   primary-key index, using `CROSS JOIN products` to preserve that order.
4. Keep all live source approval, active territorial grant, R2 object SHA,
   content-type and admission checks, with `ORDER BY c.id LIMIT ?`.

**Read-only D1 result of the corrected query plan:** exactly the same
four candidates, **20 rows read**, **0.7925 ms SQL time**. EXPLAIN showed
`SEARCH c USING INDEX sqlite_autoindex_gutenberg_source_cache_1 (id>?)`,
matched product and asset indexes and indexed rights-grant lookup, with
**no temporary sort**.

| Query | D1 SQL time | Rows read | Same first four AU IDs |
| --- | ---: | ---: | --- |
| Original production candidate SELECT | 4,280.0255 ms | 149,396 | Yes |
| Forced key index but empty cursor | 2,181.7426 ms | 60,459 | Yes |
| Key index + regional cursor floor | **0.7925 ms** | **20** | Yes |

This is one production-backed A/B comparison, not a statistically repeated
latency distribution or an end-to-end endpoint TTFB benchmark. The timing
is **D1 SQL service**, not full Worker wall-clock/network time. It does
not validate R2 HEAD/write operations or transaction-time D1 queueing.

The regression suite must enforce the keyset access path. A schema change
that renames/removes the index should fail the select rather than silently
falling back to an expensive full scan; update the query only alongside
measured migration evidence.

Before any production pilot, still require a current first/last page EXPLAIN
and headroom check under customer mixed load, exact rights validation,
protected object verification, one-batch journal and rollback. Production
backfill remains disabled.
