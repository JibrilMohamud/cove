# Cove: causal request-path audit and architecture checkpoint

**November 14, 2026. Investigation only; no release certification or production mutation.**

The 800 ms TTFB ceiling is an acceptance threshold, **not the diagnosis**. We must prove which operation consumes time, how concurrent arrivals affect throughput and the tail, and when a new serving topology is better than continuing incremental SQL changes.

## Proven observations

- Draft PR #665 synthetic D1/real R2 candidate returned 61/61 valid results across 1/4/8/16/32 bursts. The final 32-request **application** maximum was 639 ms and p95 637 ms. Earlier candidate's 32 maximum was 1,140 ms. These are **not** external TTFB or sustained geographic acceptance.
- Prior staged sustained campaign admitted 250/250 at 25 RPS, but 50 RPS saw roughly 4-second application responses and 71 dropped scheduled client arrivals. It is unsafe to claim 100-RPS qualification based on 32-request bursts.
- A bounded read-only production D1 rights query consumed 11.9 ms SQL, read 346 rows, wrote 0. That does not prove throughput or end-to-end latency.
- Fullsite-performance on PR #665 head 02a7d554f8290bd43ef4852e3eebe2b54ce137e7 failed the real guest-catalog preflight with http-503, skipping browser timings. Vercel's 20:07–20:08 UTC warnings show both **pre-context handler-exception** and **post-context catalog-rights** failure stages. These are different phases and require correlated backend evidence; an expensive search scan cannot explain every pre-context failure.
- Cloudflare staging Observability, 20:15–20:40 UTC: 640 sampled D1 all() spans average **338.96 ms operation wall** versus **3.20 ms SQL**; p95 operation wall 1,220 ms. Another 89 D1 batch spans average 410.5 ms versus 4.82 ms SQL.
- Between 20:27:30–20:29:30 UTC, 32 D1 all() spans had p95 operation wall 4,300 ms, p95 SQL 72.7 ms, average rows read 34,632; between 20:31:30–20:33:30 UTC, 115 spans had p95 wall 1,731 ms, p95 SQL 3.86 ms, average rows read 486. These are **different workload windows**, not matched paired experiments.
- Both current production and stage Worker settings show analytics-engine anonymous HTTP telemetry enabled. Stage uses independent synthetic D1/R2/limiter bindings. The production catalog 503 is a separate unresolved customer availability gate.

## Request critical path

Browser -> DNS/TLS/CDN -> Vercel SSR or Cloudflare pilot -> Worker API routing/auth -> anonymous locale/market/payment/translation context -> primary-D1 current rights selection -> canonical book metadata -> response serialization -> first byte.

PR #665 removes unused guest D1 cache reads/writes and gets display-only facets from R2, but primary rights selection and subsequent canonical hydration still cause database service operations. **R2 presentation never confers distribution rights.** There is no proven user-owned connection pool to tune in a Workers D1 binding; queue depth, D1 service contention, Worker CPU/memory and transport scheduling need measurements.

Never subtract p95 SQL from p95 D1 wall and call the difference p95 queue time. The attached attribution tool computes per-span wall-minus-SQL only when both values belong to the *same operation*. Even then, outside-SQL time combines service dispatch, transport, queueing and other causes.

## Competing mechanisms and falsification

| Hypothesis | Confirmation | Disproof / cheapest control |
|---|---|---|
| Primary D1 service latency/queueing grows under concurrency | Paired outside-SQL durations grow while throughput plateaus | Fixed small rights-only SQL stays flat at 10/25/50/75/100 RPS |
| SQL plan alone dominates | SQL duration and rows read track the HTTP tail | Operation wall remains >1 s while SQL is <5 ms |
| Vercel/Worker transport dominates | Noop has the same 99th-percentile cliff | Noop flat but rights-only slows |
| Worker CPU dominates | CPU p95 tracks wall and saturates budget | CPU low while D1 wall grows |
| Client scheduler is overloaded | Noop also drops scheduled arrivals / launch delay rises | Separate external generator schedules exact arrivals |
| Production backend fails independently of catalog-rights evaluation | Pre-context 503 correlated with backend-side failures | All 503s consistently trace to catalog-rights operations |

## Required architecture review — triggered by ineffective tuning

Three strategic choices, plus a replacement alternative:

A. **Further SQL/cache tuning** — low migration cost but limited expected benefit if non-SQL D1 time dominates. Retain only for confirmed query regressions.

B. **Single bounded primary-authoritative rights/metadata serving call plus independent R2 display** — preferred *experiment*, not a production decision. Reduce serial service waits without repeating the previously bad ~156k-row combined scan. Retain exact current-primary eligibility, territory, payment and withdrawal checks. Prefer a two-step bounded batch over an explosive scan.

C. **Sharded strongly consistent rights read-model with revocation fence** — could decouple volume from a single primary D1 read bottleneck, but must formally prove immediate withdrawal and fail-closed behavior across colos before implementation. An asynchronously refreshed KV/R2 allow-list **cannot** become rights authority.

D. **Replace the rights-serving datastore/topology** — only after comparing B/C with measured D1 service capacity; more operational/recovery risk; no unsafe dual writers.

**Decision:** Stop SQL-only tuning and use stage-only noop vs rights-only vs full-catalog controls to isolate service overhead. Avoid jumping directly to a new datastore.

## Measurement and release policy

1. Pin stage Git SHA, deployed Worker version, synthetic fixture, R2 version, rate limiter and trace sampling. Reject incomparable campaigns.
2. Control concurrency at 1/4/8/16/24/32 and offered rates 10/25/50/75/100 RPS, using an independent transport/load generator control. Record offered, launched, completed, valid, dropped, errored, timed out, achieved RPS, inflight occupancy and launch delay.
3. Report true first-byte vs full-body times, median/p95/p99/max, CPU, D1 operation and paired SQL time, rows read/attempts/region, and external overhead. Do not mix in-handler time with external TTFB.
4. After **two ineffective measured iterations in one subsystem or three overall**, reject further incremental work until at least three architectural alternatives, an evidence-based decision, and a rights-safe rollback are documented. Inconclusive results are not improvements.
5. Continue to fail release if: production real catalog 503 persists; external cold/warm 1/4/8/16/32 TTFB max >=800 ms; either of two 20-second 100-RPS phases lacks all 2,000 valid results, has p95 >=600 ms, p99 >=750 ms, max >=800 ms or drops; ORD/LAX/IAD/DFW not certified; protected rollback, production legal owner, writer exclusivity or Stripe LIVE certification remains incomplete.

This audit changes no customer routing, live rights, canonical writer privileges, payments or production resource binding.

## Follow-up: actual paired D1 span attribution

The independent Cloudflare event query retrieved *individual* stage D1 span events (not only per-window aggregate percentiles), matched each operation's wall time with its own SQL duration, and calculated a separate difference for each valid pair. No SQL text, request identity or authorization header was retained.

| Stage UTC interval | Valid paired spans | Mean outside SQL | p95 outside SQL | p99 outside SQL |
| --- | ---: | ---: | ---: | ---: |
| 20:27:30–20:29:30 | 32 | 763.78 ms | 4,229.94 ms | 4,297.41 ms |
| 20:31:30–20:33:30 | 115 | 489.82 ms | 1,727.93 ms | 1,728.68 ms |

The earlier interval returned 60 total trace events, but only 32 included both valid numeric durations; 28 were excluded rather than assigned zero SQL. The later interval returned 115/115 valid paired spans. These results **confirm substantial outside-SQL delay in sampled stage D1 operations**, not a specific provider queue, connection pool wait, or CPU bottleneck. The two intervals contain different query mixes and must not be treated as a controlled A/B comparison. Future measurements must capture Worker CPU and a generator noop control.

## Concurrency shape from the final 61-sample synthetic campaign

The full, ordered samples on PR #665 permit per-wave nearest-rank statistics. These are **application durations only**, with one wave at each load and no 24-request wave:

| Offered concurrency | n | Mean app ms | p50 app ms | p95 app ms | Max app ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 321 | 321 | 321 | 321 |
| 4 | 4 | 299 | 282 | 327 | 327 |
| 8 | 8 | 227 | 227 | 275 | 275 |
| 16 | 16 | 422 | 407 | 491 | 491 |
| 32 | 32 | 463 | 459 | 637 | 639 |

This pattern is **not linearly increasing** across the recorded waves. There is an elevated 16-request distribution relative to eight, with a wider 32-request tail; however a saturation cliff at 16/24/32 is **not established** without repeated randomized waves and 24-request measurements. These runs cannot distinguish queueing from changing per-operation latency, actual throughput plateau, or load-generator scheduling. Do not infer provider CPU percentage, connection-pool occupancy, or achieved RPS from application samples alone.

## Follow-up: SQL-class attribution and mandatory next architecture decision

The same Cloudflare staging span data was classified by the **known query shape** rather than by individual SQL text or an invented per-request queue metric:

| UTC window | D1 all() operation class | Paired spans | Mean wall | Mean SQL | p95 wall |
| --- | --- | ---: | ---: | ---: | ---: |
| 20:31:30–20:33:30 | Bounded primary popularity/current-rights query | 57 | 610 ms | 2.68 ms | 1,731 ms |
| 20:31:30–20:33:30 | Other SQL | 58 | 377 ms | 2.10 ms | 1,054 ms |
| 20:27:30–20:29:30 | Other catalog search | 7 | 1,929 ms | 70.35 ms | 4,369 ms |

Across 20:15–20:40 UTC, 23 actual `search_synonyms` D1 spans averaged 100.96 ms wall, 0.1283 ms SQL, p95 wall 208 ms. Reading the source revealed that `ftsExpression()` calls `synonyms(db)` even on zero-token guest browsing; draft PR #669 contains a guarded elimination plus runtime test. **This is evidence of an avoidable database operation, not measured end-to-end improvement from the patch.**

After the overload-fallback change and the zero-token synonym-read elimination, **stop tuning this subsystem until controlled stage measurement proves a meaningful gain.** The latest full rights-query span p95 was still 1,731 ms despite SQL mean 2.68 ms. Therefore the next architectural decision must compare no-D1, rights-only and full catalog at identical offered arrival rates, including transport and CPU controls. If rights-only alone collapses, prefer an alternative authorization-serving topology or a drastically smaller primary round-trip count over another index/rewrite. Never use eventually consistent R2/KV presentation to authorize withdrawn rights.

Draft PR #668 implements these isolated controls and passed its functional/source CI, but live stage use was blocked: the Cloudflare connection could list synthetic D1 `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3` and inspect its existing Worker binding yet could not GET, query or attach it through the D1 API. The attempted stage Worker upload failed; the existing stage driver code/deployment, credentials and no-cron state remained unchanged, and its original ingress state was restored. No production resources were substituted. This is an access blocker, not a passing test.

## Failure-induced D1 write amplification: new competing mechanism

Inspection of the **currently deployed source topology** reveals a distinct service-pressure hypothesis that a SQL-only campaign would miss:

- `src/features/fore/api.server.ts:handleCoveApi()` calls `recordHttpRequest()` for 5xx responses unless the caller already receives an explicitly isolated *successful anonymous* metric.
- `src/features/fore/operations.server.ts:recordHttpRequest()` attempts a D1 batch containing **three** writes: `ops_http_requests`, `ops_trace_spans`, and `ops_metric_points`. The batch may run in `waitUntil`, meaning it can still exert shared-D1 pressure even when it does not delay that response's first byte.
- `recordErrorEvent()` independently avoids a D1 write when it recognizes primary-D1 overload, but this does **not** prevent the request-level three-statement batch. The production primary D1 also supports scheduled/maintenance workloads. No observation yet proves these audit writes cause the 10-second resource-window failures.
- `anonymous-http-metric.server.ts` intentionally rejects 5xx events from the separate Analytics Engine path; do not silently bypass durable failure/security audits to make a green result.

**Falsifiable experiment**: on the isolated synthetic stage database, replay an equal, predefined mix of 200s/503s (including identical failed-request volume) against otherwise identical serving code. In one group preserve all three ops writes; in the other route only confirmed public/anonymous staging 503 diagnostics to an independent sink, retaining a low-cardinality runtime error and all 401/403/429, account, payment, writer and rights audit handling. Record D1 batch operations, SQL vs wall time, service error rate, achieved RPS, Worker CPU, end-to-end first byte and identical log evidence. A healthier test with missing audit evidence is **invalid**. Do not activate this variant on production absent explicit review, durable audit retention and rollback rehearsal.

**Architectural alternatives after the required reset**: (1) keep writes on the primary rights database and reduce event counts only with evidenced backpressure; (2) move nonauthorizing HTTP operation telemetry to an independent, appropriately durable queue/storage service, with separate security and commercial audit routing; (3) use an independent telemetry collector with bounded loss/error policy and prove compliance with the operational audit requirements. **Decision for now**: instrument/measure before choosing. Do not tune more SQL or claim D1 queueing causality from paired outside-SQL observations alone.

## Production hotfix integration checkpoint

The independent D1 parameter-limit repair in PR #666 passed its seven premerge CI workflows and was merged to `main` as `a2735e9bc36177fc3c9b1ecdc586ed37036fd0bd` on November 14. This only changes the verified recommendation candidate array binding (`json_each(?)`) and its tests; it does not certify live recovery, guest catalog availability, Stripe LIVE, legal authority or geographic 100-RPS acceptance. Verify that the deployment actually completed and monitor the recommendation error family before claiming successful remediation.
