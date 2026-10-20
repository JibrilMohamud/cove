# Experiment: stage-only isolated anonymous public-read rate limiting

**Draft / unmerged / no production routing.** Stacks on the failed PR #230.
The last run exposed two independent failure modes, and neither may be ignored:

* Thin homepage 50 RPS: 1000/1000 valid, max ~170 ms. At 100 RPS:
  2000 arrivals scheduled, 23 dropped by the client's 128-inflight ceiling,
  1977 valid, p95 884 ms and max 1577 ms. This is a real failing gate.
* The 50-RPS **mixed** stage stopped after 122 requests: 66 valid homepage
  requests, two invalid homepage 503s, and 54 invalid catalog/recommendation/
  merchandising requests (6 explicit HTTP 503, 48 client 8s timeouts).
  All three delegated APIs failed. They share D1-backed rate-limiter writes,
  D1-backed request telemetry, and an extensive full-application call path.

This branch isolates just ONE suspected write source: for the three public,
anonymous GET routes above, use the existing Cloudflare per-key limiter
instead of calling the durable D1 rate-limit write. All other API methods,
authenticated requests, user data, checkout, rights, and production paths
retain their existing policy. The binding's 180/min cap is no higher than
the existing D1 caps (the merchandising cap becomes stricter). This is an
**experiment, not a production rate-limit proposal**: it only activates if
all three conditions are simultaneously true: explicitly enabled flag,
isolated synthetic staging, and the exact allowlisted synthetic database ID.
No other staging database can opt in through a typo. A missing limiter
fails closed with a 503, never silently bypasses abuse control.

The anonymous rights query still reads the current primary on EVERY request.
There is no rights or availability cache, and the benchmark continues to
fail on rights, cold, 1/4/8/16/32, 100RPS, or mixed-load regressions.

To diagnose remaining 503s, the generic full-API error response adds a
bounded error *category* header only under the exact synthetic stage+database
gate. The header never includes SQL, messages, PII, secrets or exception
stacks. Normal customer responses are byte-for-byte unchanged.

If this A/B run fixes mixed-route 503s, isolate request telemetry writes next
and repeat strict 100RPS and geographical tests. If not, investigate API
business-logic exceptions and synthetic fixtures before changing rights or
moving any database. No unconditional claim of improvement is permitted.
