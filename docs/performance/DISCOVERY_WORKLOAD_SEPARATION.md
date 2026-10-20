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

Recommendation request/impression records, search-query attribution, account/security/commerce writes and existing operations dashboards remain on primary D1. Moving attribution requires coordinated event ingestion, lookup, deduplication, privacy/erasure and dashboard changes; it must not be disguised by silently dropping writes or by `waitUntil()` alone.

## Validation

The reviewed baseline also contained a D1-specific defect: twenty impressions used 160 parameters in one statement. D1 limits each statement to 100 bound parameters, including inside a batch ([Cloudflare limit reference](https://developers.cloudflare.com/d1/platform/limits/)). The implementation now writes at most twelve impressions (96 parameters) per statement in one atomic request/impression batch and preserves positions across chunks. The scale test enforces the platform bind budget and injects a second-chunk failure to prove transaction rollback.

The initial 50,000-book local fixture preserved two 20-book rails and reduced statement counts from 34 to 13 with a maximum of 96 binds. This is local statement-count evidence, **not a Cloudflare latency result**. A richer 20,000-membership fixture checks the covering-index query plan as well.

GitHub publication and the resulting live staging workflow were blocked by automatic approval review. No new live cold/concurrency/TTFB claim is made for this branch, and no PR, merge or production cutover has occurred.

Run `npm run test:discovery-read-models`, `npm run test:discovery-scale`, `npm run typecheck`, and existing rights/recommendations/thin storefront gates. Integration tests use all real migrations and exercise actual serving functions, not source-text matching alone. They verify ranking/reason parity, independent request identities, committed revocation, market isolation, miss/expiry/corruption failure, no D1 search during external outage, bounded candidate authorization and profiler bind/batch semantics.

`cloudflare-discovery-read-models` creates one gated diagnostic Worker and deletes it on completion. Its only database is the existing 50,000-book wholly synthetic candidate D1. It uses a separate private benchmark R2 bucket. It compares full recommendation API requests, repeated 1/4/8/16/32 bursts, mixed bootstrap/recommendation/merchandising traffic and committed revocation. Baseline and projection runs use the same database, client and telemetry policy. It preserves all raw evidence on failure, keyed to the tested commit.

This diagnostic excludes real keyword search, complete storefront rendering/browser interactions, authenticated capacity, long soaks and independently distributed geographies. `releaseApproved` remains false even if its narrower architectural gate passes. A 503 counts as a failed request; graceful isolation alone is not successful service.

## Release status against the action plan

| Milestone                                     | Current status                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Attributable route cost model                 | Instrumentation implemented; real D1 cost evidence pending                                                                       |
| Bounded live rights operation                 | Implemented; local committed-revocation and existing rights tests pass; live load evidence pending                               |
| Dedicated search and facets                   | Existing Meilisearch integration hardened; no search binding/credentials exist in connected production or SSR staging            |
| Precomputed anonymous discovery/merchandising | Implemented as explicit opt-in; local 50k ranking/budget checks passed; Cloudflare capacity evidence pending                     |
| Complete storefront parity                    | Full application preserved, but experimental thin-homepage parity is not certified                                               |
| Commercial load/release gate                  | Corrected accounting implemented; broad search-inclusive, sustained, geographic and real-browser release evidence still required |

Do not merge this experiment stack or switch production on the strength of local tests or homepage-only latency.
