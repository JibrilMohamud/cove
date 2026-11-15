# Real primary-D1 search metadata read-only parity boundary

**2026-11-15 · draft PR #710 · READ ONLY · PRODUCTION NOT CERTIFIED**

## Purpose
Provide the first safe full-corpus input to the owner-authorized catalog migration:
**observe** real search metadata without ever creating legal permission.
Read-only primary-D1 metadata does not prove that a book may be published,
sold, downloaded, or shown in the store.

The CLI and library NEVER send INSERT/UPDATE/DELETE to primary D1, never write
R2/KV, never construct an owner authorization record, and never change
production routes, legal-owner flags, Stripe objects or customer state.

## Grounded live production baseline (READ only; observed Nov 15)

- `products`: 82,247
- `catalog_search_documents`: 82,247
- suppressed rows: 1
- expected main FTS: 82,246 (verified by a separate live read)
- unsuppressed English editions: 65,924
- expected English FTS: 65,924 (verified by separate live read)
- latest observed document watermark:
  `2026-11-15T21:30:33.006Z`

A live D1 two-row query confirmed each field and type in the
keyset-paging SELECT. Count consistency does NOT prove row-by-row parity.

The real production Vercel integration continued recording multiple 503
warnings after 22:02 UTC Nov 15 on catalog, taxonomy, context and homepage.
**Do not run bulk live export under an uncontrolled cadence or connect the
metadata mirror to customer routes during this incident.**

## New independent audit library

`src/storefront-strangler/production-catalog-metadata-readonly.stage.mjs`

1. Requires the exact approved Cloudflare account and production D1 IDs and
   a **read-only credential**; all SQL statements must be an explicitly
   reviewed SELECT without semicolons or mutation keywords.
2. Reads count, suppressed-English and three source watermarks before and
   after streaming; keyset pagination uses `d.product_id > ?`,
   `ORDER BY d.product_id`, at most 500 rows per call, with strict
   duplicate/order/type/completeness checks.
3. Rebuilds two **metadata-only** FTS5 indexes in an ephemeral in-memory
   Node SQLite database with the production global and English tokenizers,
   prefix configuration and ten searchable text fields.
4. Checks the exact live expected main/English FTS populations and
   compares fixed full-text MATCH count probes independently with the
   primary D1; any difference fails closed, rather than marking parity.
5. Stores no source metadata on disk, GitHub Actions artifacts, external R2,
   KV or public logs. Emits only document counts, source-hash SHA256,
   observed source watermarks, and aggregate query-population checks.
6. Its report explicitly carries `authorizedProducts:0`,
   `productionOwnerEvidence:false`, `atomicPrimarySnapshot:false`,
   `fullSearchInputParity:false`, and `releaseCertified:false`.

**Important:** Independent D1 requests are not one atomic snapshot.
Even equal counts and three source watermarks do not prove a serializable
snapshot if writes race an export. This observed full read is only a
metadata audit, not legal-catalog release certification. A future
transactionally versioned canonical owner publication feed is required.

## Verification

`scripts/staging/check-production-catalog-metadata-readonly.mjs` runs
offline, without network access or production credentials. It reconstructs
a nine-book fixture, compares both real FTS5 tokenizer engines and exact
keyword counts, and proves that five malicious/incomplete cases fail:
source watermark drift, missing page, duplicate product, missing field,
and mismatched remote FTS result. SQL mutation and wrong account are denied.

GitHub workflow `cove-stage-real-catalog-readonly` always runs this offline
contract when its isolated branch changes. The full 82k scan is *manual
only*, requires `READ_ONLY_AUDIT`, a protected environment, and
`COVE_CF_PRODUCTION_AUDIT_READ_TOKEN`. There is no background monitor
and no automatic production D1 scan.

## Stage presentation import, explicitly ZERO owner grants

The full-metadata scan now inserts verified keyset records into the
`cove_stage_owner_prod_search_source` staging presentation table used
by draft #709. The strongly consistent owner authorization table is
created **empty** and is NEVER populated by this importer. Both
owner-visible FTS5 projections must therefore have exactly zero rows,
even if all 82,247 real metadata rows import successfully. The
stage migration seal and an actual indexed search check verify zero
authorized products; any positive search result fails the run.
The data is held only in the CI runner's in-memory SQLite database and
is not published as a GitHub artifact or an external file.

The offline nine-document fixture verified this handoff and the
zero-grant invariant. This is a critical distinction: a complete
production search document is NOT sufficient evidence for rights,
contract, territory, time, channel, DRM, license or current offer.

## Small, independently executed real D1 smoke read

A read-only source probe requested four sequential keyset pages
(100 records each) and received **400/400** records in increasing
product-ID order. There were **zero** missing columns or
duplicate/unsorted identifiers. Aggregate D1 query execution time was
**36.59 ms** across four calls (not request TTFB or 100RPS capacity).
The sampled maximum title/description length was 2,006 characters.
A separate 82,247-row read-only aggregate observed the maximum
production description length as 4,453 characters, below the staging
mirror's 10,000-character per-field safety limit.
The small smoke did NOT claim full 82k row parity or legal authorization.

## Remaining release gates

1. **Canonical legal decisions:** actual paid/free writer publishes rights,
   contract version, source revision, market, language, DRM, scheduled
   changes and offers; only then may an owner index publish a positive book.
2. **Full SearchInput and DTO:** real catalogs need all filters/sorts,
   disjunctive facets, typo/synonym corrections and exact CatalogBook /
   API response envelope parity. The current #709 production-shaped FTS
   is still a staging subset.
3. **Live incident:** actual Vercel catalog 503s and D1/Worker read tail
   are not fixed by a read-only metadata audit.
4. **Hosted release:** <800ms max strict concurrency, two 2,000-good
   response 100RPS phases, four-colo ORD/LAX/IAD/DFW, zero drops and
   protected rollback on the real production-equivalent full catalog.
5. Exclusive physical owner/write privileges and Stripe LIVE
   settlement-entitlement-protected-content-refund-revocation remain
   unverified and BLOCKED.

**No production changes or grants were made.**