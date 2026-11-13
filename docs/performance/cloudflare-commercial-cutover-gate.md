# Cove Cloudflare production cutover — blocked release record

Status: **DO NOT ROUTE CUSTOMERS TO CLOUDFLARE YET.** This is a release gate,
not an approved cutover. Update this checklist with verifiable evidence before
the owner promotes the Cloudflare frontend.

## Verified performance evidence (November 13, 2026)

**Synthetic hosted v2 performance: PASS for the specified isolated campaign, not a production routing approval.** The reviewed `main` commit `80d8ad48024cccb73d3635ac308256eb105a2ce9` was exercised in [protected hosted campaign 43441279547](https://github.com/JibrilMohamud/cove/actions/runs/43441279547). Its serving model uses independent run-scoped private R2/KV public presentation plus a **fresh primary-D1 rights, current offers, and territorial authorization read on every visitor**. An exact-ranked 25-candidate live-rights prefix is accepted only when all 25 IDs and edition IDs match; any denial, revocation, missing candidate, or stale edition forces the original full 128-candidate D1 authorization.

- Three independently rotated new deployments: 20/20 valid each; cold maxima **319, 418, 370 ms**, all strictly below 800 ms.
- Native 1/4/8/16/32-concurrent and HTTP/2 1/4/8/16/32-concurrent: every phase valid, zero drops, hard maxima below 800 ms. The 32-request native maximum was **321 ms**; HTTP/2 was **247 ms**.
- Native 100-RPS / 20 seconds: **2,000/2,000 valid**, zero drops/invalid, **p95 87 ms**, **p99 172 ms**, **maximum 390 ms**.
- HTTP/2 100-RPS / 20 seconds: **2,000/2,000 valid**, zero drops/invalid, **p95 87 ms**, **p99 143 ms**, **maximum 261 ms**. Both phases retained the strict p95 <600, p99 <750, and maximum <800 ms limits, with no relaxed thresholds.
- R2/KV test-run synthetic cleanup: all objects deleted, zero failures. Read-only Cloudflare D1 sampled query telemetry showed **352 rows read** per first-paint authorization read on average, down from **1,588** for the earlier 128-ID rights read. Telemetry is sampled, not an exact request census.

**Low-volume real production-catalog preview: PASS, without 100 RPS against real primary.** [Real-catalog acceptance run 43446319429](https://github.com/JibrilMohamud/cove/actions/runs/43446319429), on `main` commit `218e84c4fc804d064aabf2eec9f139e6b8ef4d11`, passed three independently rotated **read-only production D1** cold requests (**521 / 548 / 525 ms**), mobile Chromium **LCP p75 456 ms** (five responses with HTTP 200 and no page errors), **24/24 matching live edition links**, mobile **9.81%** and desktop **5.28%** mismatch to independently approved immutable, checksum-verified visual reference images (both below the existing <10% bound). The clean successful run followed an earlier **staged desktop HTTP 503** failure and a separate intermittent preflight Cloudflare API refusal; those failures were not silently marked green. `main` preserves their failure diagnostics via PR #651.

**Geography limitation:** The real-catalog run independently verified ingress from **LAX / LHR / FRA / NRT** using content-free probes, but **did not measure catalog authorization TTFB at those locations**. It also did not certify repeatable ORD/LAX/IAD/DFW 1/4/8/16/32 and 100-RPS regional cohorts. Geographic performance remains a distinct release blocker. Neither capacity workflow certifies real customer payment-to-entitlement, a production legal-owner activation, account/media/offline migration, or a protected rollback rehearsal.

**Production NO-GO (verified).** Cloudflare read-only owner settings still have `COVE_RIGHTS_OWNER_ENABLED=0`. The [production canonical-D1 principal audit run 43443134551](https://github.com/JibrilMohamud/cove/actions/runs/43443134551) passes only *no-new-drift* while reporting **four historical non-owner direct primary D1 bindings**, `releaseEligible: false` and `productionAuthorized: false`. Production Stripe LIVE entitlement and refund/revocation acceptance, exclusive legal-owner write capabilities, independently repeated geographic catalog performance, and actual protected rollback are not certified. Keep Vercel customer routing unchanged until those separate gates close.

The October 28 snapshot immediately below is retained as **historical baseline**, not current November performance status.

## Verified state (October 28, 2026)

- Read-only operational snapshot is based on `main` at `254eb2b6e53e47b8e90996deb163697a103e5f92`. The canonical source-review inventory is independently pinned to its reviewed commit, not silently reapproved by this document.
  Account `d26430caa63ec55f6612e32f36aca5e9` owns the active
  `covereads.com` zone `07e218b2e74bc522122e0994b8e37576`.
  `www.covereads.com` remains on Vercel; hostname ownership is no longer
  the missing prerequisite. Preserve the Vercel rollback deployment.
- Cloudflare API inspection confirms `cove-legal-authority-production`
  exists with its own Durable Object namespace, production `PRIMARY_DB`
  `4bd657ac-8789-403e-a28c-93aba8d0a989`, and
  `COVE_RIGHTS_OWNER_ENABLED=0`. A fresh 256-bit shared private `COVE_RIGHTS_OWNER_SECRET` was installed on this Worker and the persistence Worker on October 28; both secret-text bindings were read back without revealing the key. Provisioning alone does not prove an authenticated runtime handshake, operational fencing or writer closure. It is NOT certified or enabled for production commands (`COVE_RIGHTS_OWNER_ENABLED=0`); operational production fencing/positive-write certification remains missing.
- `cove-persistence-backend` uses the same production D1 and private media
  R2. Its deployed `LEGAL_AUTHORITY` Durable Object binding now **exists and has been verified**: namespace `83d7eadf3957436389a7b072120a9829`, class `CoveLegalAuthority`, script `cove-legal-authority-production`. This matches production D1 `4bd657ac-8789-403e-a28c-93aba8d0a989`; the owner is still disabled. Production payment/Stripe capability and operational owner-first writers remain uncertified. Do not enable isolated-QA write locks in production.
- The separate `cove-commerce-customer-qa-stage` has synthetic D1,
  Supabase and Stripe TEST binding names. This is not certification of
  production identities, secret values, ownership, or the complete journey.
- The [exact writer-site review](../architecture/canonical-writer-review.json)
  classifies all 458 existing candidates across 25 files: **433 require
  owner-command migration, 24 are non-authorizing writes, and one is an
  isolated browser-test fixture**. None is certified as production
  owner-guarded. These are migration candidates, not 433 confirmed defects.
  The independent release gate still blocks all 458 until ownership and
  deployed/external writer closure are separately proved.
- [Cloudflare-native SSR staging run 40761709662](https://github.com/JibrilMohamud/cove/actions/runs/40761709662) failed: **one of three independent cold deployments did not meet the strict test**, and the 4-concurrent probe reached **855 ms**, over the 800 ms hard ceiling. That run includes fast warm samples but cannot be released on partial passes.
- [Public Vercel homepage run 40761709594](https://github.com/JibrilMohamud/cove/actions/runs/40761709594) failed: **11 slow samples, TTFB p75 995 ms, p95 4464 ms**, and two homepage SSR samples missing server-rendered book cards. [Fullsite browser run 40761709684](https://github.com/JibrilMohamud/cove/actions/runs/40761709684) also failed with mobile lab LCP p75 **4132 ms** and a reader timeout.
- No verified multi-egress ORD/LAX/IAD/DFW repeatability, all-32-concurrency, or fully successful **two 100-RPS phases** has been established. For the 100-RPS acceptance this means 2,000/2,000 valid responses per 20-second phase, p95 <600 ms, p99 <750 ms, every response <800 ms, and zero drops. Do not lower these limits to obtain a release result.

## Owner-selected Workers.dev staging destination

Cloudflare's registered account subdomain is `cove-jibrilmohamud`,
but it is **not** a deployable standalone Worker hostname. A production
frontend Worker named `cove` would serve HTTPS at
`https://cove.cove-jibrilmohamud.workers.dev`, not at the account root
`http://cove-jibrilmohamud.workers.dev/`. Cloudflare recommends a
verified custom domain for business-critical production.

The candidate `wrangler.frontend.production.toml` has
`workers_dev=false`, `preview_urls=false`, and no routes.
Both the Worker and its static assets are built/dry-run-tested in CI,
but no public production URL is exposed or activated until all release
checks—including secrets, Stripe, auth callbacks, rights, offline reader,
and reproducible cold-request performance—are green. Public Vercel
continues to serve existing customers and is preserved for rollback.

## Infrastructure prerequisites

1. Reverify the registered `covereads.com` zone and active delegation before
   releasing the exact candidate to the approved public hostname.
   Do not buy a domain, transfer DNS or claim a hostname without owner-approved
   details. A `*.workers.dev` or `*.vercel.app` hostname is not a
   verified Cove-owned production domain.
2. Create a **separate** production Workers Static Assets SSR service;
   preserve `cove-storefront-ssr-staging` as a protected, read-only canary.
   Explicitly scope main-branch release artifacts, D1 and R2 bindings, origins,
   zone/route, custom-domain TLS and rollback to the reviewed commit.
3. Provision production secrets through scoped Cloudflare/GitHub secret
   management, never source files or chat. Required feature bindings include
   `FORE_AUTH_MODE=supabase`, `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, and Stripe publishable, secret and
   webhook credentials with correct `STRIPE_LIVEMODE` for each environment.
   Check licensed-offline grant signing/verifier keys, email callback settings,
   R2 media and playback policies, and operational error-reporting secrets.
   Verify values functionally; existence of a binding name is insufficient.
4. Set `FORE_PUBLIC_URL` and frontend canonical/asset URLs to the selected
   HTTPS production hostname; configure exact Supabase OAuth redirect allowlist,
   cookie scope, CSP/CORS, email links, Stripe success/cancel URLs, Stripe
   webhook destination/signature/receipt dedupe, push subscriptions, installable
   PWA manifest and service-worker scope.
5. Provision account- and geography-isolated observability, D1 usage/cost
   alarms, worker error-rate and duration alerts, and rollback on burn-rate,
   rights, auth or payment anomalies.

## Hard test and evidence requirements

**No exceptions for good averages, a warmed app or favorable geography.**

- **Cold performance:** At least three independently new Worker versions per
  release, with first HTTP request being an SSR GET; all 20 interleaved
  requests per version have **TTFB strictly less than 800 ms**, no errors,
  24 (or valid positive) region-authorized cards, native D1 evidence, and
  no-store HTML. Re-run on multiple actual geographic egress locations and
  over separate periods; preserve all red deployments in aggregate evidence.
  Also test realistic parallel load and failures; a 60-request synthetic
  sample is not a statistical field SLO guarantee.
- **Rights:** Verify at least US, CA, SA, JP using genuinely regional
  requests (not forged `cf-ipcountry`). Approved, embargoed, revoked and
  wrong-territory editions must agree between SSR, catalog API, detail,
  checkout, EPUB entitlement and download; spoofed headers never alter rights.
- **Guest:** Search, category/publisher/book/detail, metadata/SEO, images,
  public first-chapter EPUB render, playable rights-cleared music and
  streaming interruptions. No private reader state appears in page source,
  browser HTTP cache, logs or CDN cache.
- **Authentication:** New signup, verified email, magic-link and OAuth
  callback where configured, password reset, sign-in/sign-out, session
  rotation and refresh, MFA/passkeys where enabled, cross-device cookies,
  account export/deletion and callback redirect security, **against the
  candidate Cloudflare origin**, not only local test fixtures.
- **Commerce:** Sandbox checkout quote, promo/tax/currency and charged
  Stripe test payment, signed webhook, idempotent duplicate/retry,
  matching order/royalty/ledger, refund/cancel, access grant, subscription
  expiry and denied access. Do not charge live customer cards as a test.
  Prevent competing Vercel/Cloudflare webhook consumers from granting twice.
- **Reader/offline:** Verified purchase-to-EPUB delivery, pagination,
  chapter navigation, bookmarks and annotations, progress sync/recovery,
  interrupted and resumable download, expired/revoked grants, offline
  reopen from the installed app, network reconnection, cross-device restore,
  R2 audio/EPUB access and canonical service worker migration.
  Remember that IndexedDB/offline storage is **origin-scoped**: data cached
  on `*.vercel.app` does not automatically appear on a new custom hostname.
  Implement and verify a safe account-backed export/restore or migration UX
  before retiring the old origin.
- **Devices:** Real or browser-automated desktop Chromium/Firefox/WebKit,
  iPhone Safari, iPad Safari, Android Chrome; accessibility, translation,
  RTL direction, low bandwidth and screen reader.
- **Deployment/rollback:** TLS, DNS, origin correctness and every canonical
  path verified on a lower-risk custom canary hostname first; CDN/WAF,
  cache-control and open-redirect protections; Vercel retained for rollback;
  tested DNS/traffic revert while preserving order/webhook and account
  consistency. Then use a tightly monitored controlled percentage cutover
  only where routing is supported and customer session affinity is safe.

## Existing automated test coverage is not a substitute for live QA

- `scripts/check-storefront-bootstrap.mjs`: fixture US/CA/SA/JP rights,
  localization, first-paint projection and session/primary separation.
- `scripts/check-cloudflare-ssr-staging.mjs`: protected native Worker,
  first-HTTP cold SSR, no-store/anti-spoof and 20-request gate.
- `scripts/check-stripe-sandbox-fulfillment.mjs`: optional real Stripe
  sandbox backed by **local synthetic catalog**, not deployed checkout.
- `scripts/browser-qa/offline-startup.spec.mjs`: local isolated QA fixture,
  not a production service worker/installed app on a new domain.
- Other checkout/auth/reader tests validate components and backend behavior
  but are **not** proof of a complete production Cloudflare customer journey.

## Rollback readiness is not a completed rehearsal

The owned Cloudflare zone is active, but `covereads.com` and `www.covereads.com` remain **unproxied Vercel CNAMEs**; no Cloudflare Workers route is attached to those hosts. The only Cloudflare custom Worker domain currently inventoried is `api.covereads.com`, serving the persistence backend. Existing Vercel production is the retained fallback, not proof that a Cloudflare-to-Vercel traffic reversion works under live sessions.

An actual rollback rehearsal is BLOCKED until owner-first writer closure and an independently certified protected canary. The drill must record pre-change DNS and routes, direct Vercel availability, a controlled canary switch, TLS/auth/rights/checkout/media checks on both sides, rollback of the same route, cache purging/invalidation, webhook deduplication, and account/entitlement continuity. No live customer DNS, owner enablement, or production route should be changed just to mark a test complete.

## Cutover stop conditions

Abort migration immediately if the domain is unowned/unverified; runtime
secrets are missing; auth, payment, offline or rights scenarios fail; any
independent cold deployment fails the strict gate; source origin/callbacks
mismatch; or rollback cannot be demonstrated. Keep Vercel's public origin
serving, report the exact failing evidence, and do not relax the SLO.
