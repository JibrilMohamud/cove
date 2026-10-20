# Thin storefront — synthetic D1 queue attribution and capacity release gates

This branch extends PR #228 and remains **draft, staging-only, not mergeable to
production**. Its goal is to distinguish Worker/ingress transport saturation,
public metadata-service latency, and unavoidable primary-D1 rights-service
latency, using explicitly allowlisted artificial D1 data.

Four **bearer-authenticated, staging-only** diagnostic endpoints:
`/__cove_perf/edge`, `/__cove_perf/context-uncached`,
`/__cove_perf/context-cached`, and `/__cove_perf/rights`.
The latter uses the unchanged canonical first-paint primary-D1 territorial
rights query. The context probes use the original anonymous locale/market
resolver, with and without the candidate completed-only metadata cache.
Every non-edge probe uses the existing per-client rate limiter. They return
only stage, success and a count; never offers, customer data or rights grants.
They are prohibited outside the explicit synthetic staging Worker/DB gate and
are never routed publicly. The full anonymous HTML test still executes every
applicable legal predicate before rendering books.

The benchmark keeps the previous 3 fresh deployments ×20 cold requests,
two 1/4/8/16/32 concurrent waves, 32 full bootstrap probes, browser and
revocation checks, and 20s 10/25/50/100/250/500-RPS HTML steps. It adds short
isolated 8-second 25/100-RPS stages **per diagnostic endpoint**, with 2-second
gaps. A single failed diagnostic stage stops that endpoint's escalation.
The rates are staged and sequential, **not** simultaneous mixed workloads.
Saved artifacts include per-stage raw responses, request colos, response
timings, HTTP statuses and client drops; benchmark runs cannot bind production
D1 or mutate production content.

A new explicit `sustained100RpsGate` fails unless **both** 50- and 100-RPS
HTML stages pass, with all 2,000 responses valid at 100 RPS, zero late arrivals
or drops, p95 <=600ms, p99 <=750ms and maximum <800ms. A historical
`architecturalGate` pass is **not** release approval; the unchanged final
`releaseApproved=false` also requires real homepage experience parity,
consistent multi-geography, authentic cover-distribution mobile LCP, mixed
customer activity, independently proven routing, canary and rollback.
Diagnostics are explanatory and may show a bottleneck; they are not a fix.

The previous cache-only experiment failed both the 32-request bootstrap
(857ms) and 100 RPS (p95 820ms, max 1461ms, 18 drops). Keep these as genuine
failed gates and investigate full D1 service time rather than caching any
legal right or silently skipping validation.

### Safe interpretation

An edge-only pass with rights-only failure suggests primary D1 service/queue
limitations, not necessarily slow SQL. A context-uncached failure rescued by
context-cached suggests independent presentation reads contribute queueing.
Colo changes or differing client schedules invalidate causal comparisons.
Each phase remains separately reported; **do not subtract independent
quantiles**. Whole-fleet cold and regional SLO certification need geographically
controlled runners that are not represented by these probes.

## Concurrent synthetic customer-read mix

After phase attribution, the runner applies 20-second 50 and 100 RPS
mixed-arrival schedules against the same synthetic rights-safe D1:
55% first-page HTML, 20% filtered catalog JSON, 15% recommendation rail
JSON and 10% merchandising JSON. The real unchanged full app serves the
non-home routes through the CORE service binding. Every JSON response is
shape-validated, not merely HTTP 200; each URL's status, TTFB, drops,
late arrivals, colo, and errors are saved separately. A failing stage stops
further escalation. A new explicit `mixedLoadGate` requires a passing
100-RPS mixed stage with no dropped or unscheduled requests and the same
sub-800-ms p99/headroom gates. The runner never targets production D1.

This is more representative than homepage-only concurrency, but it is NOT
full commerce parity: authenticated account, checkout, EPUB reading, offline
behavior, ingestion and background indexing are not included. It must not
replace those later end-to-end canary and soak requirements.
