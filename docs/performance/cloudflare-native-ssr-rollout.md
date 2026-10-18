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

## Next controlled experiment: primary-anchored configuration sessions

Cloudflare D1 `cove-production` reports `read_replication.mode=auto`, but
replicas do not participate in plain D1 binding reads. In the **first-paint
SSR configuration path only**, use a fresh D1
`withSession("first-primary")` session per concurrent reader for storefront
context/market metadata. The first query obtains an authoritative primary
bookmark, and later queries cannot observe older data, even if Cloudflare
routes them to a replica. The actual book shelf continues to execute through
`env.DB` directly, without Sessions API; checkout, ownership and EPUB
downloads are untouched. The local fixture test asserts that all live
`retail_product_availability_rows` reads use the authoritative binding, never
a potentially lagged replica.

The protected staging workflow now runs **three independent Worker
deployments** per main execution, regenerates the staging bearer secret for
each version, counts the first authenticated SSR HTML fetch *before any other
HTTP request* (including a 401 check), and fails the complete job if **any**
20-request matrix contains a >=800 ms response or invalid rights. Preserve
every run's JSON evidence. A green single-run or two-run subset can no longer
conceal a failed independent deployment.

These improvements cannot remove all unpredictable platform/network tail
latency. No global hard SLO has been established by the code change alone.
External geographically distributed checks, owner-controlled DNS, correct
OAuth/checkout callbacks, and real paid/offline customer tests must pass before
public routing is switched.

### First-HTTP cold gate: deployment propagation incident

The October 18 three-deployment workflow on PR #137's merged source
correctly counted each new version's very first HTTP request as SSR. Two
first requests received **401** because Cloudflare had not yet installed
the newly rotated, independent staging bearer secret at that entry edge.
One independent rollout passed **20/20, p95 421 ms**. Another missed the
hard latency gate on **five otherwise valid SSR requests** (maximum
3,071 ms) with large primary-anchored D1 market/context phases.
[Production-source stage trial](https://github.com/JibrilMohamud/cove/actions/runs/39087445858).
These are genuine release blockers; earlier green passes are not sufficient.

To avoid confusing *secret propagation* with cold Worker execution, the
revised workflow waits ten seconds **without sending any HTTP request**
after publishing the new secret. The next request remains the first actual
HTTP/SSR request to the new version, and every HTTP error/TTFB sample
continues counting. This is a staging-only deployment-readiness delay, **not**
a warmed handler, rights snapshot, retried/discounted probe, or an extension
of the 800 ms limit. If propagation still fails, the deployment fails.
Any true D1 slowness still fails separately.

### Anonymous storefront metadata: geo-near replica experiment (unvalidated)

D1 reports `read_replication.mode=auto` but the primary-anchored
`withSession("first-primary")` experiment still had five true >800 ms
home SSR requests in a three-deployment trial. Next try
`first-unconstrained` **only for anonymous first-paint locale/market
presentation metadata**, routing the first config query to a nearby D1
replica when available. First-party logged-in visits continue using
`first-primary` for saved preferences. The real country-scoped book shelf,
purchase/subscription grants, EPUB rights, and checkout always query the
authoritative D1 primary using the original binding; this is enforced in
fixture tests. UI payment methods/market labels from read replicas may be
briefly stale, so **no cutover** is allowed until revocation and market-pause
fixtures show the full browser-to-checkout journey fails closed against
primary D1. Do not use this replica read to validate authorization or legal
territory. Assess separately whether any market UI staleness is acceptable.

Strict performance remains a **hard** 20/20 for each of three independent
versions, including the very first SSR fetch, with no waived samples and
independent geographical trials. A favorable replica location cannot turn
network variability into a guaranteed per-request SLO.

### October 18 lean anonymous Worker bootstrap: independent cold validation

Merged PR #142 moves *only* a truly guest, country-verified homepage
bootstrap onto a smaller module graph. It avoids importing the complete
account, commerce, audio, publishing, ingestion and rights-management API
on the first anonymous SSR. Four-market fixture parity and primary D1
product-rights assertions passed. The protected first-HTTP canary requires
a numeric `cove_backend_lean;dur=0` proof, one country-authoritative shelf,
live D1, and strictly `TTFB <800 ms`.

The first independent three-Worker deployment gate on the merged commit:
[CI test](https://github.com/JibrilMohamud/cove/actions/runs/39090722952).

| Separate Worker deployment | Requests <800 ms | p95 | Slowest request |
| --- | ---: | ---: | ---: |
| Cold deployment 1 | **20/20** | 461 ms | <800 ms |
| Cold deployment 2 | **19/20** | 379 ms | **1,054 ms** |
| Cold deployment 3 | **20/20** | 363 ms | <800 ms |

All responses rendered 24 rights-checked books via the lean backend.
The sole miss was the **very first** LAX-edge request on deployment two:
1,054 ms client TTFB, of which 278 ms was measured Worker processing;
776 ms was outside measured Worker duration (38 ms client queue and
987 ms sent-to-headers including network/remote time). All later requests
in that deployment were <=379 ms (excluding cold outlier). The
all-or-nothing release gate **correctly failed** at 59/60. The cold-path
optimization removed most server-side delays but cannot certify global
network ingress/cold routing under the absolute threshold.

A separate three-version redeployment is required to test consistency.
Do not claim the hard gate passes based on 59/60, p95, or warm responses.
Even a later 60/60 pass must not erase the earlier miss. Preserve staging
read-only protection, authoritative legal rights and public Vercel fallback.

### Cloudflare secret/version settlement and cold connection attribution

Two sets of three independently deployed lean SSR Worker versions delivered
**118/120** sub-800 ms responses, but *each* run failed exactly the first
request of its second deployment (1,054 ms via LAX, then 977 ms via IAD).
These failures cannot be excused by favorable p95 or warm requests.
The first LAX miss had only 278 ms Worker execution and 776 ms
unattributed client-to-Worker time; the IAD miss had 583 ms inside Worker
and 394 ms outside. This is a routing/network/deployment-startup tail
question, not evidence that legally authorized book queries are always slow.

The next staging experiment observes Cloudflare's **Worker Deployments API**:
the newest post-rotation secret version must be explicitly targeted at 100%
and have a 30-second settle age. This is queried solely through the
Cloudflare **control plane** using the deployment token; no HTTP request is
sent to the Worker during the wait. Its first HTTP request is still a
counted, true first-isolate SSR request, not a prewarmed or retried sample.
Readiness fails closed if the API lacks permission, the version is older,
or it is not exclusively deployed at 100%. This does not guarantee
global propagation or remove client transport variability.

The client probe also records numeric Undici new-connection time (when
a new connection occurs), separately from the Worker duration,
client queue and total TTFB. No socket addresses, account IDs, raw
CF-Ray values, cookies or credentials enter performance artifacts.
Repeat the same three independently cold 20-request deployments with
this evidence before making any production or reliability claim.

### October 18: separate Worker execution from deployment/connection tail

The lean SSR main-branch implementation's first three-version protected test
passed **59/60** requests. Two independently cold versions were 20/20;
the single miss was the first LAX-edge request of the middle version:
**1,054 ms** client TTFB, **278 ms** measured Worker duration and
**776 ms** unattributed transport/deployment overhead. An independent
three-version rerun also passed **59/60**: the middle version's first
IAD request took **977 ms**, with **583 ms** inside the Worker and
**394 ms** outside. All 120 homepage HTML responses displayed 24
live-authorized books. These two 59/60 results are **both release failures**,
not an acceptable rounding of the all-requests hard gate. Sources:
[initial run](https://github.com/JibrilMohamud/cove/actions/runs/39090722952),
[rerun of independent stage job](https://github.com/JibrilMohamud/cove/actions/runs/39090722952/attempts/2).

The next staging experiment queries Cloudflare's **deployment control plane**
after a new ephemeral bearer secret is installed. It waits until the latest
secret-triggered Worker version is routed at 100% and a 30-second settlement
period has elapsed. It **does not send any HTTP request to the Worker** before
the first counted SSR sample. A control-plane report is not proof that
every edge has converged or that cold-starts are solved: the *actual first
request*, including any connection/route delay or failure, remains part of
the strict threshold.

The probe additionally retains numerical client TCP/TLS connection time
(if a new Undici connection occurred) alongside existing request-to-headers,
Worker duration, residual, and CF-colo diagnostics. Credentials, addresses,
connection details and request IDs are never retained. **All three**
deployment JSON artifacts are kept even when the combined CI gate fails.
Continue multi-geography and customer-journey validation; do not public-cutover
or claim a per-request global SLO from favorable synthetic samples.

### Deployment-control-plane settling trial — October 18, 2026 UTC

Merged PR #144 waits for Cloudflare to report the newly rotated secret Worker
version at **100%** routing and another 30 seconds of deployment-settling
time **without any Worker HTTP fetch**. It preserves all three JSON files,
including failed runs, and now reports optional numeric Undici connection
duration alongside Worker duration and unexplained ingress/transport time.

The first independent three-version protected staging validation still
**failed 59/60**, with exactly one cold first-request miss:

| Independent new version | Result <800 ms | p95 | Maximum | First-request TTFB |
| --- | ---: | ---: | ---: | ---: |
| #1 (IAD) | **20/20** | 476 ms | 657 ms | 657 ms |
| #2 (IAD) | **19/20** | 634 ms | **802 ms** | 802 ms |
| #3 (IAD) | **20/20** | 737 ms | 769 ms | 737 ms |

The missed request (version #2) returned 24 live rights-cleared books and
recorded **379 ms inside Worker**: 89 ms storefront context, 49 ms market
metadata, 37 ms landing-page lookup and a **290 ms authoritative D1
catalog-rights query**. Another **423 ms** lies outside timed Worker
processing; establishing its new Undici connection took ~31 ms (and is
part of this request's measured transport). The failure is neither a
missing rights record nor a warmed/cached response. The actual
802-ms measurement is a strict failure: **no 800-ms exception is permitted**.
[GitHub Actions evidence](https://github.com/JibrilMohamud/cove/actions/runs/39092487232).

Control-plane settlement rules out only the simple case where GitHub starts
before the new deployment appears at 100% in the control plane. It
**cannot guarantee propagation to every edge**, prevent cold SQLite/
upstream/network variability, or certify every user geography. Thus
Cloudflare public routing remains disabled, with Vercel retained as
production. Further repeat and geographic tests are mandatory before any
commercial readiness claim or live purchase and identity journey.

### Independent repeat of control-plane-settled stage benchmark

A second independent run of the **same merged code**, with **three further
fresh Worker versions**, failed **57/60**. The separate version matrices were
**18/20**, **19/20**, and **20/20**. The first version's first HTML request
took **7,289 ms** end-to-end (6,884 ms timed Worker processing), with
live D1 phases showing context **4,567 ms**, active markets **1,402 ms**,
page metadata **2,197 ms** and the primary-authoritative catalog
**2,316 ms**. Its next HTML request also took **1,671 ms** (context
1,528 ms). Version two's #19 sample took **881 ms** (catalog 597 ms and
page 594 ms). All 60 responses rendered 24 authorized books. The third
version passed 20/20, but cannot mask the red earlier deployments.

[Independent repeat evidence](https://github.com/JibrilMohamud/cove/actions/runs/39092487232/attempts/2).
Across the two control-plane-readiness attempts, the total is **116/120**,
with both attempts failing the strict all-request gate. This confirms
**real intermittent platform/D1 latency**, not merely early secret-version
propagation or an expensive full-API cold import. Do not claim cold-starts
or the commercial 800-ms objective are solved; preserve the public Vercel
route and Cloudflare candidate's disabled routing.

Tracked unresolved with detailed reproduction and actionable diagnostics in
[release-blocking issue #145](https://github.com/JibrilMohamud/cove/issues/145).
Next work requires D1 and network-side root-cause analysis, a
primary-authoritative optimization, and independent cold/geographic
validation of every request, not a change to thresholds.

### October 2026 D1 query-plan investigation and parallel primary rights trial

The live production D1 database is ~1.63 GB with an ORD authoritative
primary. Read-only `EXPLAIN QUERY PLAN` shows the first-paint query seeks
`catalog_search_documents` using `idx_search_popular_stable` and joins
current `retail_product_availability_rows` grants using
`idx_rights_grant_live_lookup`; it is NOT a catalog-wide count. One
primary D1 measurement for 25 rights-filtered candidates took **16.9 ms
SQLite execution**, read **225 rows**, but **425 ms API wall time**.
By contrast an intentionally full `COUNT(*)` against the complex retail
view scanned 414,503 rows and spent 1,762 ms in SQLite; the homepage
already avoids this expensive global count. It would be inaccurate to
identify this full count as the homepage's normal cause or to assume
the database service never stalls.

Other marketplace configuration EXPLAIN plans use indexed country
lookups. They consume typically <1 ms SQLite time each, yet the external
requests required hundreds of milliseconds wall time. Previous cold
deployments recorded real multi-second Worker-side D1 waits. These probes
establish **both** efficient normal SQL execution and material
Cloudflare/D1 transport-or-queueing variability; an index alone cannot
guarantee the desired 800 ms hard TTFB across network geographies.

The next read-only staging trial starts the strictly primary-authoritative
retail rights query at the same time as anonymous storefront context,
markets and rate limiting, rather than waiting for the multi-query
localization path. The primary lookup computes the active market's
default currency inside the same SQL snapshot, falling back to the US
market exactly as the existing cookie-free context resolver does.
Cookies/account/authenticated requests retain the complete original
adapter. Legal territory comes from the same trusted network resolver
and is checked again against context before sending HTML. No grant
cache, replica-based legal verdict, estimated currency or warmup is used.
Four-territory fixture parity, next-page URLs, full CI and independent
genuinely cold/geographically distributed tests are mandatory before
calling this improvement ready; no public cutover is authorized.

### Parallel primary D1 reads: rejected after real cold-deployment regression

PR #146 launched rights-authoritative D1 and storefront metadata reads
concurrently and selected the current active market currency inside the
primary D1 rights SQL. CI, locale/right parity and direct production SQL
checks all passed. The live indexed rights lookup in isolation executed in
**2.7–16.9 ms** of SQLite time, read **~225 rows**, and had 351–425 ms
Cloudflare API wall times. A full count against the complex legal view
scanned 414,503 rows and took 1.76 seconds, but **this global count is
not part of the homepage first-paint request**.

The actual three-version first-HTTP-cold staging validation of the
parallel experiment **failed 12/20, 10/20, 20/20 (42/60 total)**.
It retained 24 live country-authorized cards on every response but
regressed the latency target sharply: maximum **3,039 ms**, p95 up to
**1,802 ms**. Slow samples repeatedly showed D1 metadata and rights
durations stalling together: the first request spent **2,520 ms** in
both concurrent `markets` and `catalog`, and **2,615 ms** in context.
In other slow requests `catalog` and `markets` each stalled
for ~600–960 ms. The evidence strongly suggests shared D1 request
transport, queueing, or primary contention during some periods,
**not** a simple unindexed candidate scan. It does not establish
whether the contention is from a writer, internal request scheduling,
network transport, or database service behavior.

[PR #146 trial](https://github.com/JibrilMohamud/cove/actions/runs/39094948013).
The change is **reverted to the earlier serial-rights ordering** because
it made the strict commercial gate demonstrably worse. A revert is not
a claim that cold reliability is fixed: the earlier configuration also
missed isolated first requests and the release remains blocked.
Future work should instrument D1 query `meta.timings.sql_duration_ms`
versus Worker wall clock and rows read/attempts, investigate
backend traffic and primary queue contention, reduce independent remote
metadata reads safely, and revalidate all cold/geographic cases.
Do not re-enable the parallel legal query or route production until a
new candidate improves repeated independent results without weakening
revocation, territorial-rights or checkout behavior.

### Primary D1 SQL/queue diagnostics: next protected staging trial

Cloudflare D1's `.all()` response can include its own SQL runtime
(`meta.timings.sql_duration_ms`), rows read and query attempts. The
protected native SSR first paint now separately measures the **wall-clock
catalog step** and the actual **primary SQLite engine duration**, and
retains numeric rows-read and attempt counters. These are output only as
allowlisted Server-Timing diagnostics after the same normal,
country-authorized/no-store bootstrap. Rows and attempts appear as
numeric `desc` metadata, never incorrectly labelled millisecond
durations; no SQL strings, product/user IDs, country/grant evidence,
credentials or CF-Ray identifiers appear in these headers.

Interpret a multi-second `cove_backend_catalog` paired with a very small
`cove_backend_catalog_sql` as time **outside the SQL engine**; it may
include D1 service scheduling, network transport, replication state or
request dispatch, and alone **does not prove SQLite write locks**.
A large SQL duration and rows-read count instead justify a query-plan,
index, or write-contention investigation. Missing D1 metadata is
reported as unavailable, never fabricated as zero. Normal legal
eligibility remains a direct live D1 primary read on every request.
Instrumentation itself is neither a latency fix nor a release-pass
claim: genuine 3x20 first-HTTP cold deployments and geographic/customer
QA remain required.

### Currency-index proof without parallel D1 contention (October 18)

Do **not** restore the concurrent primary legal/replica presentation read
schedule: [PR #146's 42/60 cold gate](https://github.com/JibrilMohamud/cove/actions/runs/39094948013)
regressed (worst 3,039 ms), and PR #147 safely reverted it.
PR #148 adds the actual primary D1 engine `catalog_sql` duration,
`catalog_rows` and `catalog_attempts` metrics to distinguish
slow SQL execution from D1/transport queueing without altering rights.

A separate read-only D1 audit found that the primary catalog contains
approximately **51,973 available USD** search documents, and currently
**zero** CAD/SAR/JPY documents. The popular first-paint seek deliberately
forces `idx_search_popular_stable` for bestsellers, which can scan all
~52k documents when market currency is absent (a CA probe consumed
**2,625 ms SQLite time**, 51,974 rows read), even while the
`retail_product_availability_rows` legal view remains indexed.

A **noncorrelated** live PRIMARY D1 existence guard using the already
deployed `idx_search_price(currency,price_minor)` tests for an
unsuppressed available candidate *inside the same first-paint SQL
statement*. If no candidate exists, the result is provably empty;
otherwise **every candidate still passes the unmodified live territorial
rights, embargo, DRM and revocation filter** and the established popular
sort. Read-only primary comparisons returned identical 25-book US
candidates and identical zero results for CA/SA/JP, with ~6–10 ms SQL
execution for the previously expensive empty cases. This changes no
legal decisions, routing, session ordering, database schema, caches or
public production origin.

Run four-territory fixture parity, security, native SSR build,
six-browser QA, and **three independent truly cold deployments, each
20/20 strictly under 800ms** including the first HTTP SSR request.
This improvement alone cannot guarantee global transport or Cloudflare
D1 service-queue latency. Any red cold-run blocks production.

### Indexed empty-currency guard on protected primary D1: fresh stage results

PR #150 merged after security, persistence, accessibility, Cloudflare
build and all six browser configurations passed. It uses the existing
primary `idx_search_price` index to fail an empty-currency candidate
**inside the current authoritative first-paint SQL statement**, retaining
the current legal rights and revocation view and the known-safer
serial read scheduling. This is a real improvement for CAD/SAR/JPY
with no catalog items, not a general solution for cold service queues.

The first independent three-version cold validation on merged commit
`4e88b4898eb2c386c4213879e4ae6cf71538146e` **failed**:

| Worker version | Strictly under 800 ms | p95 | Maximum | Entry colo |
| --- | ---: | ---: | ---: | --- |
| #1 | **14/20** | 1,384 ms | 1,474 ms | ORD |
| #2 | **19/20** | 316 ms | 1,112 ms | ORD |
| #3 | **20/20** | 236 ms | 535 ms | ORD |

The 60/60 authorized-card and no-store checks still succeeded. Across
all 60, Cloudflare D1's actual **primary rights SQL engine** time
remained <=25.4 ms. The largest catalog D1 operation took **734 ms**,
while SQL took **8.9 ms**. Context/market-list operations simultaneously
took 996/983 ms on one response and 705/680 ms on another. A separate
first-request miss took **1,112 ms**, with just **106 ms** timed Worker
execution and **1,006 ms** outside Worker time. The user-visible hard
SLO therefore fails, even though the underlying catalog SQL plan is
fast and all books remain legally filtered. This is not evidence that
SQLite write locks dominate; Cloudflare D1 service/transport variability
and first-hop routing remain unisolated. Preserve both failures and
every independent repeat.

[Protected cold run](https://github.com/JibrilMohamud/cove/actions/runs/39097396203).
Production still remains on Vercel; the Cloudflare production candidate
is unroutable. Do not prewarm/discount the first request, omit live
rights or relax <800 ms to manufacture a pass.

### Independent repeat of indexed-currency guard: YVR cold outliers

The same merged PR #150 code underwent **three more separately deployed
cold Worker versions**, all entering via **YVR**:
**18/20**, **19/20**, **20/20** strictly <800ms. Version #1
started with a **6,521 ms** TTFB (6,155 ms Worker), and its second
response was 2,722 ms; version #2's first was 856 ms. Version #3
passed all 20 (max 763 ms). Every response continued to render
24 currently rights-cleared books and to use the audited lean path.

The 6,521 ms request recorded **9.4 ms actual primary rights SQLite
engine time**, despite 2,201 ms catalog D1 wall time, 3,952 ms
storefront context and 1,877 ms active-market list phases. Every
primary-rights SQL query across this repeat took <=16.4 ms.
Thus SQL execution, missing indexes and presumed write locks do
**not** explain the long latency. Cloudflare D1 service scheduling,
routing/queueing or Worker-to-service transport remain unresolved
with the available telemetry.

Both fresh three-version attempts of the merged commit therefore
failed: **53/60** (ORD) and **57/60** (YVR), or **110/120**
under the unchanged hard threshold. The two passing third versions
are not permission to discard the failures. True global
commercial-grade cold reliability is **not established**.

[Independent YVR rerun](https://github.com/JibrilMohamud/cove/actions/runs/39097396203/attempts/2).
Next development should reduce the number of serial metadata D1 requests
**without** concurrent rights/metadata contention (which already
regressed in PR #146), and investigate D1 service latency with
Cloudflare using this concrete engine-time vs wall-time evidence.
Authoritative primary territorial grant checks must remain mandatory.
No public migration or threshold relaxation is authorized.

### October 18 — parallel primary-authoritative first-paint eligibility trial

The live primary ORD D1 was inspected with read-only SQLite
`EXPLAIN QUERY PLAN`, table/index introspection, and measured read queries.
The actual ordered first-paint legal eligibility query scanned using
`idx_search_popular_stable`, indexed rights grants/territories and product
lookups. One direct test completed in **~17 ms SQLite** with **~425 ms
Cloudflare API wall time**. A catalog-wide `COUNT(*)` on the complex
`retail_product_availability_rows` view took **~1,762 ms SQLite** and
**414,503 rows read**, but **is not run on first paint**. Therefore,
no missing index or broad rights count alone explains the recurrent
first-request multi-second D1 service/transport tail. Lock contention
and server-side queueing have not been independently proven by these
measurements.

The next bounded experiment starts the live **primary D1** territory
rights/currency query alongside the anonymous locale/market configuration
and Cloudflare read limiter instead of serially awaiting geo-replica
metadata. Currency is resolved from **current active primary storefront
market state** in the SAME authoritative selection statement (US
active-market fallback); a noncorrelated indexed currency existence
check prevents walking the ~52k popularity index for a provably empty
currency, but **cannot grant any territory rights**. The complete
`retail_product_availability_rows` deny-over-allow, contract, date,
format and DRM logic is unchanged. Page metadata begins as soon as
locale is resolved, overlapping primary rights access. All required
operations must finish successfully before SSR renders, and a trusted
country mismatch fails closed. Previous SQL-duration/rows-read/attempt
telemetry remains intact; the multi-market fixture tests compare the
new path to Cove's canonical API.

This is an experiment, NOT proof of commercial-grade TTFB. Require
independently cold three-version ×20 strict sub-800-ms checks with
the first HTTP request counted, meaningful geographic spread,
revocation-safe rights and checkout, reader/offline journeys before
any Cloudflare public production activation.

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

The staging benchmark is synthetic and each workflow attempt uses a single
runner geography, even though separate jobs or runners may land in different
colos. It does not replace field Web Vitals or legal QA in multiple countries.

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

### One-statement live rights shelf: cold staging result (October 18 UTC)

Merged PR #136 replaces sequential live D1 retail eligibility and book-card
hydration with a single atomic SQL statement. US/CA/SA/JP fixture comparisons,
security, persistence, screen-reader and all six browser checks passed.
The catalog phase in protected staging was typically **20–60 ms** with 24
authorized SSR books on every request, demonstrating that the change retained
live geographic rights and shortened catalog execution.

However, the first independent cold deployment still **failed 10/20**
strict TTFB samples (p75 1,112 ms, p95 2,356 ms, maximum 2,956 ms)
through ORD. Its slowest samples predominantly involved independent live
market and country/locale context D1 reads. For instance sample 14 took
2,356 ms end to end, with 1,968 ms inside context and 1,847 ms in
the overlapping markets request, while the catalog SQL took only 60 ms.
[Protected production-source staging test](https://github.com/JibrilMohamud/cove/actions/runs/39085551768).

Two later **fresh, independent redeployments of the same PR #136 commit**
each then passed the genuine cold-first 20-request matrix (24 licensed
books on every response):

| Deployment (same Worker commit) | Cloudflare colo | <800 ms | p95 | Maximum |
| --- | --- | ---: | ---: | ---: |
| Initial cold deployment | ORD | 10/20 | 2,356 ms | 2,956 ms |
| Independent cold redeploy | IAD | **20/20** | 411 ms | 418 ms |
| Independent cold redeploy | ORD | **20/20** | 372 ms | 453 ms |

Proof: [the staging workflow with three independently rotated staging-secret
deployments](https://github.com/JibrilMohamud/cove/actions/runs/39085551768).
The two later passes are **40/40**, and the first probe ran before API/D1
preflights on every deployment. This is real improvement with rights intact,
but the initial severe ORD misses disprove repeatable 20/20 across all
cold deployments. Do not cherry-pick the green samples to certify an SLO.

Thus the remaining cold-tail latency is **not resolved** by fewer serial
catalog queries. The hard <800 ms gate must remain blocking across every
cold deployment/geography trial, with full territorial rights. Next
experiments should profile/request-optimize the primary-region market/context
D1 operations and measure true Worker-to-D1 request latency; never substitute
stale rights or prewarm away cold samples. **Do not cut over production.**

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
