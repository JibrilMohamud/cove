# Commercial storefront: isolated completed-metadata cache experiment

**Status: experiment, not a production or merge approval.** Starting point: PR #227 at
`d7895673ced34983f66a898ce74f5f94064b7ff7`. This branch retains all
strict 60-cold, repeated 1/4/8/16/32-request, 50 RPS, LCP, authoritative
rights/revocation, search, browser and regression gates.

## The measured problem

The immutable independent PR #227 artifacts (runs 39346770762 and
39347276095) both completed 50-RPS/20-second stages with 1,000/1,000 valid
requests, but both 100-RPS stages exceeded the unchanged 800-ms hard limit
(about 1,600–1,619 ms maxima). They each had 0 application errors but 1 and 27
client-dropped arrivals, respectively, as well as mid-run colo changes.
These remain failures.

Per-response `server-timing` from the saved 100-RPS artifacts reveals a
different leading stalled stage in each campaign:

| Campaign / colo | Requests | HTML p95 (ms) | Context p95 (ms) | Primary catalog p95 (ms) | Catalog SQL p95 (ms) |
|---|---:|---:|---:|---:|---:|
| A / ORD | 1,704 | ~1,310 | ~1,289 | ~139 | ~8.4 |
| A / ATL | 295 | ~484 | ~403 | ~395 | ~7.4 |
| B / IAD | 1,809 | ~1,143 | ~1,108 | ~1,106 | ~6.3 |
| B / LHR | 164 | ~1,561 | ~1,465 | ~1,423 | ~7.0 |

**Interpretation:** D1 service/queue/transport time under 100 RPS appears much
larger than actual SQL execution. This does not prove one isolated root cause:
the bottleneck and colo changed, and all p95 quantities are independent
distributions that must **not** be subtracted as causal spans. A separate
same-colo, same-client, A/B capacity comparison remains necessary.

## Isolated change

`src/storefront-thin/presentation-cache.ts` caches successfully resolved
**public** country/locale/payment-presentation and homepage copy for two
seconds, bounded to 64 country/language keys. Exactly the same
`firstPaintStorefrontShelf()` primary-D1 query runs on **every** request.
The same distinct client limiter runs on **every** request. Cache misses
each own their pending D1 read (no cross-request promise or D1 session sharing).

A strict switch, `COVE_THIN_METADATA_CACHE=1`, together with the existing
synthetic-only staging flag and exact allowlisted artificial D1 ID, is
required for any cache hit. Production and regular SSR never use this
optimization. The production D1 ID and existing deployment/routing are
unchanged. A cached context is cloned on reuse, has a 2-second maximum
staleness window, never includes user, entitlement, book offer or grant data.
Cookie/auth-bearing requests bypass this path. Wrong-country resolved
metadata is rejected rather than cached. Failed reads are never cached.

This is a **bounded presentation staleness experiment**, not approved for
a live market-status/currency change workflow. For potential production
adoption, separate versioning/invalidation of presentation metadata and
full locale/market/published-page parity must be demonstrated. Rights and
checkout must remain primary-authoritative regardless of UI state.

## Verification and rollout constraints

- `node scripts/check-thin-presentation-cache.mjs`: completed-only reuse,
  cloned values, expiry, bounded keys, staging/DB restrictions, distinct
  countries/languages, oversized and identity header bypass, concurrent
  misses, backend outage and wrong-country fail-closed behavior.
- `node scripts/check-thin-storefront.mjs`: unchanged full rights fixture
  path (US/CA/SA/JP), immediate revoke/inactive rights exclusion, forged geo,
  limiter/outage, identity fallback and escaping.
- `cloudflare-thin-storefront-paired.yml`: reruns three fresh isolated
  deployments, repeated concurrent requests, actual mobile Chromium,
  delegated search and safe capacity stages against synthetic D1 only.
  Because this comparison pits full SSR against the new cached thin
  candidate, it is a capacity gate but **not** a causal cached-versus-uncached
  comparison; a separate paired A/B is necessary for attribution.

Do not merge the stacked experimental branch or change production traffic
based on the metadata cache alone. PR #227's documented interaction-parity,
real-cover mobile LCP, territorial geographic validation, mixed-load
soak, 100-RPS isolation and rollback/canary blockers remain outstanding.
