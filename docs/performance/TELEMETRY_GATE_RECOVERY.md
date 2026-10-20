# Synthetic telemetry experiment: verified activation and accurate D1 error labels

This branch depends on the independent telemetry experiment (#232), not
rate-limit experiment (#231). No production data, rights checks or routes
are changed.

## Root cause correction
Actual historical Cloudflare Worker error logs from #231 and #232 run #28:
`D1_ERROR: D1 DB is overloaded. Requests queued for too long.`
The prior diagnostic wrongly matched generic `D1_ERROR` before overload,
calling these missing-schema failures. No missing SQL table or migration
has been demonstrated; do not patch schemas based on that false category.

## Changes
- Candidate synthetic-only anonymous API HTTP 200 now includes
  `x-cove-perf-telemetry: worker-log` only when the D1 request/trace/metric
  writes are bypassed. Existing Worker structured logs remain.
- Three independent API probes record HTTP status, request ID,
  sanitized failure classification and bypass activation; absence of
  the marker or API payload correctness fails the run.
- Specific D1 overload category precedes generic D1 errors in the classifier.
- A longer post-deployment control-plane propagation interval reduces
  transient staging secret/version mismatch. It does not prewarm the Worker
  or hide/retry 401. A 401 still causes cold validation failure.

## Remaining release work
Run repeat independent attribution for #231 and this telemetry branch.
Prove original primary-D1 rights revocation, 60/60 cold without HTTP 401,
full homepage, all mixed routes and 100RPS max under 800ms, actual-cover
mobile LCP and broad customer journeys before any merge or cutover.
