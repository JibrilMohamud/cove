# Cove Cloudflare performance and scaling release policy

## Current decision

The Cloudflare-native frontend is a **protected staging candidate**. It is not
approved for production DNS/Worker routing based on a single passing synthetic
run. D1 primary remains the live authority for territory, grant dates,
contracts, language, format, DRM and distribution rights. There must be no
cross-country cache, sampled rights checks, stale-while-revalidate rights,
country-header forgery, or fail-open catalog fallback.

## Always-on gates

1. Each change that touches the frontend, catalog, search, rights, Worker build
   or deploy workflow must pass static/security/reader/backend/browser CI.
2. Run 3 independently newly deployed Worker versions, with 20 genuine
   first-render HTTP requests per version. All 60 must have HTTP 200, actual
   eligible catalog cards, live primary-D1 proof, no-store and TTFB <800ms.
   Record the **first** SSR request before health checks or asset requests.
3. In fresh Chromium browsers, require SSR cards, successful client hydration,
   zero script errors and acceptable LCP on desktop and 4G-throttled mobile.
4. Then perform the synthetic 60-request concurrency ramp: 1/4/8/16 maximum
   in-flight SSR requests, *all* with live-rights proof and TTFB <800ms.
   Require p95 <=650ms through 8 in flight. This is a **regression
   canary**, not a maximum-throughput claim. A 429, 5xx, timeout, missing book
   cards, cached rights or missing protection fails the gate.
5. The existing daily UTC staging workflow repeats the cold, browser and
   concurrency gates under whatever actual ingestion workload happens to
   be running. Keep the staging deployment mutex; no overlapping secret
   rotations. A failing day must open investigation and block cutover.

## Why keeping TTFB low as traffic grows requires more than a fast Worker

- Keep the public catalog SSR path limited to the rights-checked primary
  first-paint query; configuration-only metadata can use a D1 read replica.
  Replica lag is **never** acceptable for a grant or revocation decision.
- As fresh data arrives, inspect D1 Analytics by SQL fingerprint:
  total query time, rows read, p95, writes and contention. Optimize or
  schedule large ranking/facet/indexer scans away from the hot storefront
  primary before simply increasing the Worker concurrency. Synthetic
  concurrency creates reads only and must not generate write contention.
- If latency grows with requested concurrency while SQL duration stays low,
  diagnose D1 service waiting, primary query queueing, replica/primary
  selection and first-request connection phases separately.
- Do not add request coalescing, caching or fallback of **legal eligibility**.
  Cached presentation-only metadata must never authorize catalog delivery.
- Preserve Cloudflare per-colo read limiter and existing durable API/commerce
  abuse limits. A 429 counts as failure in controlled performance trials;
  normal rate-limit behavior remains security-critical in real traffic.
- As the catalog approaches the D1 primary's practical queueing limit,
  separate bulk enrichment/indexing work from interactive primary rights
  reads, subject to independently reviewed consistency and reconciliation.
  Never migrate or duplicate live legal-authority writes without a rollback
  and source-of-truth plan.

## Evidence needed for commercial-scale certification

The regression suite covers 60 sequential cold HTTP samples and 60 small
concurrent samples from **one runner region**. It is insufficient for a
worldwide capacity claim or an RPS/SLA guarantee. Before launch, collect:

- At least 10 complete, independently cold 60/60 runs across deployments and
  different ingestion schedules. First-request maximum <=650ms is the
  improvement target; the <800ms hard ceiling is mandatory.
- Actual authenticated and unauthenticated customer journeys: catalog,
  search/filter, book detail, paid acquisition, reader, download and offline
  reopen. Include all rights/deny fixtures and revoked titles.
- Concurrent traffic from independent North America, Europe and APAC
  origins, with actual Cloudflare colo and market identifiers; never fake
  country headers. Ramp in separately authorized capacity windows with a
  clear traffic maximum, error/latency stop conditions and enough cooldown
  for per-colo rate limiting.
- Steady 15-60 minute load, a plausible ratio of catalog, search, personal
  library and reader traffic, active legitimate ingestion writes, and
  measurable request rates. Record p50/p75/p95/p99, maximum TTFB, mobile LCP,
  errors, 429s, concurrent open requests, D1 query latency/rows-read,
  operational cost and Writer/Queue saturation.
- Load test after indexing and music/catalog expansion; a tiny fixture catalog
  cannot establish behavior at hundreds of thousands of books.
- A verified production domain, correct auth/OAuth and Stripe callback
  origins, real geographic licensing, rollout/rollback flags and
  production real-user monitoring. None can be inferred from a workers.dev
  synthetic test.

## Rollback and incident handling

1. Do not route any production traffic while a hard release gate fails.
2. Identify failing samples by code version, wave, timing phase, CF colo and
   aggregate counters. Never store staging bearer tokens, request headers,
   IP addresses, user IDs or book data in performance artifacts.
3. Compare primary SQL time to Worker wall time to client/network residual.
   Slow SQL -> query plan/rights-view efficiency; low SQL but high latency ->
   D1 service/queue, Worker isolate, transport or other concurrent work.
4. Revert the last measured regression; re-run at least three fresh cold
   deployments and all browser and rights checks.
5. Keep prior production routing untouched until a new version passes the
   full launch matrix and a reversible canary cutover is explicitly approved.
