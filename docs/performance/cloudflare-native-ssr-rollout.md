# Cove Cloudflare-native SSR: staging and commercial release gates

Status: **NOT commercial-release ready.** Earlier protected staging deployments
passed 20/20, but the latest independent cold redeployments missed the strict
800 ms limit. The live Vercel homepage also fails the complete 20-request gate.
Never infer sustained global performance from a single green staging matrix.

## Why the architecture changes

The production Vercel SSR canary from October 17, 2026 returned 24 cards on
20/20 attempts, but only 16/20 TTFB observations were strictly below 800 ms
(p75 652 ms; p95 1,438 ms). The warm path was often 230–400 ms. Multi-second
cold requests can stall the cross-provider Vercel-to-Cloudflare bootstrap.

Cloudflare-native SSR uses a request-scoped D1 binding and immutable Worker
country metadata, avoiding that external HTTP bootstrap. It does **not** remove
the need for per-request territorial rights checks.

## Staging mechanics

- Separate `cove-storefront-ssr-staging` Worker; no routes or domains on
  production. Existing Vercel storefront remains the public source.
- `wrangler.frontend.staging.toml`: real D1 and R2 bindings, no background
  migrations/triggers, `workers_dev=true`, `assets.run_worker_first=true`.
- `COVE_SSR_STAGING=1` fails closed if its distinct 256-bit staging secret is
  missing. Requests to HTML, API **and assets** require Authorization Bearer.
- Only GET and HEAD are allowed. Bearer credentials are stripped before
  any application handler and are never included in logs, metrics or artifacts.
  Every staged response is no-store and noindex.
- Staging secret is rotated in the private GitHub Actions runner after each
  deployment; neither source nor build output contains the value. Never
  substitute Cloudflare API credentials as site auth.
- The staging gate is not a customer authentication mechanism and must NEVER
  be disabled to expose this staging Worker publicly.

## Validation

The `cloudflare-native-ssr-staging` workflow compiles and dry-runs the Worker
on PRs. Reviewed main pushes deploy **staging only** using the existing
Cloudflare API token, rotate its runtime bearer secret, and run tests that fail
if any of the following occur:

1. Anonymous homepage or asset requests are not denied.
2. An authenticated POST is accepted.
3. A spoofed HTTP country header changes the observed licensed catalog.
4. A request fails to render an SSR book shelf or loses the
   `cove_ssr_local_rights` timing evidence.
5. Any of 20 interleaved language/sample requests has TTFB >= 800 ms.
6. Any staging response can be publicly cached.

The staging benchmark is synthetic and from a single runner geography; it
does not replace field Web Vitals or legal QA in multiple countries.

### October 17, 2026 validated staging evidence

Following PR #128's combined active-market and supported-locale D1 read,
three independent protected staging deployments each completed the full
20-request interleaved five-language matrix with 24 SSR book cards per request.
Every run also required working native D1 binding, the immutable Cloudflare
country assertion, anti-spoof legal availability, an authenticated read-only
gate, and no-store/noindex HTML.

| Staging run | Under 800 ms | p75 TTFB | p95 TTFB | Slowest TTFB |
| --- | --- | --- | --- | --- |
| Initial deployment | 20/20 | 378 ms | 461 ms | 593 ms |
| Independent repeat | 20/20 | 318 ms | 541 ms | 710 ms |
| Independent repeat | 20/20 | 538 ms | 680 ms | 711 ms |
| **Combined** | **60/60** | — | — | **711 ms** |

Proof: [GitHub Actions main-push staging workflow](https://github.com/JibrilMohamud/cove/actions/runs/39075953701).
The three separate deployment attempts appear under that run's job history.
This is not yet a multi-geography, multiday load-test result. The workflow
also runs a **daily** authenticated stage-only rights/performance gate; failures
remain visible in GitHub Actions. No scheduled job routes public traffic.

### October 17 native cold-deployment regression and placement experiment

PR #131 removed the anonymous first-paint D1 rate-limit write and
verified an authenticated staging **20/20** below 800 ms (p95 384 ms,
max 476 ms) with 24 real, live-rights-cleared SSR book cards each.
However, a separate deployment of the *same commit* immediately produced
**10/20 misses**, with slowest 3,612 ms; all books still appeared.
The first ten calls incurred elevated, inconsistent `cove_backend_context`
and `cove_backend_catalog` durations, while the final ten settled
to 250–475 ms. Evidence:
[repeat benchmark](https://github.com/JibrilMohamud/cove/actions/runs/39080119397).
This disproves any claim of a sustained cold 20/20 SLO after PR #131 alone.

Read-only D1 metadata reports the current primary in Cloudflare colo
**ORD / ENAM** (Chicago) as of this check. Cloudflare's explicitly
supported `placement.region` mode can place a Worker near a fixed cloud
region before it has collected Smart Placement traffic. The staging-only
trial therefore uses `region = "aws:us-east-2"` instead of `mode = "smart"`;
it must pass independent cold-deployment matrices before claiming a reliable
improvement. This is a geography/runtime-placement experiment, not an
authorization, rights cache, or production route change.

The **independent fixed-Midwest-placement trials have now failed** even though
all 20 responses retained 24 server-rendered, live-rights-cleared books:

| Explicit-placement cold run | Requests strictly below 800 ms | p75 TTFB | p95 TTFB | Slowest |
| --- | --- | --- | --- | --- |
| Initial deployment | 16/20 | 646 ms | 982 ms | 1,009 ms |
| Independent redeployment | 15/20 | 725 ms | 909 ms | 1,141 ms |

Evidence: [staging workflow and two independent benchmark attempts](https://github.com/JibrilMohamud/cove/actions/runs/39080728108).

Sanitized request timings in the first trial show Worker processing below
450 ms on every sample, yet four end-to-end TTFBs reached 815–1,009 ms.
For example, the 982 ms request included only 135 ms within the Worker.
The remaining measured interval is **unattributed edge/transport/scheduler
overhead**, not evidence of a slow territorial-rights SQL statement. In the
independent repeat, four of five misses similarly contained over 500 ms
outside Worker processing; one additionally spent 712 ms inside SSR despite
short recorded D1 phases. The latter merits a cold module/SSR investigation.
Further SQL tuning alone cannot remove the unexplained external delay.

These failures MUST remain release blockers. Do not warm the endpoint before
sampling, loosen the threshold, skip late response anomalies, stream an empty
HTML shell before live book authorization, or use a static regional catalog
to manufacture green TTFB results. The next accepted experiment must
differentiate ingress/connection/placement latency from cold SSR module
initialization, retain all territorial-rights protections, and reproduce
zero misses across independent geographic and cold deployment matrices.

The latest October 17 Vercel public check failed with **17/20** complete
under-800-ms+SSR-books samples: two slow populated responses at 3,282
and 6,777 ms, plus one 8.4-second empty bootstrap timeout.
[Public run](https://github.com/JibrilMohamud/cove/actions/runs/39080119384).
The public route remains unchanged and fails the SLO.

### Ingress-edge experiment (pending independent evidence)

The fixed Ohio experiment left frequent 500–850 ms gaps between client TTFB
and measured Worker processing. The next staging-only trial deliberately
**removes placement entirely**, so the Worker runs near Cloudflare ingress
instead of a fixed Midwest region. This may lower request transit while
increasing D1 round trips to the ORD primary; neither outcome is assumed.

The protected staging gate now counts the **first authenticated homepage SSR
request before** the D1 health and bootstrap/rights preflight, which previously
warmed SSR before the 20-request test. All 20 requests must still be below
800 ms with real live country-scoped books, no-store responses, native D1
rights authority and no exceptions. Synthetic artifacts include only numeric
client/Worker duration, unattributed residual, Undici request-to-headers
timings, and the three-letter Cloudflare colo (no raw CF-Ray identifiers).
A single successful run is insufficient: repeat genuinely fresh deployments
and additional geographies before production routing.

### Ingress-edge independent results (October 18 UTC)

The first protected deployment of merged PR #133 passed **20/20** (p95 444 ms,
max 640 ms) with 24 live-rights-checked books per response. CF-Ray colo was
IAD on every request. The first genuine homepage SSR response, measured
before the D1 health/bootstrap warmup, took 640 ms.

The independent redeployment of the identical commit failed **18/20**
(p95 832 ms, max 1,152 ms), with the two misses at 832 and 1,152 ms.
This time every request entered through **LAX**. All 20 still rendered
24 authorized books. Unlike the fixed-region trial, these misses largely
occurred *inside* the Worker: the 1,152 ms request reported 1,099 ms total
Worker duration and a 53 ms unattributed residual. The 832 ms request
reported 718 ms Worker duration and a 114 ms residual. Hence edge-local
execution does not meet the globally repeatable hard SLO. Comparison:
[main deployment and independent job attempts](https://github.com/JibrilMohamud/cove/actions/runs/39082829021).

The LAX run's logged backend context, catalog and page timings do not account
for the full bootstrap handler duration in some slow samples. The next
diagnostic adds allowlisted auth and aggregate API/telemetry phases before
optimizing any potentially costly per-request work. Enabling a geographically
near replica or caching rights without a carefully demonstrated authoritative
country/revocation-consistency model is **not** an acceptable shortcut.

### October 18 west-coast cold-path diagnosis and next experiment

The next protected stage run after PR #134 entered **YVR** (Vancouver) and
failed the strict gate with **10/20** successful under-800 ms requests,
p95 **3,681 ms**, max **4,468 ms**. Each response still rendered 24 live
rights-cleared cards. Worker duration accounted for nearly all the long
requests, with only 40–83 ms residual on the largest misses.
[Staging run](https://github.com/JibrilMohamud/cove/actions/runs/39083846180).
At sample 16, the measured context step took 1,450 ms and the first-paint
catalog phase 1,149 ms (several independently remote D1 requests each).
The edge-local Worker cannot reliably obtain authoritative Midwest D1 data
within 800 ms from all runner regions.

The next first-paint experiment runs the independent Cloudflare abuse-limit
check and live list of active markets in parallel with resolving the
visitor's market/locale/rights context. It still awaits **all three** before
building/rendering any book; context, approved-market and rights
queries retain their D1 source and the limiter cannot be bypassed. It
adds a numeric `cove_limit` phase to track the impact. This optimization
removes unnecessary ordering, not strong geographic read latency, and needs
independent cold-deployment proof before any release claim.

### October 18 single-statement first-paint rights selection experiment

The first independent cold staging deployment following PR #135's parallel
context/markets/edge-limit preflight failed **12/20** (p95 3,067 ms;
max 5,464 ms) through LAX, with all 24 rights-cleared book cards retained.
The limiter accounted for approximately zero milliseconds and even parallelized
D1 context and catalog calls suffered independent 0.7–5 s outliers.
[Protected CI benchmark](https://github.com/JibrilMohamud/cove/actions/runs/39084662498).

The next trial replaces the homepage's two sequential reads (rights-filtered
candidate IDs, then product hydration) with **one SQL statement**:
a materialized 25-item eligibility CTE is joined to the same lean book-card
projection. Candidate selection still uses the original live D1
`retail_product_availability_rows` filter scoped to trusted network territory.
The one-statement query observes consistent rights and product data in a
single authoritative database snapshot, with no regional/rights cache.
Existing multi-territory fixture comparisons must remain identical to
the regular live catalog API, or the change cannot ship.

### Remaining customer-facing blocker

The existing Vercel homepage remains the actual public product. The most
recent October 17 20-request canary failed **three complete checks**: one
empty SSR result after an 8.4-second bootstrap timeout, and two populated
responses at 3,282 and 6,777 ms. This is not an accepted production SLO.
Earlier 20/20-book-availability reports are historical, not the latest state.

The previously verified Vercel public hostname is
`cove-puce-theta.vercel.app`. The connected Cloudflare account was rechecked:
**zero managed DNS zones** exist as of October 17. Rechecking Vercel's
account/project domain inventory currently requires restored authorization
(the domain API returned HTTP 403), so no new owned-domain availability is
claimed.
Domain acquisition or connection remains an explicit owner prerequisite.
A staging workers.dev URL and a Vercel-owned vercel.app hostname cannot be
substituted for an owned, verified Cloudflare production route.

Production currency/localization coverage is separate from interface-language
support: current search documents use USD while several configured regional
markets require other default currencies. Do not bypass local price/offer
validation, infer permissions from UI locale, or expose unauthorized editions
just to populate their shelves.

## Preconditions for commercial rollout

**Blocking infrastructure prerequisite:** a custom domain whose DNS/zone is
controlled in this Cloudflare account. At the October 17 check, the account had
no eligible DNS zones or Worker custom domains. Cove's existing
`*.vercel.app` hostname is Vercel-controlled and cannot simply be converted
into a Cloudflare zone. Do not silently proxy through Vercel: a Worker would
then observe the proxy's geography instead of the visitor's, invalidating
the territorial rights model.

Before routing public traffic to the new frontend:

1. Establish an owned Cloudflare-managed zone and HTTPS domain; confirm
   canonical redirects, cookie scope, OAuth callbacks, Supabase and Stripe
   return URLs, social share URLs, and search indexing. Do not buy a domain
   or incur new recurring costs without approval.
2. Prepare a **separate** production SSR Worker configuration with
   `workers_dev=false`, `COVE_SSR_STAGING` unset, no public access to
   staging credentials, the approved custom route, and direct D1/R2 bindings.
   Production cannot depend on a staging token.
3. Exercise unauthenticated browsing, authenticated library, notes, progress,
   reader/offline reopening, checkout and real authorized fulfillment in a
   production-equivalent environment. Ensure cross-origin assets and auth
   callbacks work without leaking session cookies or missing CSRF checks.
4. Run multi-country rights fixtures with trustworthy platform geography:
   US/Canada/U.K./EU individual countries/other unsupported markets, a
   denied/unknown country, direct country-header forgery, and account
   preference conflicts. Products must never escape authoritative territory.
5. Test mobile Safari, iPad Safari, desktop WebKit, Firefox, Chromium,
   Android Chrome and a native screen reader.
6. Measure at least the strict 20-request all-language synthetic canary on
   the **new public route**, followed by independent cold-start and load
   testing across several geographies/times of day. A single green sample is
   not a sustained latency SLO; require zero misses in the agreed acceptance
   window and collect p95/p99, errors, card delivery and region attribution.
7. Establish rollback: retain original Vercel deployment, a tested DNS/route
   reversal, and alerting for <800ms misses, empty shelves, rights mismatch,
   5xx, checkout/reading errors. Switch back immediately on legal or reader
   regressions.

**No automated public cutover is included.** This requires both an owned
zone and successful authenticated/prod-equivalent verification; the staging
workflow deliberately cannot modify routes or DNS.
