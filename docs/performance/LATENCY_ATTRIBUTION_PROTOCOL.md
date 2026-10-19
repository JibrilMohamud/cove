# Cove latency attribution — isolated, rights-safe diagnostic protocol

This document is a reproducibility contract for [the protected staging
attribution branch](https://github.com/JibrilMohamud/cove/pull/226), not a
production-performance certification. Never deploy the diagnostic flag against
the production D1 database.

## What actually runs

The GitHub workflow `cloudflare-isolated-attribution-ladder` checks out the
**same commit SHA** into both independent build trees, injects the allowlisted
50,000-document synthetic-only D1 bindings, builds two protected Workers, and
verifies negative/denied/revoked territorial grants. It uses no production DNS
or production Worker route.

The ordering prevents the diagnostic ladder from prewarming the cold tests:

1. Three fresh control-plane-verified deployments per arm, with existing
   protected 20-sample cold full-HTML rights tests.
2. Repeated full-homepage 1/4/8/16/32-request sweeps on each arm. Invalid
   HTTP, empty cards, rights failures and all max/p95 SLO failures count.
3. Desktop and throttled mobile browser LCP and hydration tests.
4. A 65-second traffic cool-off, followed by paired A–E ladder waves with
   alternating arm order and actual edge colo recording. A–E test 1/4/8
   in-flight requests; extra 32-in-flight waves exercise A, C and E.
5. D1 query analytics and Workers invocation CPU/wall time, fetched separately,
   with explicit availability/aggregation caveats.

The five paths are:

| Stage | URL path | Meaning |
| --- | --- | --- |
| A | `/__cove_perf/edge` | Minimal, staging-authenticated Worker response after native bindings/country checks; no D1 query |
| B | `/__cove_perf/d1` | One `SELECT 1` on bound primary D1 |
| C | `/__cove_perf/rights` | The actual live primary-D1 country-filtered first-paint shelf query |
| D | `/__cove_perf/bootstrap` | Complete anonymous market/context and primary-rights bootstrap |
| E | `/` | Real first-paint SSR, including complete valid HTML and live legal rights |

All routes require the rotated staging bearer. The special diagnostic routes
also require `COVE_SSR_STAGING=1`, `COVE_SSR_DIAGNOSTICS=1` and a bound
database. The diagnostic flag is generated **after** the synthetic database
allowlist has replaced all production resource identifiers. Production has
neither the flag nor the staging bearer. All responses are `no-store`.
The C/D endpoints return only numeric counts and timings, never book details.

The synthetic fixtures are only a scaled behavioral approximation of production
catalog and country constraints. They cannot prove worldwide production SLOs.

## How to interpret measurements

- The Node runner measures elapsed time to response headers, elapsed time to
  complete response, Undici request-creation/headers-sent/response-headers
  stamps, the actual three-letter Cloudflare colo, and (only for a single
  outstanding request with corresponding Undici connect events) combined
  DNS+TCP+TLS handshake. Under concurrency the handshake field is **null**.
  Serial null means a reused connection or unobserved connection, not zero.
- The platform `cfWorker` server timing may be absent on `workers.dev` without
  the relevant Cloudflare rule/RUM capability. Treat absence as unknown.
- Worker JavaScript `performance.now()` is **not** a wall or CPU timer during
  CPU work. `cove_total` is an I/O-biased phase marker, not the real cost of
  SSR. Never label `TTFB - cove_total` as network latency.
- D1 `meta.timings.sql_duration_ms` measures SQL execution, not D1 service
  dispatch, primary queueing, transport or downstream React work.
- Worker platform invocation CPU and wall quantiles are **script-level**, not
  per-homepage, because they include denied controls, assets and probes.
- Never subtract two independent p95 values to claim a causal latency component.
  A–E stage comparisons produce **hypotheses**, not additive spans.
- Different CF colos or mismatched client regions invalidate code-performance
  comparisons. Same source SHA controls source-code differences but synthetic
  D1 primaries may still experience independent queueing.

## Geographic repeatability

The default GitHub-hosted runner's client region is **unverified**. It can
report the actual CF colo observed at the receiving edge, but multiple colos
in a run do **not** prove multiple independent client regions. The report
therefore sets `clientRegionVerified=false`, and no global/geographic SLO
claim is made.

For rigorous geographic campaigns, execute this same immutable protected
staging script from separately attested client runners in at least three
specified regions (for example eastern US, western Europe and southeast Asia).
Preserve each runner's public-region attestation outside artifacts, keep the
same SHA/config/fixture and record colos and the observed full-homepage
latency distribution. No geography should be inferred from language headers,
spoofed `CF-IPCountry`, or an assumed GitHub runner location. Repeat cold
deployments at each source region under separately controlled campaigns, and
compare only region-matched cohorts. Independent client probes require a
properly authorized operations environment; do not introduce geographic
request relays that bypass auth or legally alter visitor country.

## Reporting, evidence and fail-closed decisions

Artifacts under `lazyfacet-paired-evidence/`:

- `paired-release-gate.json` — immutable three-cold and full concurrency/LCP
  gate, including invalid responses, deployment hashes, D1 and Worker
  snapshot availability.
- `latency-attribution.json` — every valid/invalid stage sample, queue and
  connect metadata, CF colos, SQL cost and alternate arm summaries.
- `latency-attribution.csv` — concise stage-level maxima and tail percentiles.
- `latency-cpu-cove-lazyfacet-*.pprof` (or `.pprof.gz`) — optional
  actual Cloudflare CPU profiles captured **after** all measured latency
  cohorts, under separate bounded 32-request, rights-checked synthetic load.
  A missing profile is an explicit unsupported-token/platform status, not a
  zero-CPU result. Use `go tool pprof` or the Cloudflare profile viewer to
  find functions, never to infer uncaptured isolate startup delays.
- `latency-attribution.md` — hypotheses and ranked diagnostic gaps; states
  `rootCauseProven=false` unless a future independently validated mechanism
  establishes causality.

If metrics are missing, output `n/a` and the reason; never substitute zeros.
If any customer-facing strict gate fails, the candidate **fails release**
regardless of which diagnostic stage is fast. Do not merge this diagnostic
branch to production simply because its test tooling is useful.

Useful documentation:

- Cloudflare Workers CPU profiling:
  https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/
- Platform invocation CPU/wall:
  https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- cfWorker server timing:
  https://developers.cloudflare.com/changelog/post/2026-02-18-cfworker-server-timing/
- D1 consistency and replica selection:
  https://developers.cloudflare.com/d1/best-practices/read-replication/
