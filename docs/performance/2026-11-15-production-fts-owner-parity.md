# Production-shaped owner FTS5 contract — isolated staging proof

**2026-11-15; draft PR #709, stacked on #707. Production release still BLOCKED.**

## What the code actually implements

`src/storefront-strangler/owner-production-fts-mirror.stage.mjs` creates an
**independent stage-only FTS5 mirror** indexed solely from the owner's
already-authorized SQLite product index. It does not read or mutate production
D1, and it never treats a text match as a grant.

The real production primary D1 has 82,247 search documents, exactly one
suppressed document, 82,246 rows in the main FTS table, and 65,924 English
FTS documents matching 65,924 unsuppressed English editions. The source
index population difference is intentional. These facts were observed via
read-only Cloudflare D1 calls, not stage fixture assumptions.

The staged global index reproduces the EXACT 10 production text field order:
`external_book_id`, `title`, `subtitle`, `contributors_text`,
`series_text`, `publisher_text`, `isbn13`, `categories_text`,
`keywords_text`, `description`, preceded by `product_id UNINDEXED`.
Global tokenization is `unicode61 remove_diacritics 2` with prefixes
`2 3 4`. English uses `porter unicode61 remove_diacritics 2` and the
same prefixes. The stage relevance query reproduces production's FTS5
BM25 weighting `0,14,11,12,10,8,4,14,4,3,1`, exact external identifier,
ISBN and title prioritization, followed by STAGE rank tie-breaks.
The last tie-breakers do NOT yet match all real merchandising scores.

Production's **independent storefront visibility** predicates are enforced:
`suppressed=0`, `storefront_status='active'`,
`source_name<>'upload'`, and `release_status IN ('available','preorder')`.
These are necessary but not sufficient; a matching product also MUST have
an owner-authorized row and must pass a fresh synchronous owner read guard.
The separate English table includes only rows with `language_code='en'`.

Source metadata is not allowed to produce a searchable positive by itself.
Triggers on source metadata and owner index changes update both FTS tables
together with a consistent rowid mapping, including legal withdrawal and
expiry. There is no KV/R2 presentation permission or eventual consistency.

The initial explicit seal checks *full document coverage*, product-ID
mapping, all 10 search fields, English membership, missing source metadata,
orphan mappings, suppression, release eligibility and exact row counts.
A failed integrity reseal **resets the previous readiness flag**, preventing
the old FTS index from serving further stage reads until clean migration.

## Verified test scope

- `scripts/staging/check-stage-production-fts-mirror.mjs`: standalone
  Node SQLite test of tokenizer/diacritics, Porter stemming, identifier
  matching, English inclusion, full-text fields, suppression, unauthorized
  metadata, inactive/upload/draft exclusion, preorder acceptance, stable
  owner-bound deletion, tamper rejection, and fail-closed reseal.
- `scripts/staging/check-owner-catalog-incremental-index.mjs`: actual
  canonical free, paid and market SQL fixture. With FTS mirror enabled,
  proves 25 -> 24 -> 23 -> 22 -> 0 authorized products following contract,
  source, paid-proof expiry and market withdrawal. Staging keyword deletion
  is checked after each transition.
- The filtered stage FTS returns count, page IDs and the same seven facet
  *shapes* as the production API: disjunctive categories, languages, formats,
  publishers, series, availability and price. It compares self-excluding
  filter behavior, combined category/price/language/format filters, and
  post-ACK denial semantics against owner-index fixture truth.

GitHub's dedicated `cove-stage-production-fts-parity` workflow executes
both the stand-alone and integrated source contracts without mutating
production. A passing workflow certifies **this stage subset only**.

## Release blockers that are NOT hidden by a passing stage test

1. The real 82,247-row production corpus has NOT been imported and verified
   into the authoritative owner index. The new stage metadata is a fixture,
   not a canonical primary-D1 positive writer or ingestion pipeline.
2. Many real SearchInput filters (taxonomy, contributor IDs, publisher/series
   IDs, rating/review thresholds, subscription/library channels, dates,
   preorder/deals/new releases), every non-relevance sort, production
   synonyms/typo correction and exact production BM25 tie breaks remain
   unsupported and MUST fail closed.
3. Search returns stage page IDs/count/facets, not the complete CatalogBook
   DTOs or nine-field public response envelope.
4. Cold high-cardinality FTS filters, real 82k catalog capacity, four-region
   strict <800ms TTFB, 2x2,000 response 100 RPS and production zero-503
   acceptance are not shown by this branch.
5. Exclusive D1 writer authority, the enabled production legal owner,
   Stripe LIVE paid-to-revoked certification, and protected rollback remain
   independent BLOCKED launch gates.

**No production routing, Worker scripts, D1 records, API tokens, owner flags,
Stripe money or customer entitlements were changed by PR #709.**
