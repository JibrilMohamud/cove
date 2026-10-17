# Cove Cloudflare-native SSR: staging and commercial release gates

Status: **the strict 800 ms synthetic gate has passed on three independent
authenticated staging deployments; production cutover is still blocked**.
Do not equate a single-runner, protected-workers.dev success with a sustained
global customer-facing SLO.

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

### Remaining customer-facing blocker

The existing Vercel homepage remains the actual public product. Its fresh
October 17 20-request recheck restored SSR books on 20/20 requests after a
transient failed canary, but **two cold responses still exceeded 800 ms**
(1,589 ms and 1,421 ms). That is not an accepted production TTFB SLO.

The connected Vercel project has only its `cove-puce-theta.vercel.app`
hostname; the connected Vercel account has no registered owned domain, and
the connected Cloudflare account has no managed DNS zone/Worker custom domain.
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
