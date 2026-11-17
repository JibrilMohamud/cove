# Protected canonical D1 phase staging run #24 — verified failure evidence

**Run:** `cove-protected-canonical-phase-staging` #24 / GitHub Actions
run ID `44011267209`; tested main
`db17f4cbcf5392f278bd3adfb82b3f4a7b93a643`.
**Source:** archived, numeric-only artifact
`cove-canonical-phase-stage-evidence-44011267209`
(120 records); no raw HTTP headers, payloads, SQL, buyer identifiers or secrets.

## What actually passed

- All 120 authenticated HTML/rights-authoritative responses were valid, with
  complete SQL, REST, RPC and Worker-phase measurements; zero dropped.
- Thirty-two control probes without the staging bearer were correctly denied
  with HTTP 401. They do **not** count as successful licensed reads.
- All three cold trial files had twenty responses; all four concurrency
  cohorts contained their exact expected counts.
- Control-plane pin checks passed and the two exact staging Worker names
  were independently verified absent after the run.

## What actually failed

The strict **max TTFB < 800 ms** requirement failed on twelve requests:

| Cohort | Requests | Slow (>=800 ms) | Maximum TTFB |
| --- | ---: | ---: | ---: |
| Cold 1 | 20 | 1 | 1,204 ms |
| Cold 2 | 20 | 0 | 771 ms |
| Cold 3 | 20 | 1 | 952 ms |
| Concurrent 1 | 8 | 1 | 935 ms |
| Concurrent 4 | 12 | 2 | 1,050 ms |
| Concurrent 8 | 16 | 3 | 1,002 ms |
| Concurrent 16 | 24 | 4 | 924 ms |
| **Total** | **120** | **12** | **1,204 ms** |

The full 120-record set had p95=952 ms and p99=1,050 ms using the
nearest-rank convention. Median=341 ms; no claim of strict acceptance.

For the twelve slow responses: ten had dominant
`measured-client-worker-residual` intervals; two had dominant
`measured-preheader-excess` intervals. Across **all** 120 requests,
maximum measured SQL execution was only 53.8 ms; among the slow twelve,
SQL reached at most 41.8 ms. For example:

- Cold 1 first request: TTFB=1,204 ms, SQL=41.8 ms, RPC=408 ms.
- Concurrent 4 slowest: TTFB=1,050 ms, SQL=30.9 ms, RPC=284 ms.

**Interpretation:** SQL execution duration alone cannot account for the
recorded tails in this campaign. Neither the external runner residual
nor the D1 REST preheader category is proof of a Cloudflare provider
fault. Compare identical cohorts from independent geographic origins,
bound transport establishment and dispatch separately from RPC, and
validate any proposed optimization against fresh rights-positive reads.
The failures must not be discarded as warm-up or reclassified as passing.

## Independent cleanup failure

The run's Wrangler `delete --force` action tried to list unrelated
Cloudflare KV namespaces and received authentication error `10000` with
the intentional account-scoped **Workers Scripts Write** token. Broadening
this token to KV administration would violate the least-privilege release
policy. Cloudflare's native Worker script DELETE API instead explicitly
accepts Workers Scripts Write. The accompanying patch calls that exact
endpoint for only stage names proven absent at preflight and tracked as
created/attempted by this run, without `force` or KV listing. The
independent postflight remains mandatory.

## Release decision

**NO-GO.** Full-catalog customer 503 resolution, four-region cold/warm
strict acceptance, 2×100 RPS, production legal owner/physical writer
exclusivity, Stripe LIVE settlement through revocation, repository
protection and protected rollback all remain separate mandatory gates.
