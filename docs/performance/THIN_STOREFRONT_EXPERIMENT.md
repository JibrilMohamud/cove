# Thin storefront architectural comparison

Baseline code: `175c0082b4ab5e526de7aa8e656b4d2dbc9df344` (PR #226), a diagnostic descendant of `8a5353e78b228b4c7f8672e4ec3310c01d569401`. This branch adds a new standalone public-serving Worker. It does not promote any earlier failed optimization or change production routing.

## Boundary implemented

The new Worker authenticates staging, derives territory from immutable `request.cf`, enforces the existing 180/minute/client policy, and calls the exact current anonymous bootstrap. The identical primary-D1 atomic shelf query determines current product, grant, deny, contract and DRM eligibility for every response. All 24 edition URLs, titles, authors, cover references, genres and prices are rendered into meaningful accessible HTML. No response, grant, in-flight promise, D1 session or book is cached across requests. Cookies and provider identity hints route to the full application. All non-root routes, APIs and assets use a service binding to the unchanged full application.

The serving bundle excludes TanStack, React, account, reader, EPUB and recommendation execution code. An emitted-bundle metafile assertion guards that boundary. Existing locale/config processing is deliberately retained to isolate renderer/framework cost before introducing another read model. The ~548 KB uncompressed bundle is still dominated by static translations and validation code; it is a first alternative, not the smallest possible Worker.

## Measurement

`cloudflare-thin-storefront-paired.yml` shares the existing serialized synthetic-D1 benchmark queue. It cannot bind production D1 or R2. Two already provisioned, verified 50,000-item artificial catalogs have allow/deny/revoked and US/CA-distinct rights. No fixture import or production mutation occurs. Control and thin runtime/placement match (2026-10-19, nodejs_compat, ingress edge). Both renderers and the service behind thin use the same candidate synthetic D1, measured sequentially. This removes independently provisioned D1 service/placement variability as a confounder; the second fixture is verified for consistency but is not a different serving backend.

Three fresh control-plane-confirmed deployments per renderer each receive twenty new-connection HTML requests before warm measurements. Repeat 1/4/8/16/32-request waves alternate renderer order. Only HTTP 200, no-store HTML containing all 24 edition links counts as valid. Raw status, TTFB, full-response time, response size, edition links, colo and bootstrap SQL/service telemetry are retained, including failures. Maxima must be <=650 ms for cold and 1–16, <=750 ms for 32, with no valid sample >=800 ms. Different colos invalidate the comparison.

The synthetic client adapter is authenticated staging-only and requires an explicitly allowlisted artificial database ID. It models many independent clients with distinct benchmarking-range addresses while preserving the same native 180/min policy. The production app never reads the load-client header. High rate tests do not disable abuse controls. A dedicated local test rejects this adapter outside the allowlist.

A separate protected 32-request bootstrap measurement validates the complete bootstrap JSON rather than counting arbitrary successful HTML.

A 20-second-per-stage arrival schedule tests 10/25/50/100/250/500 RPS on each renderer. Scheduled, completed, dropped, late arrivals, errors, p50/p75/p95/p99/max are reported. The client caps in-flight work at 128. Each renderer stops increasing rates at its own first failed stage (including client scheduling or latency failure); any HTTP/transport failure aborts the shared-D1 capacity campaign. A slower baseline cannot truncate an otherwise healthy candidate curve. This short curve is capacity exploration, not a soak test or certification; it is not a mixed checkout/reader/ingestion load.

Chromium Pixel 5, 1.6-Mbps/150-ms mobile networking and 4x CPU slowing measure five actual LCP samples and p75, plus book count, accessibility and search navigation. All five LCP samples are saved before the interactive search check; that check requires a real successful filtered catalog response and rendered results after the existing application hydrates. The native form uses the canonical `/search?q=` route. The fixture has no production cover distribution. Production LCP requires separate real-catalog/RUM verification.

## Correctness and release boundary

`node scripts/check-thin-storefront.mjs` exercises real SQLite with the repository migrations and canonical bootstrap: ordered US/CA/SA/JP shelf parity, real grant revocation and product withdrawal, identity fallback, forged geographic headers, unavailable primary, rate-limit denial, safe HTML/URL rendering. Existing rights and bootstrap tests are additional gates. The deployed test also temporarily revokes a grant for a displayed product in the allowlisted artificial candidate D1, verifies its immediate removal from HTML, restores only the originally active grant, and verifies recovery. No production data is mutated.

This is an **architectural prototype**, not a drop-in visual/interaction replacement: literary discovery links to the existing full store; market controls, in-place save buttons, merchandising and offline installation are not duplicated on the prototype homepage. Those differences are explicit release blockers even if TTFB improves. The runner always sets `releaseApproved=false`. No merge or production migration is warranted from this test alone.

Decision gate: repeatably reduce matched full-page p95/p99 tails by >=200 ms while meeting the unchanged numeric gates, then preserve the approved design and all interactions before incrementally adopting the boundary. If both variants show similar tails, investigate transport/service execution rather than expanding the rewrite.

Next stages after a successful comparison: independently versioned presentation projection; primary reauthorization on every offer; isolated discovery/indexing data pipeline; actual mixed customer journeys, recovery and long-duration capacity tests; multi-location comparison; approved canary and rollback. No assumption is made that adding queues or another database automatically fixes measured SSR tails.

## October 20 continuation: measurement corrections

Repeat campaign [39345341724](https://github.com/JibrilMohamud/cove/actions/runs/39345341724) passed exact shelf parity, deployed revoke/restore, WCAG checks and delegated search. Synthetic mobile p75 LCP was 380 ms (thin) versus 1,300 ms (full SSR), five samples each. Thin cold maxima were 640/678/425 ms, so round two failed the unchanged 650 ms headroom criterion. Thin 32-request maxima were 564/551 ms. The cohorts reached different colos, invalidating causal A/B attribution. At 50 RPS, 999/1,000 thin responses were valid and one returned 503; the stage failed and higher stages were not attempted. The last error's log retained only status, so its dependency cannot be inferred. No capacity or commercial-readiness claim follows from this run.

The follow-up uses a shared, database-free benchmark ingress Worker and connection pool, forwarding to each renderer through service bindings. This is an explicitly changed transport topology; its results must not be pooled with the earlier direct-host campaigns. Each destination retains its own staging authentication. Colos must still match; the shared hostname is not an assumed pass. Fresh destination deployments remain control-plane verified, and fresh client connections remain included in cold maxima. The ingress Worker itself is not redeployed every destination round, so this measures cold destination execution behind shared ingress, not an entirely cold multi-Worker fleet.

The thin bootstrap diagnostic now executes the actual thin bootstrap, rather than delegating to the full application. Both diagnostic validity and its 750 ms 32-request maximum are required. Failed requests retain a bounded staging error body, ray ID and timestamp; server logs report only a fixed failure category and the bootstrap phase, never error text, SQL, tokens or visitor data. No error retry policy or authorization fallback is added without identifying the failing dependency.

Capacity exploration now stops scheduling on the first invalid response and records unscheduled arrivals separately. A candidate HTTP/transport failure blocks the architectural gate. A baseline latency failure remains recorded but does not by itself mark a healthy candidate as failed. All 650/750/800 ms targets, mobile comparison, rights tests and release blockers remain in force. `releaseApproved` remains false even if the architectural comparison passes.

## October 20 forensic 100-RPS diagnostic branch

Frozen serving implementation from PR #227 remains the comparator. The only
serving-code modification is a bearer-gated no-D1 control that executes inside
the SAME thin destination behind the SAME public synthetic benchmark ingress.
It returns constant text and does not touch catalog or legal authorization.
Successful control requests **cannot** count as successful storefront traffic.

The paired 20-second campaign now tries 75/90 RPS before 100 (and 125 only
if the 100-RPS gate passes). The 100-RPS stage has before/after fully valid
data-free 100-RPS controls, per-colo p50/p95/max, parsed Server-Timing
catalog/sql/bootstrap/context/page spans, offered/scheduled/dropped and client
arrival-delay metrics. The original 650-ms cold, 750-ms burst, 600-ms capacity
p95, 750-ms capacity p99, 800-ms absolute max and rights/UI/LCP checks remain.

**Pre-registered decisions**: If same-path no-D1 controls also fail 100 RPS,
fix client/transport/ingress and repeat before touching SQL. If controls pass,
compare catalog wall time to actual D1 SQL time and colo-specific tails:
high catalog wall/low SQL points toward binding queue/service latency; high
SQL indicates an execution-plan problem; low catalog wall/high TTFB suggests
transport, scheduling or uninstrumented Worker latency. If all three forms
are healthy but offered arrivals drop, isolate/scale the generator. Reject
any code change that worsens 50-RPS, cold or 32-request rights-correct tails.
A green 100-RPS synthetic result is NOT full storefront feature parity,
mixed checkout/reader/audio certification or production-release permission.

### Independent context SQL-vs-wall-clock attribution

Existing raw PR #227 artifacts show campaign A at 100 RPS has ORD
`cove_context` p50 ~741 ms while `cove_catalog` is only ~46 ms;
campaign B IAD has both context/catalog ~637 ms while `cove_catalog_sql`
is ~4.9 ms. A single global query-plan fix does not explain these facts.
The diagnostic branch now sums the four context D1 batch statements'
`meta.duration` into `cove_context_sql` when synthetic staging diagnostics
are enabled; no SQL, rights checks, or normal response data have changed.
High context wall time with low `context_sql` is evidence of dispatch,
replica-selection, queueing or other service waits, not proof of one cause.

## Experiment: isolated in-flight metadata coalescing

`COVE_THIN_METADATA_COALESCE=1` is enabled only in the synthetic-stage thin
worker. It merges *pending* identical anonymous context batches on the same
Worker isolate and D1 binding. The key includes trusted territory, network
provenance, fallback and exact Accept-Language. It cannot share any completed
result or rights decision. Every request still executes an independent
live-primary rights/catalog query and limiter check; authenticated requests
never enter this path. Tests cover simultaneous same-locale requests, locale
isolation, no settlement caching and failed-promise cleanup. Reject the
optimization unless the full 50/75/90/100 RPS and cold/rights gates pass.

## Controlled same-deployment 100-RPS singleflight comparison

The attribution runner now runs OFF/ON/OFF at 100 offered RPS on the
same stage-only thin Worker, isolated D1, ingest hostname, request shape
(except one experimental header), and shared client agent. The opt-out header
can disable **only anonymous context metadata coalescing** and is honored
only when both the existing stage gate and staging-only coalescing flag are
active. Rights SQL, authentication and rate limiting are unchanged. Every
stage records raw measurements and output colos. An improvement is explicitly
reported **only** when all runs share a colo, the ON run passes and both
independent OFF controls have over 10% greater p95 than ON with zero drops.
No outcome is inferred from one favorable regional load campaign.
This does not authorize production rollout; security audit and full interface
parity remain release blockers.

## October 21: benchmark Worker deployment lifecycle hardening

The first singleflight OFF/ON/OFF CI attempt **did not benchmark anything**.
[Run 39541802055](https://github.com/JibrilMohamud/cove/actions/runs/39541802055)
failed deploying a fixed-name `cove-thin-ingress-staging` with Cloudflare error
10007 (nonexistent Worker/subdomain), after seeding synthetic fixtures. No
cold/burst/capacity outcomes can be attributed to that run. Earlier workflows
also deleted the fixed Worker names during unconditional cleanup.

The experiment now generates unique Worker identities from the numeric
`GITHUB_RUN_ID` for baseline, thin, CORE, and ingress. Wrangler's temporary
thin and ingress configs rewrite only the names/service bindings, while
keeping the same isolated D1, request code, and benchmark topology. Cleanup
can delete **only its own four generated staging names**; fixed names and
production services cannot be deleted by this workflow. Validation fails
closed on malformed run IDs, changed binding topology or production DB IDs.
Newly deployed credentials remain independently rotated and ephemeral.
