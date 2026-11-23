# Cove: unified owner Durable Object capacity investigation (2026-11-15)

**Release status: BLOCKED.** This is a diagnostic staging proof, not production certification. Never route customer catalog reads to this fixture, enable the production owner, or remove production D1 writers based on this document.

## Evidence-based architecture decision

Repeated primary-D1 request paths cannot yet satisfy Cove's **hard maximum TTFB <800 ms** despite sub-millisecond SQL:

| Experiment | Scenario | Records queried | SQL on worst request | Maximum TTFB | Outcome |
|---|---|---:|---:|---:|---|
| [#699 run 43733794250](https://github.com/JibrilMohamud/cove/actions/runs/43733794250) | 100RPS phase 2, 50k indexed fixture | 25 | 0.383 ms | **944.91 ms** | FAIL |
| [#701 run 43736820402](https://github.com/JibrilMohamud/cove/actions/runs/43736820402) | 50RPS, 50k indexed fixture | 1 | 0.227 ms | **1450.2 ms** | FAIL |

Both were real hosted D1 requests to synthetic isolated D1. The slowest Worker's non-SQL spans dominated. Do not certify SQL-only tuning, one-row D1 reads, or eventually invalidated KV/R2 allowances from average-case SQL timings.

## Two independent passing unified-owner DO campaigns

[Draft PR #702](https://github.com/JibrilMohamud/cove/pull/702) exercises the **same imported production free, paid retail and market-denial SQLite core functions** used by the real legal-owner route, in a fresh **isolated SQLite Durable Object** (NOT the production Worker class). The request path is Worker -> private DO stub -> strongly consistent SQLite authorization -> response. It never touches primary D1, production data, customer routing, live payments, or real legal rights.

The fixture consists of exactly **12 fabricated free + 13 fabricated paid** proof records. The 13 paid proofs use exact owner grant/contract/contract-version/price and expiry joins. The 12 free proofs use owner revision-fenced grants. Every read verifies all 25 product IDs and USD 0/599 prices. The stage supports only a 15-minute secret-gated lease with no production or shared-QA D1 binding and no customer route.

| Workflow | 1/4/8/16/32 bursts | 50RPS max | 100RPS phase 1 p95 / p99 / max | 100RPS phase 2 p95 / p99 / max | Valid / drops |
|---|---|---:|---:|---:|---|
| [43740985547](https://github.com/JibrilMohamud/cove/actions/runs/43740985547) | PASS | 232.17 ms | 56.33 / 81.34 / **212.06** ms | 56.58 / 102.06 / **228.81** ms | 4000 / 0 |
| [43741047041](https://github.com/JibrilMohamud/cove/actions/runs/43741047041) | PASS | 336.28 ms | 58.16 / 81.04 / **230.71** ms | 56.54 / 81.72 / **183.40** ms | 4000 / 0 |

Each 100RPS phase offered exactly 2,000 requests over 20 seconds, with zero invalid responses or generator drops; same-run 5RPS no-DO ingress shadows also passed. All five concurrency bursts were below 800 ms. These measurements are from a CI runner's external network location, **not the four required colos**.

The fully separate post-load correctness checks also passed: contract withdrawal reduces allowed records 25 -> 24, global free-source withdrawal 24 -> 23, stale positive replay stays denied, and a market tombstone reduces availability to 0. Each temporary Worker was verified removed after its run. No source release authority or payment authorization was minted.

## Mandatory release gates still blocked

1. **Real canonical owner, legal rights and correctness**: run the actual `CoveLegalAuthority` class with genuine D1-verified product/edition/contract/version/language/DRM/offer/current-epoch evidence in **isolated private QA**, prove immediate source/contract/offer/market withdrawal and all scheduled transitions, and reproduce 25 mixed legal decisions with differential checks. Proofs may not be invented from R2 presentation bytes. Keep production `COVE_RIGHTS_OWNER_ENABLED=0` until certified.
2. **Exclusive production writer**: enumerate, retire and independently verify every competing production D1 write binding/token and prove owner-first denial for every mutation family; staged mock proofs cannot substitute for physical writer retirement.
3. **Actual storefront/catalog contract**: integrate the owner-authorized read into the complete real product/search/count/facet/filter/page-number/cursor/9-field envelope + full book-detail parity. Keep untrusted R2 presentation separate from legal permission. Fail closed on legal owner outages.
4. **Hosted performance across geography**: eliminate real customer-facing SSR/catalog 503, then strict cold/warm 1/4/8/16/32 TTFB <800 ms and *two* 100RPS x20s campaigns in ORD, LAX, IAD and DFW, with p95<600ms, p99<750ms, max<800ms, zero errors/drops. Repeat across deployments and legal mutation churn.
5. **Payment and rollback**: independently certify Stripe LIVE webhook -> settlement -> entitlement -> protected EPUB/audio -> offline access -> refund/chargeback -> immediate revocation. Rehearse a physical protected traffic rollback with owner/writer invariants unchanged.

**Implementation order**: real QA owner contract/differential proof -> owner SQL read integration and full catalog parity -> no-503 cold/warm regional acceptance -> exclusive writer/legal activation -> LIVE payment and controlled rollback. Do not merge research-only performance PRs directly into production traffic merely because a benchmark passed.


## Actual production D1 read-tail attribution (read-only, 2026-11-15)

After the synthetic DO pass, investigate the **separate real customer catalog 503** directly instead of projecting the synthetic success onto the full production site:

- Vercel production runtime logs showed repeated `Persistent backend unavailable; production catalog fails closed 503` for `/`, `/api/fore/catalog`, `/api/fore/taxonomy`, `/api/fore/storefront/context`, `/api/fore/storefront/page`, and `/api/fore/storefront/bootstrap`. Most were tagged `worker-api pre-context handler-exception`, some `worker-api post-context catalog-rights`. The pre-context label does **not** distinguish concurrent context, rate-limit and catalog promises.
- Cloudflare **read-only SQL Analytics API** on exact production D1 `4bd657ac-8789-403e-a28c-93aba8d0a989`, approximately 50-minute sampled window, returned 5,223 query events with 19 at least 800ms, 14 at least 2,000ms, and an **approximate** 10,136ms maximum. `error != ''` yielded zero query events; this is an analytics sample, not an all-requests proof.
- Seven expensive executions correspond to the exact materialized, shared-disjunctive **facets** query from `src/features/fore/search.server.ts` (`d1Facets` / `facetScanCandidateParts`). Together: 17,064,306 rows read, approximately 7,653ms mean SQL time. The separate `src/features/fore/taxonomy-count-query.ts` product+edition+territorial-availability aggregate also surfaced among the slow query families.
- `EXPLAIN QUERY PLAN` of the actual expensive facet SELECT, **without running that SELECT against production**, had 136 planner nodes, 22 correlated scalar subqueries, and 19 temporary sort B-trees; the engine used `idx_search_price`. This confirms that removing the former forced popularity index did not eliminate the full legal-view expansion.
- A *read-only EXPLAIN-only* trial materializing all currently authorized country product IDs **did not meaningfully simplify** the plan (138 nodes, 21 correlated subqueries, 19 temp sorts). It was not executed as a live production catalog query, published, or used to change any canonical grant. No new SQL optimization has been certified.

**Interpretation:** Expensive production catalog facet/taxonomy legal-availability scans demonstrably occur and may hold the primary D1 queue even when average requests are quick. They are one established pressure source; cannot assert they caused every 503 without request-level correlation. Do not disable current legal scope checks, approximate counts, silently drop facets, or use R2/KV display bytes as rights authority. The required next step is an actual owner-verified, mutation-closed positive writer and an exact, full-catalog read model that avoids recurring primary D1 legal-view expansions; certify exact count, facets, pagination, book data, and synchronous withdrawal **before** real customer routing.
