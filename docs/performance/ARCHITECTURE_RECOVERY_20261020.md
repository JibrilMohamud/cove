# Cove performance recovery: architecture, evidence and implementation

## Diagnosis

The 50,000-book campaign on runtime `e16c0868` is a failed architectural gate, not a failed rights test. Projection recommendations served 300/300 requests at 10 RPS but successful p95 was 2,127 ms. At 25 RPS, 14/750 timed out. Mixed traffic at 25 RPS produced 49 HTTP 503s and one timeout. Three deployment-first samples were 1,193/1,289/1,087 ms. Committed grant revocation passed eight fresh concurrent deliveries. Full summaries and caveats are in `discovery-evidence-20261020.json`.

Two different limits are visible:

1. **Serial dependency latency.** Candidate precomputation removed many reads, but API delivery still performed context resolution, current eligibility, per-rail experiment lookup, durable exposure writes, canonical hydration, and current channel checks. A modest number of sequential remote calls can exceed 800 ms even when each SQL statement is fast. Warm requests above one second mean a smaller JavaScript bundle or cold-start fix alone cannot solve this.
2. **Shared serialized database capacity.** Successful recommendations still executed 15 statements and wrote 80 rows/index entries per response. All-purpose primary D1 also serves search/facets, current rights, commerce, account state, and background work. Its documented single-threaded execution and per-request overhead make workload mix important. Separate HTTP endpoints do not provide separate database capacity.

The observed median known SQL total for successful projection requests at 10 RPS was 26.20 ms. As an illustration only, 25 × 26.20 ms is 655 ms of SQL work per second before missing `.first()` timings and service overhead; 50 × 26.20 ms exceeds a second. This is **not** a throughput forecast: medians are not means, failures are excluded, and concurrency/transport costs are incomplete. It shows why the implementation needs substantial headroom rather than relying on 750 ms unloaded responses.

The refactor improved the right thing but left other limits in place. Successful control requests read approximately 211,795 rows versus 5,458 for projections; only four control requests succeeded at 10 RPS, so success-only latency comparisons are selection-biased. The evidence supports reduced work and more completed requests. It does not establish commercial capacity or uniquely attribute all residual wall time to a D1 queue. One late bootstrap error explicitly reported a lost D1 network connection.

## What to borrow from open-source systems

| Reference                                                                                                                                                                             | Relevant pattern                                                       | Application to Cove                                                                                            | What it does not establish                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Medusa worker mode](https://docs.medusajs.com/learn/production/worker-mode) and [module isolation](https://docs.medusajs.com/learn/fundamentals/modules/isolation)                   | Separate request serving, background execution and domain dependencies | Keep Cove's book, licensing and literary logic; give background/engagement work independent resource ownership | Separate processes alone do not isolate a shared database                                                    |
| [Vendure server/worker architecture](https://docs.vendure.io/current/core/developer-guide/overview) and [job queue](https://docs.vendure.io/current/core/core-concepts/job-queue)     | Search indexing and retriable work execute outside shopper requests    | Bounded publishers, incremental indexing, independent engagement queue, retry/lease handling                   | A SQL-polled queue can still burden the transactional database                                               |
| [Meilisearch](https://github.com/meilisearch/meilisearch) and [faceted retrieval](https://www.meilisearch.com/docs/capabilities/filtering_sorting_faceting/how_to/filter_with_facets) | Dedicated indexed retrieval, filtering and facet distribution          | Use the existing integration; validate the real engine and its synchronization instead of rebuilding FTS       | Search projections cannot authorize a license, and indexed facet counts are not guaranteed live legal totals |
| [Microsoft eShop](https://github.com/dotnet/eShop)                                                                                                                                    | Domain services and asynchronous integration                           | Separate discovery, engagement and transactional ownership without copying an entire microservice stack        | Its topology is not evidence that Cove will meet a specific latency target                                   |

These patterns fit Cove's current Workers/R2 architecture. Adopting the frameworks wholesale would create a large digital-rights/reader migration without solving the measured problem automatically. A Postgres migration remains a measured fallback for a genuinely isolated transactional limit; it should not be the first response to request-time search and analytics sharing primary D1.

Cloudflare's [D1 concurrency guidance](https://developers.cloudflare.com/d1/platform/limits/) supports reducing both query work and database requests. [Placement](https://developers.cloudflare.com/workers/configuration/placement/) can reduce repeated backend round trips. It is a separate experiment: colocation does not remove shared write capacity or justify geography-wide claims.

## Implemented next boundary

`FORE_ENGAGEMENT_STORAGE=separate` selects `ENGAGEMENT_DB`, initialized from `engagement-migrations/`. It is opt-in and production configuration is unchanged.

- Recommendation requests, impressions, interaction events, their job queue, search query/click attribution, and successful HTTP telemetry use the independent store.
- Primary D1 retains canonical catalog, all current legal decisions, consent/reset controls, reading/account/commerce state, error/security records, and low-frequency materialized model outputs. HTTP 5xx records also retain their primary path.
- The database dependency wrapper carries an explicit domain reference. It does not inspect SQL strings or redirect arbitrary statements. Primary sessions still behave as primary sessions.
- Attributed delivery remains durable before its response completes. Request/impression batches are atomic and stay within D1's parameter budget. Visitor/account ownership, preceding-visible-impression requirements and event deduplication remain enforced.
- User learning and training read independent outcomes, then consult primary consent/reset controls. Account exports, reset/deletion, model evaluations, job status and operations/SLO dashboards follow the new ownership boundary. A permanent deletion fence and data removal commit together in the engagement store. Failed erasure remains retryable and is not reported complete.
- Missing/broken engagement storage does not fall back to primary writes. Unrelated rights/commerce operations do not require that storage to initialize. Nonessential HTTP telemetry failures remain observable in structured logs.
- Anonymous home experiments are read in one request-scoped primary query, with the same visitor assignment algorithm. Independent canonical hydration and exposure persistence overlap; ranking and cross-rail deduplication remain unchanged.
- A full recommendation metrics rebuild now processes at most 100 products and queues a cursor continuation, including bounded regional aggregation. It cannot synchronously walk 50,000 products in one job. Activity-driven per-product refreshes remain available.
- Search indexing uses one JSON ID bind for a bounded 500-document batch, fixing the previous potential 500-parameter D1 request. A new isolated CI campaign runs the actual application integration against a pinned official Meilisearch binary and a 50k synthetic catalog. A local engine test cannot certify Cloudflare/network performance.

Local two-database acceptance verifies actual behavior and absence of primary delivery writes, not just source strings. Existing real-schema ranking/revocation/rights tests remain required. Profiler snapshots distinguish initiated and pending statements; asynchronous work without metadata is not reported as proven zero cost.

## Controlled capacity experiment

The next protected campaign compares the same R2 projection/ranking code with primary versus independent engagement storage. Both variants enable normal durable HTTP telemetry. This is a different experiment from the earlier legacy-candidate versus projection campaign and must not be presented as the same comparison.

Both use the synthetic primary D1 only; the new independent database is `cove-engagement-isolated-20261020`. The harness verifies its schema marker and absence of catalog/rights/commerce tables before traffic. It preserves all offered arrivals, timeouts, rejections, deployment identity and committed-revocation evidence. Primary and engagement costs are separately labeled, including pending telemetry statements. Full post-response sampled costs are logged after background completion. Production traffic is not used for load generation.

## Production migration and release conditions

This remains a draft implementation until current-runtime evidence passes.

1. Quiesce all old engagement writers, including scheduled workers. Copy and reconcile historical requests, impressions, events, jobs and search attribution into the independent store, preserving IDs and foreign-key relationships. Check counts, ID/content digests and representative training/export/attribution queries. This migration is deliberately not run automatically against production.
2. Leave historical HTTP telemetry in primary; the dashboard reads disjoint primary history/errors plus new independent successes. Do not copy those HTTP rows into both sources and double-count them.
3. Coordinate every API/background deployment's binding and storage flag. Test actual account deletion/export and privacy changes through the complete deployed path. An old binary writing primary during a ledger cutover is not safe.
4. Preserve storage ownership during a read-model rollback. Blindly reverting the storage flag after independent writes would strand attribution and training history. A rollback to an older storage protocol requires a reconciled reverse migration and a writer fence.
5. Provision durable, protected search hosting and separate search/admin credentials. The real engine CI process is disposable and is not a production search service. Verify update/delete lag, relevance, disjunctive filters, channel handling and facet freshness semantics on the deployed topology.
6. Establish raw-engagement retention, archival/aggregation and shard capacity from actual event volume. A separate D1 isolates contention but is still a finite single database; it is not an unlimited analytics warehouse. Long raw histories at sustained high RPS require an object/event archive or additional partitions, with tested erasure and recovery.
7. Repeat cold, 1/4/8/16/32 bursts, single-route, search-inclusive mixed, sustained, distributed-generator and real-browser journeys with rights revocation during load. Verify full storefront parity, actual covers/JavaScript/mobile LCP, checkout, login, reader/offline behavior and rollback. Failures and dropped offered arrivals remain failures.

Only after these conditions have evidence should the draft stack be merged and production routing considered. Passing an isolated homepage, local SQLite, or local Meilisearch test does not close the release gate.
