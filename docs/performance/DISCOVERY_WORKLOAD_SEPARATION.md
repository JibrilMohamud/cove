# Discovery workload separation — staged implementation

This branch implements the first read-model boundary from the October 20 action plan. It is based on PR #233 for comparison with its synthetic campaign; that PR and this branch are not approved for production.

## Implemented behavior

- Anonymous recommendation candidate production, literary features, model configuration and neutral metadata can be published into a private R2 read-model bucket. Request-time ranking, visitor diversity, experimentation, attribution and current canonical book hydration retain the existing algorithms.
- Anonymous merchandising candidates and placement decorations can be produced asynchronously. Visitor weighting, audience/experiment selection, cross-placement deduplication, canonical book hydration and current territorial authorization remain at delivery. Models expire at the next scheduling boundary and within five minutes.
- Missing, invalid, oversized, wrongly scoped or expired required models return 503. Visitor requests never regenerate them or fall back to expensive discovery queries.
- A bounded JSON-seeded authorization query checks up to 600 distinct IDs in one primary snapshot. It uses the complete existing live rights view, which includes contract, license, date, territorial, language and DRM rules. Anonymous recommendation series gating remains in that query. No replica or cached result authorizes a delivery.
- Current channel flags are checked independently of stale edition/index booleans for read-model delivery. Offers and book/asset metadata are freshly hydrated from canonical tables.
- Meilisearch index lag removes revoked candidates; it no longer triggers full D1 search. `FORE_SEARCH_FALLBACK=disabled` requires a configured external engine and returns 503 on an outage. This mode has a 450 ms external search budget. Legacy deployments keep their existing 8 s transport budget.
- Opt-in request-local D1 instrumentation records statement fingerprints, wall duration, available SQL timing, rows read/written and execution-primary metadata. Residual wall time includes scheduling and transport; it is not asserted to be pure database queue time. `.first()` provides no D1 metadata; absent values remain unknown. A batch's wall duration belongs to the whole batch and must not be summed per statement.
- The fixed-arrival harness accounts for every offered request, continues scheduling after pending-capacity drops, and includes failures/timeouts/drops in its acceptance decision. Success-only percentiles are explicitly labeled. Three deployment-first requests are distinguished from their 57 warm follow-ups.

## Configuration and publication

No production flags or routes are changed. Apply migration `0079_bounded_discovery_series_gates.sql` before rollout; it adds covering indexes for edition and prior-volume series gates. Opt in only after validation:

- Bind a private `DISCOVERY_MODELS` R2 bucket. Version objects are immutable; a small current pointer is published only after its complete version. Apply lifecycle retention for superseded versions before production rollout.
- `FORE_DISCOVERY_READ_MODE=required` enables anonymous home and merchandising read models. Authenticated personalization retains its current path and still requires its own capacity proof.
- The persistence worker supports a bounded scheduled publisher when `FORE_DISCOVERY_SCOPES` is configured, e.g. `US_en`. Candidate-production reads use an unconstrained replica session when available. Internal merchandising searches do not generate shopper search-impression events. At most one of four configured scopes is refreshed each minute; publication failures log an operational event and preserve the last complete version. Multi-producer lease/fencing and wider-market freshness are not certified by this diagnostic.
- `FORE_SEARCH_BACKEND=meilisearch` plus URL, search/admin keys and index name selects the existing search integration. Its indexing queue and synchronization code are retained. `FORE_SEARCH_FALLBACK=disabled` prevents an engine outage from stampeding primary D1. Incremental indexing, relevance, disjunctive facets, channel filtering and freshness need real-engine acceptance testing before enabling this setting.
- `FORE_D1_COST_PROFILE=1` enables route cost logging. It is opt-in because instrumentation has overhead and DB-identity-keyed caches must be considered when interpreting profiles.

By default, recommendation request/impression records and search-query attribution retain primary D1 storage. The subsequent opt-in engagement boundary and current architecture work are documented in [ARCHITECTURE_RECOVERY_20261020.md](ARCHITECTURE_RECOVERY_20261020.md). Account/security/commerce writes remain authoritative. Independent storage requires coordinated ingestion, lookup, deduplication, privacy/erasure, training and dashboard changes; `waitUntil()` alone does not provide that separation.

## Validation

The reviewed baseline also contained a D1-specific defect: twenty impressions used 160 parameters in one statement. D1 limits each statement to 100 bound parameters, including inside a batch ([Cloudflare limit reference](https://developers.cloudflare.com/d1/platform/limits/)). The implementation now writes at most twelve impressions (96 parameters) per statement in one atomic request/impression batch and preserves positions across chunks. The scale test enforces the platform bind budget and injects a second-chunk failure to prove transaction rollback.

The initial 50,000-book local fixture preserved two 20-book rails and reduced statement counts from 34 to 13 with a maximum of 96 binds. This is local statement-count evidence, **not a Cloudflare latency result**. A richer 20,000-membership fixture checks the covering-index query plan as well.

The user approved publication. [Draft PR #236](https://github.com/JibrilMohamud/cove/pull/236) contains this implementation and targets the unmerged PR #233 experiment branch. No merge or production cutover has occurred.

Real Cloudflare staging exposed two platform/harness issues that local SQLite alone did not establish: the deployment configuration requires JSONC parsing, and a ten-arm compound scheduling query exceeds D1's compound-SELECT budget. The publisher now uses scalar schedule-boundary subqueries in a single JSON expansion; the replacement succeeded on the isolated D1 (0.9467 ms SQL, 24 rows read, zero writes). The response validator also checks the actual nested `catalog.results` bootstrap envelope. These are execution/correctness fixes, not capacity certification.

Run `npm run test:discovery-read-models`, `npm run test:discovery-scale`, `npm run typecheck`, and existing rights/recommendations/thin storefront gates. Integration tests use all real migrations and exercise actual serving functions, not source-text matching alone. They verify ranking/reason parity, independent request identities, committed revocation, market isolation, miss/expiry/corruption failure, no D1 search during external outage, bounded candidate authorization and profiler bind/batch semantics.

`cloudflare-discovery-read-models` creates one gated diagnostic Worker and deletes it on completion. Its only database is the existing 50,000-book wholly synthetic candidate D1. It uses a separate private benchmark R2 bucket. It compares full recommendation API requests, repeated 1/4/8/16/32 bursts, mixed bootstrap/recommendation/merchandising traffic and committed revocation. Baseline and projection runs use the same database, client and telemetry policy. It preserves all raw evidence on failure, keyed to the tested commit.

This diagnostic excludes real keyword search, complete storefront rendering/browser interactions, authenticated capacity, long soaks and independently distributed geographies. `releaseApproved` remains false even if its narrower architectural gate passes. A 503 counts as a failed request; graceful isolation alone is not successful service.

## Cloudflare campaign — October 20, 2026

**Result: failed; do not merge or cut over.** [Run 39379082376](https://github.com/JibrilMohamud/cove/actions/runs/39379082376) exercised runtime commit `e16c08682405a4eee1151dabce821402834c6053`. The complete raw JSON is [artifact 12245460230](https://github.com/JibrilMohamud/cove/actions/runs/39379082376/artifacts/12245460230), retained by Actions for 30 days. The checked-in JSON beside this document preserves the printed summaries and provenance. This document-only follow-up does not change the tested runtime.

The database contained 50,000 synthetic books. Deployment-first responses came through **ORD**; D1 reports its primary in **IAD**. This is a single-generator diagnostic, not independent geographic coverage. Both control and projection use the same database and console-only operational telemetry policy; recommendation attribution writes remain enabled. Phases run sequentially with a producer refresh between load phases. Shared database history, cache warmth and recovery after overload can affect comparisons; this is not a randomized or independently replicated experiment.

| Projection workload                         | Valid / offered |                 Failed | Successful p95 TTFB | Successful maximum |
| ------------------------------------------- | --------------: | ---------------------: | ------------------: | -----------------: |
| Recommendations, 10 RPS × 30 s              |       300 / 300 |                      0 |            2,127 ms |           5,355 ms |
| Recommendations, 25 RPS × 30 s              |       736 / 750 |            14 timeouts |            7,515 ms |           7,949 ms |
| Mixed without keyword search, 10 RPS × 30 s |       299 / 300 |              1 timeout |            1,663 ms |           4,381 ms |
| Mixed without keyword search, 25 RPS × 30 s |       700 / 750 | 49 HTTP 503, 1 timeout |            2,412 ms |           4,252 ms |

No offered-load arrivals were dropped by this generator. Failed requests remain in the validity denominator; the latency columns describe successful responses only. The three deployment-first TTFBs were 1,193 / 1,289 / 1,087 ms, and warm-follow-up maxima were 1,013 / 1,003 / 1,160 ms. Recommendation bursts at concurrency 1 / 4 / 8 / 16 / 32 had maxima 724 / 1,977 / 3,158 / 3,448 / 3,621 ms. Bootstrap burst concurrency 4 also had four timeouts. These independently fail the hard 800 ms requirement.

Control recommendations returned 4/300 valid at 10 RPS (199 timeouts, 97 HTTP 503) and 7/750 at 25 RPS (329 timeouts, 414 HTTP 503). Projection is a substantial improvement in successful service, but cannot be accepted as commercial capacity. Successful recommendation responses reported 36 control versus 15 projection D1 statements. At 10 RPS, median _known-metadata_ SQL time was 155.07 versus 26.20 ms and rows read 211,795 versus 5,458; the control figures have only four successful samples and exclude its failures. Both paths still wrote 80 rows/index entries per successful request according to D1 metadata. `.first()` SQL metadata is unavailable, so these are partial SQL totals, not complete database critical-path measurements.

Live sampled profiles show individual calls with sub-millisecond SQL taking tens or hundreds of milliseconds in surrounding service time. That residual includes transport, scheduling and possible queueing; the evidence does not uniquely apportion it. A late mixed-phase bootstrap failure logged `D1_ERROR: Network connection lost`; do not label every 503 as proven queue overload.

After a committed synthetic US grant revocation, all eight fresh concurrent projection deliveries excluded the revoked product and returned valid content. Original synthetic grant statuses were restored in `finally`. Cleanup succeeded and the private diagnostic Worker is absent.

Typecheck, real-schema projection/rights/recommendation/50k scale checks passed in this run. Security, persistence backend, native SSR staging, screen-reader, browser/device, production-storefront-performance and fullsite-performance workflows also passed for the tested runtime. Those existing checks do not override the failed discovery capacity gate or certify search-inclusive production journeys.

## Release status against the action plan

| Milestone                                     | Current status                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Attributable route cost model                 | Implemented; live request/SQL/row evidence collected for these routes; complete endpoint coverage and dependency traces remain       |
| Bounded live rights operation                 | Implemented; live 8/8 committed-revocation checks pass; starvation isolation and target capacity are not proved                      |
| Dedicated search and facets                   | Existing Meilisearch integration hardened; no search binding/credentials exist in connected production or SSR staging                |
| Precomputed anonymous discovery/merchandising | Implemented as explicit opt-in; local 50k parity passes; Cloudflare capacity gate fails                                              |
| Complete storefront parity                    | Full application preserved, but experimental thin-homepage parity is not certified                                                   |
| Commercial load/release gate                  | Corrected accounting implemented; measured cold/burst/load gate fails; broad sustained, geographic and browser evidence still needed |

## Work required before a release candidate

1. Provision a dedicated real search engine and configure its protected URL, index and separate search/admin credentials. Connected production and SSR staging currently have no Meilisearch bindings. Validate indexing, incremental updates, relevance, filters, disjunctive facets, deletion and outage behavior on that real engine. Mocked engine tests cannot close this milestone.
2. Move analytical exposure/event storage to an independent resource. Preserve request identity, ownership checks, attribution lookup, idempotency, consent, erasure, model training and operations dashboards. The current 15-statement/80-write recommendation path still shares the rights database; moving its promises to `waitUntil()` does not close this milestone.
3. Reduce and prove the authoritative delivery budget after those workload boundaries exist. Test bounded candidate batches, current canonical hydration and live channel checks together, including committed revocation while discovery and commerce traffic run. Retain ranking/diversity correctness rather than truncating candidates to obtain a passing number.
4. Prove complete storefront parity with real assets and application JavaScript, including search/filters, book details, authentication, cart/checkout, reader/offline access, accessibility and analytics. Add sustained, multi-generator/multi-geography and real-browser acceptance evidence on the release runtime with rollback prepared.

Do not merge this experiment stack or switch production on the strength of local tests or homepage-only latency.
