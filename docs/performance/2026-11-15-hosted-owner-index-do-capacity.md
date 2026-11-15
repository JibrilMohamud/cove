# Hosted owner-SQL indexed catalog capacity — independent staging evidence

**November 15, 2026; research-only. DOES NOT CERTIFY PRODUCTION.**

## Exact architecture under test

An independently provisioned, secret-gated Cloudflare Worker with a single
SQLite-backed Durable Object; stage branch #708 is stacked on isolated owner
SQL capacity branch #702. The owner DO has **no primary D1 connection and no
customer route**. It seeds 12 real free-source revision proofs and 13 real
paid grant/contract/version/offer proofs in actual canonical owner SQL
modules, and creates an owner-local **incremental catalog presentation index**.
The index provides exact default-scope ranked page, count and facets, and
uses SQLite dirty-trigger reconciliation inside the same mutation
transaction as a contract or source denial. Market denial is a direct,
strongly consistent owner tombstone veto.

This is **25 fake products**, not the 82,249-book real public catalog,
not all SearchInput filters, and not production Stripe.

## Failed first hosted run (MUST be retained)

[GitHub run #43758727582, attempt 1](https://github.com/JibrilMohamud/cove/actions/runs/43758727582):
stage seed succeeded, then the first single-request burst returned 0/1
valid, status-class 0 after ~88.86ms. The existing client combined
fetch/JSON failures into the status-0 class, so this attempt cannot
distinguish transport from a non-JSON edge response. It FAILED strict
capacity; do not average or erase it. The temporary Worker was deleted
in the guaranteed cleanup step and independently verified absent via
Cloudflare API (HTTP 404).

## Second independent staging Worker — PASSED

[GitHub run #43758955205, attempt 1](https://github.com/JibrilMohamud/cove/actions/runs/43758955205)
used a fresh name/storage namespace and added bounded client failure
classification without changing the actual Worker indexed-read behavior.

| Phase | Valid/offered | Dropped | p95 (ms) | p99 (ms) | max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| burst 1 | 1/1 | 0 | 53.07 | 53.07 | 53.07 |
| burst 4 | 4/4 | 0 | 336.01 | 336.01 | 336.01 |
| burst 8 | 8/8 | 0 | 452.81 | 452.81 | 452.81 |
| burst 16 | 16/16 | 0 | 352.56 | 352.56 | 352.56 |
| burst 32 | 32/32 | 0 | 284.69 | 383.66 | 383.66 |
| no-DO control 100RPS | 2000/2000 | 0 | 62.41 | 201.64 | 256.84 |
| index 50RPS 20s | 1000/1000 | 0 | 71.21 | 91.17 | 138.22 |
| index 100RPS 20s phase 1 | 2000/2000 | 0 | 75.61 | 187.86 | 320.39 |
| index 100RPS 20s phase 2 | 2000/2000 | 0 | 77.62 | 182.38 | 301.70 |
| concurrent contract denial | 600/600 | 0 | 80.46 | 141.65 | 255.99 |

All phase HTTP responses were 200 and all request failure-type
collections were empty. Valid achieved throughput: 99.77 and 99.76 RPS
for the two strict 100RPS campaigns. Each 100RPS phase included 100
separate no-DO controls, all valid (max 258.33/247.88ms).

The contract withdrawal was acknowledged while 100RPS reads continued.
289 requests started before acknowledgment; **311 started after ACK,
with zero old paid offers**. Subsequent free-source denial removed one
more product and stale free regrant was rejected. US market denial
removed all remaining availability. The full stage run's capacity and
revocation checks succeeded. Cleanup reported removed=true and the
Worker was **independently verified absent** afterward.

## Release status: BLOCKED

This evidence supports the *mechanism* of a fast, strongly consistent
owner-local index. It does not establish real production rights,
full-corpus catalog search/facet/envelope parity, long-running repeated
regional traffic, customer SSR 503 elimination, cold/warm four-colo
limits, physical exclusive writer control, Stripe LIVE, protected
downloads or protected rollback. Production flags, D1, routes, tokens,
payment data and customer grants were NOT changed.

An independently isolated retry of the original failed attempt was
initiated for reliability repeatability; record its outcome separately,
never rewrite the failed first attempt.
