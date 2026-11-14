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
