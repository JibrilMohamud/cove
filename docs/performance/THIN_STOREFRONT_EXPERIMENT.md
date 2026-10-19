# Thin storefront architectural comparison

Baseline code: `175c0082b4ab5e526de7aa8e656b4d2dbc9df344` (PR #226), a diagnostic descendant of `8a5353e78b228b4c7f8672e4ec3310c01d569401`. This branch adds a new standalone public-serving Worker. It does not promote any earlier failed optimization or change production routing.

## Boundary implemented

The new Worker authenticates staging, derives territory from immutable `request.cf`, enforces the existing 180/minute/client policy, and calls the exact current anonymous bootstrap. The identical primary-D1 atomic shelf query determines current product, grant, deny, contract and DRM eligibility for every response. All 24 edition URLs, titles, authors, cover references, genres and prices are rendered into meaningful accessible HTML. No response, grant, in-flight promise, D1 session or book is cached across requests. Cookies and provider identity hints route to the full application. All non-root routes, APIs and assets use a service binding to the unchanged full application.

The serving bundle excludes TanStack, React, account, reader, EPUB and recommendation execution code. An emitted-bundle metafile assertion guards that boundary. Existing locale/config processing is deliberately retained to isolate renderer/framework cost before introducing another read model. The ~548 KB uncompressed bundle is still dominated by static translations and validation code; it is a first alternative, not the smallest possible Worker.

## Measurement

`cloudflare-thin-storefront-paired.yml` shares the existing serialized synthetic-D1 benchmark queue. It cannot bind production D1 or R2. Two already provisioned, verified 50,000-item artificial catalogs have allow/deny/revoked and US/CA-distinct rights. No fixture import or production mutation occurs. Control and thin runtime/placement match (2026-10-19, nodejs_compat, ingress edge). Both renderers and the service behind thin use the same candidate synthetic D1, measured sequentially. This removes independently provisioned D1 service/placement variability as a confounder; the second fixture is verified for consistency but is not a different serving backend.

Three fresh control-plane-confirmed deployments per renderer each receive twenty new-connection HTML requests before warm measurements. Repeat 1/4/8/16/32-request waves alternate renderer order. Only HTTP 200, no-store HTML containing all 24 edition links counts as valid. Raw status, TTFB, full-response time, response size, edition links, colo and bootstrap SQL/service telemetry are retained, including failures. Maxima must be <=650 ms for cold and 1–16, <=750 ms for 32, with no valid sample >=800 ms. Different colos invalidate the comparison.

The synthetic client adapter is authenticated staging-only and requires an explicitly allowlisted artificial database ID. It models many independent clients with distinct benchmarking-range addresses while preserving the same native 180/min policy. The production app never reads the load-client header. High rate tests do not disable abuse controls. A dedicated local test rejects this adapter outside the allowlist.

A 20-second-per-stage arrival schedule tests 10/25/50/100/250/500 RPS on each renderer. Scheduled, completed, dropped, late arrivals, errors, p50/p75/p95/p99/max are reported. The client caps in-flight work at 128. The campaign stops increasing rates on the first failed stage (including client scheduling or latency failure). This short curve is capacity exploration, not a soak test or certification; it is not a mixed checkout/reader/ingestion load.

Chromium Pixel 5, 1.6-Mbps/150-ms mobile networking and 4x CPU slowing measure five actual LCP samples and p75, plus book count, accessibility and search navigation. The fixture has no production cover distribution. Production LCP requires separate real-catalog/RUM verification.

## Correctness and release boundary

`node scripts/check-thin-storefront.mjs` exercises real SQLite with the repository migrations and canonical bootstrap: ordered US/CA/SA/JP shelf parity, real grant revocation and product withdrawal, identity fallback, forged geographic headers, unavailable primary, rate-limit denial, safe HTML/URL rendering. Existing rights and bootstrap tests are additional gates. The deployed test also temporarily revokes a grant for a displayed product in the allowlisted artificial candidate D1, verifies its immediate removal from HTML, restores only the originally active grant, and verifies recovery. No production data is mutated.

This is an **architectural prototype**, not a drop-in visual/interaction replacement: literary discovery links to the existing full store; market controls, in-place save buttons, merchandising and offline installation are not duplicated on the prototype homepage. Those differences are explicit release blockers even if TTFB improves. The runner always sets `releaseApproved=false`. No merge or production migration is warranted from this test alone.

Decision gate: repeatably reduce matched full-page p95/p99 tails by >=200 ms while meeting the unchanged numeric gates, then preserve the approved design and all interactions before incrementally adopting the boundary. If both variants show similar tails, investigate transport/service execution rather than expanding the rewrite.

Next stages after a successful comparison: independently versioned presentation projection; primary reauthorization on every offer; isolated discovery/indexing data pipeline; actual mixed customer journeys, recovery and long-duration capacity tests; multi-location comparison; approved canary and rollback. No assumption is made that adding queues or another database automatically fixes measured SSR tails.
