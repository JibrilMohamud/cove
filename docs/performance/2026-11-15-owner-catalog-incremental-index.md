# Cove transactional owner catalog index — staging evidence

**2026-11-15 | PR #707 | DRAFT / NOT PRODUCTION CERTIFIED**

## Serving architecture

The index resides in the SAME strongly consistent owner SQLite transaction boundary as
the genuine free, commercial and market authorizers. The owner must obtain *fresh
canonical legal/offer proof from primary D1* and commit that actual authority before
updating any presentation; this PR does not implement the missing canonical positive
production writer. The index cannot manufacture positive authorization.

Source-fence, verified free-offer, paid offer, paid grant/contract/epoch, subject
denial and all prototype presentation-table changes have SQLite triggers that
enqueue affected product IDs. The derived per-product authorized rows and six
preaggregated facet families update by delta inside owner transactions. Reads
refuse all dirty queues. Market tombstones short-circuit every page/count/facet
read with a strongly consistent owner-side veto. Expired paid proofs block reads
until reconciled rather than returning an overinclusive count.

For anonymous, unfiltered US/USD ranked pages, counts/facets are materialized and
page IDs are served by a covering rank index. No request-time primary D1 retail
rights scan is involved. Filtered category, language, format, publisher, series
and min/max price queries use a separate owner-authorized indexed search. Each
facet removes its own filter (OR within one facet, AND across facets); price
facets omit the selected price range as in production.

Filtered results are cached for 30s, keyed by normalized complete supported
filter/page/sort scope and the index generation. Index row mutations advance
the generation transactionally. Dirty state, market status and paid expiry are
checked BEFORE cache lookup. Stale generation entries are not reusable.

## Independent correctness proof

The CI-only fixture uses the REAL owner SQL modules, not an asserted
`allowed=true` result: 12 free + 13 paid products, with current paid
contract versions, grants, retail offers and source fences. An independent
authorization-reference SQL read checks exact count, ordered pages and
categories/languages/formats/publishers/series/availability/min/max price.

Additional independent filtered-reference checks cover 13 filter combinations,
including OR-within-facet, disjunctive self-exclusion, multiple simultaneous
dimensions, mutually exclusive criteria, min/max price, second-page and empty
search results. Tests repeat before and after a paid contract withdrawal and a
global free-source withdrawal, with exact population 25 → 24 → 23. A US market
tombstone gives exactly 0 without stale cached allowances. Unverified metadata
and unreconciled legal changes must fail closed.

Index query plans require the rank covering index. A reproducible standalone
local mechanism-only benchmark inserts **82,249 synthetic indexed rows** and
times 400 warm full default-scope page/count/six-facet/price reads. It does NOT
seed canonical legal authorizations and cannot be used as hosted acceptance.
The first local execution reported: seed ~1201ms, p50 0.167ms,
p95 0.254ms, p99 0.33ms, max 1.991ms. CI reruns this informational script.

A SEPARATE local prototype with 82,249 synthetic products and materialized
multi-value dimensions found a **cold five-facet filtered search suite** required
roughly 461–489ms on that machine. It exposed a significant first-miss
bottleneck; hence the version-fenced cache. This local result is not Cloudflare
TTFB and still needs actual hosted testing and improvements for distinct
high-cardinality queries under 100 RPS.

## Latest revision: owner-transactional FTS5 and timed paid expiry

A real FTS5 virtual table is now updated by SQLite triggers on the SAME
authorized index rows. Inserted legal proofs become searchable only after
owner SQL has confirmed them; revocations and metadata changes delete/rebuild
the FTS rows transactionally. FTS row IDs use an owner-local key mapping, and
the FTS table cannot accept search requests until the initial population is
sealed against the indexed product count. Existing pre-FTS deployments require
an explicit staged backfill/migration before a seal; creating a virtual table
with no rows is NEVER interpreted as full search coverage.

The implemented query grammar is deliberately restricted to up to eight
literal, AND-combined Unicode FTS5 words across title, format, publisher;
unreviewed operators, typo-correction and synonyms are explicitly rejected.
All matches are ranked by the existing stage catalog score, NOT production
BM25/exact-ISBN ranking. Keyword search uses the same category/language/
format/publisher/series and price disjunctive facet path and is keyed by
the complete normalized FTS expression plus the transaction generation.

Regression tests now compare **24** filter/keyword combinations against an
independently built owner SQL answer set before/after contract and free-source
denials. Owner search for unique revoked title terms disappears immediately.
A paid lease is shortened in the isolated fixture, time passes its canonical
expiry, ALL page/count/facet/keyword reads fail closed until bounded
owner-local expiry reconciliation removes precisely that expired book and
its FTS entry. The resulting exact population sequence is
**25 → 24 → 23 → 22 → 0**. The old full snapshot separately becomes
unavailable after the stored paid proof expires; it cannot be treated as
a working fallback. This is evidence for the new selective index, not a
full-product contract.

## 82,249-row FTS5 planner regression (synthetic local SQLite)

A reproducible local benchmark now lives at
`scripts/staging/benchmark-owner-catalog-fts-planner.mjs` and runs as part
of the same staging-only CI. It creates **82,249 synthetic authorized-index
shapes** and a populated FTS5 virtual table. These are NOT real legal-owner
decisions, do not contain production titles, and are NOT hosted Cloudflare
performance acceptance. It asserts exact page equality between rank-first
and forced-FTS-first plans, FTS5 query-plan use, exact document count, exact
aggregate category facets, and immediate FTS disappearance when an index
row is deleted.

Observed on one local Node 22 / SQLite 3.49.1 execution (ms, page p95):

| FTS match population | Rank-first | Forced match-first | Chosen |
| --- | ---: | ---: | --- |
| Unique 1 book | 9.56 | 0.02 | FTS-first |
| Sparse 21 books | 10.21 | 0.05 | FTS-first |
| 2,654 books | 2.43 | 3.92 | Ranked index |
| All 82,249 books | 53.42 | 99.66 | Ranked index |

The default SQLite optimizer can reverse even an explicitly materialized
FTS CTE, so the sparse plan uses `CROSS JOIN` to retain FTS matches as
the outer loop, followed by indexed product-ID lookups. A read-only FTS5
vocabulary lookup estimates the AND query's maximum match population;
it selects the sparse plan when the least frequent token occurs in at most
128 documents. The selection changes the execution plan, NEVER eligibility
or result order. Stage tests assert the actual query plan and differential
count/page/facet results on owner-authorized fixtures.

A keyword whose every literal term appears in exactly the authorized
population can use the already-owned default page, total and precomputed
facet counters. This is an EXACT optimization, not a statistical heuristic:
the owner first checks bootstrap readiness, dirty queue, legal market veto,
and paid proof expiry, then confirms FTS5 document frequency equals the
indexed total. For the synthetic universal word `book`, all 82,249 rows
matched, and the default ranked page p95 was 0.01ms (vs ~53ms for an
unnecessary FTS probe). This is the local page operation only, not end-to-end
TTFB or full production FTS semantics.

**Known cold broad-query risk:** a term matching the entire 82,249-row
synthetic fixture still required approximately 112ms p95 for an uncached
count and 212ms p95 for one uncached category facet aggregation when
no exact shortcut applies. Filtered results are already generation-fenced
for reuse, but cold distinct broad queries and all real facets under 100RPS
remain unproven.

FTS bootstrap verification now fails if an unauthorized or mis-mapped FTS
record has been substituted without changing row counts, or if title,
format or publisher text disagrees with the owner-index source. Stage
regression deliberately injects these bad rows, proves sealing fails,
restores the genuine content, then verifies exact live search.

## Production D1 read-only metadata and FTS contract audit

Production primary D1 read-only queries on November 15 verified:

- 82,247 `products` and `catalog_search_documents` rows.
- Exactly **one** suppressed document, so the main FTS table contains
  exactly **82,246** searchable rows, matching `suppressed=0`.
- **65,924** unsuppressed English-language edition rows, exactly equal
  to the English FTS index count.
- Existing `catalog_search_ai` / `catalog_search_au` triggers
  explicitly exclude suppressed books and keep English FTS limited to
  English-language editions; the 1-book count difference is expected.

The current production FTS5 schema is **NOT the same as this stage-only
index**. Production uses indexed `external_book_id`, title, subtitle,
contributors, series, publisher, ISBN13, categories, keywords and
description (plus unindexed `product_id`), tokenizer
`unicode61 remove_diacritics 2` and prefixes `2 3 4`.
The separate English table uses
`porter unicode61 remove_diacritics 2` and the same prefixes.
This stage proof currently searches title/publisher/format only, uses
plain `unicode61`, a conservative literal-AND grammar and stage rank.
Full search/DTO parity therefore remains BLOCKED until the
canonical publication path reproduces those fields and precise
production FTS semantics, including BM25/exact-identifier ranking and
all filters.

A read-only `COUNT(*)` on the real FTS table took about 7.2 seconds,
versus ~32ms for `catalog_search_documents` on the same D1 sample.
This is NOT a causal proof that catalog 503s arise from FTS counts,
but it prohibits treating full FTS scans as a safe hot-path strategy.
No customer or production records were modified.

## Strict blockers; no relabeling a skipped gate as passed

1. **Full SearchInput parity:** literal stage FTS5 works, but still missing exact production BM25/relevance, synonyms/correction,
   taxonomy, contributor/series/publisher/imprint IDs, ratings/reviews, all other
   sorts, dates/preorder/deals/subscription/library/user-state, all territories,
   production catalog DTOs, all facets/envelope fields, ingestion and public
   pagination semantics. The prototype rejects unsupported scopes.
2. **Authoritative publication:** complete primary-D1 canonical writer needs
   source/offer/scheduled contract and language/DRM evidence, plus index
   fanout and atomic withdrawal-to-reconciliation. Large contract fanout may
   cause temporary fail-closed unavailability.
3. **Proof expiry and money:** selective paid proof expiry is tested locally; scheduled future rights changes, in-flight promotion
   races, LIVE settlement-to-entitlement/protected content/refund/revocation
   remain separate tests.
4. **Performance:** the 25-book isolated hosted owner index already passed
   strict 1/4/8/16/32 and two 2,000-response 100-RPS phases in PR #708
   (p95 75.61/77.62ms, max 320.39/301.70ms, zero drops).
   The FULL 82k corpus, four-colo ORD/LAX/IAD/DFW, actual production SSR
   and zero production 503 acceptance have NOT been shown.
5. **Operational gates:** production owner still disabled; persistence Worker
   and overprivileged deployment token retain physical write capabilities.
   Protected rollback rehearsal remains incomplete.

**No production D1, routes, Workers, Stripe, owner flag, customer records,
entitlements, or tokens were changed.** This stays a draft, and the
releaseCertified field is hardcoded false.
