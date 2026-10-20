# Synthetic-only informational request telemetry isolation

## Evidence and experiment purpose
The full API currently writes one D1 batch containing **three records per
request** to `ops_http_requests`, `ops_trace_spans`, and `ops_metric_points`.
In `handleCoveApi`, `ctx.waitUntil` queues that write after response
construction, but the write still competes with other requests for the same
primary D1 service capacity. Unhandled application errors also write to
`ops_error_events` and must retain their own durable audit path.

The PR #230 Cloudflare experiment passed 50 RPS anonymous HTML requests
(1,000/1,000; maximum about 170ms) but failed 100 RPS (p95 about 884ms,
maximum 1,577ms). Its 50 RPS mixed load failed before the scheduled horizon.
**Those results do not prove operational telemetry caused either failure.**

This independent branch (based on #230, NOT #231) tests the cost of ONLY
the request-telemetry batch. It does not change the D1 rate limiter,
authoritative rights checks, catalog logic or backend business operations.

Only these paths can use console-only request telemetry:
- anonymous `GET /api/fore/catalog` with HTTP 200
- anonymous `GET /api/fore/recommendations/home` with HTTP 200
- anonymous `GET /api/fore/merchandising` with HTTP 200

The opt-in requires **all** of:
- `COVE_SSR_STAGING=1`
- synthetic staging D1 ID `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3`
- `COVE_PERF_TELEMETRY_MODE=console-only` (set only on experiment CORE)
- no application identity or session headers, no authenticated user, GET, and HTTP 200; the synthetic stage bearer may be present only when it exactly matches the 64-hex Worker gate secret already verified by CORE

Every request still produces the structured Worker console event with route,
trace and request IDs, status and measured duration, which remains accessible
through stage Worker observability. No raw request identity, book purchase,
reader, checkout, security or API exception data is redirected. All 4xx/5xx
responses, all authenticated traffic, and **all production D1 request
telemetry** keep their previous persistence behavior. Exceptions still follow
the independent `ops_error_events` durable write path.

## Decision gate
Run fresh-deployment, 1/4/8/16/32, 100-RPS HTML, independent 25/100-RPS D1
phase attribution, strict 50/100-RPS mixed traffic and rights-revocation
tests against the **same artificial D1** and paired immutable commits.
Compare this independent change against baseline #230 and #231's distinct
rate-limiter experiment. Any failing route/latency/rights gate blocks merge.

## Explicit production migration blocker
Cove's operational dashboards and incidents rely on the durable D1
`ops_*` tables. Merely dropping request telemetry writes in production
would reduce monitoring and audit completeness. Before production adoption,
create a dedicated retained analytics sink (e.g. supported Cloudflare
Analytics Engine/Logs with configured retention and access controls),
reconcile counts/traces, migrate incident/SLO queries, and document failure
fallback and sampling policy. `ctx.waitUntil` alone is not sufficient
isolation: even asynchronous D1 writes still compete with critical reads.
