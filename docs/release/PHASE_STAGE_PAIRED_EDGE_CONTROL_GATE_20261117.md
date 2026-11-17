# Protected phase staging: paired edge-control comparisons

## Decision carried forward

The approved `cove-protected-canonical-phase-staging` run #24 tested
`db17f4cbcf5392f278bd3adfb82b3f4a7b93a643` with 120 successful
rights-authoritative homepage responses and 12 real TTFB failures at
`>=800ms`. SQL itself never exceeded 53.8ms in this run. Ten of the twelve
slow samples were dominated by the *measured* client-to-Worker residual; two
by the D1 REST pre-header interval. Neither label proves an infrastructure
provider fault.

PR #746 fixed the independently failing KV-dependent Wrangler stage cleanup.
PR #747 preserved bounded REST header/body/decode, request-to-Worker residual,
and runner dispatch timings in the archived stage evidence.

## Same-runner, adjacent 401 edge controls

This change places **eight immediately subsequent unauthorized HTTP GETs**
after **each** of the read-only authenticated 1/4/8/16 wave cohorts. The
stage workload remains **60 licensed + 32 anonymous controls**, exactly as
before. The controls are performed only **after** the three 20-request
cold-version trials and after each corresponding licensed wave. This does
not intentionally prewarm a fresh secret/SSR version before its first cold
HTTP request.

All 32 controls must return HTTP 401 **and** `Cache-Control: no-store`.
There are no D1 rights queries in the negative-control path. The independent
numeric evidence verifier requires exactly eight secure denials for each
of 1/4/8/16, matching summary counts, valid bounded timing values, and
a static code-reviewed paired ordering marker. A missing 401, malformed
metadata, duplicated control wave, extra control, or unpaired result fails
closed. Controls **never** count toward the 120 rights-positive reads.

The artifact retains only the fixed wave label and bounded per-cohort
control median/p95/max. These are an edge-dispatch **baseline**, not an
apples-to-apples proof of the authorized D1 transport cost: a 401 is a
different path with less work. In particular, subtracting the 401 latency
from the licensed latency to claim the remainder is SQL/REST work would be
invalid. Compare the independently timed SQL, REST, RPC and Worker durations
against same-runner queue, sent-to-headers and denied-control durations
without treating the residual as a single known cause.

## Nonnegotiable gating

- Exactly 3 x 20 fresh-secret, protected, primary-rights-positive cold SSR
  requests; every one <800ms, full HTML/cards and correct no-store.
- Exactly 60 1/4/8/16 authorized requests; every one <800ms, valid rights
  and complete SQL/REST/RPC measurements.
- Exactly 32 paired, fail-closed unauthorized 401 controls.
- Independent production Worker pin/legal-owner state checks; isolated
  Worker records parked at independently pinned deny-only versions; exact scoped Worker-deploy and D1-Read
  credentials; postflight rollback to deny-only 100% versions and disabled ingress verified.
- Passing this isolated 120-request stage check is **not** four-region
  ORD/LAX/IAD/DFW acceptance, 1/4/8/16/32 cold/warm hosted acceptance, two
  20-second 100-RPS phases, a fix for production SSR/503, legal owner /
  canonical writer exclusivity, LIVE Stripe fulfillment, or rollback.

No change in Worker production code, customer-facing routing, primary D1
writes, legal authority, bearer secrets, entitlement logic, or checkout.
Do not rerun production tests without manual protected environment approval.
