# Cove Cloudflare production cutover — blocked release record

Status: **DO NOT ROUTE CUSTOMERS TO CLOUDFLARE YET.** This is a release gate,
not an approved cutover. Update this checklist with verifiable evidence before
the owner promotes the Cloudflare frontend.

## Verified state (October 28, 2026)

- Audited source `main` is `e463c0e7903ff0b784901962d778b2dda2243b36`.
  Account `d26430caa63ec55f6612e32f36aca5e9` owns the active
  `covereads.com` zone `07e218b2e74bc522122e0994b8e37576`.
  `www.covereads.com` remains on Vercel; hostname ownership is no longer
  the missing prerequisite. Preserve the Vercel rollback deployment.
- Cloudflare API inspection confirms `cove-legal-authority-production`
  exists with its own Durable Object namespace, production `PRIMARY_DB`
  `4bd657ac-8789-403e-a28c-93aba8d0a989`, and
  `COVE_RIGHTS_OWNER_ENABLED=0`. It has no operational production lease,
  authentication secret, or completed production command implementation.
- `cove-persistence-backend` uses the same production D1 and private media
  R2. Its deployed bindings contain **no `LEGAL_AUTHORITY` and no Stripe
  credentials**. Do not enable the isolated-QA write lock in production.
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
- [Native SSR run 40701901773](https://github.com/JibrilMohamud/cove/actions/runs/40701901773)
  tested this exact main commit. Its three independent first SSR requests
  took **1203, 1421 and 893 ms**. All exceed the hard 800 ms threshold.
  Concurrency maxima were **1061 ms at 4**, **1500 ms at 8**, and
  **1179 ms at 16**. No full 32-concurrent or two-phase 12,000-request
  production-equivalent pass is established by that campaign. Favorable
  warm samples and zero HTTP errors do not redeem these failures.

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

## Cutover stop conditions

Abort migration immediately if the domain is unowned/unverified; runtime
secrets are missing; auth, payment, offline or rights scenarios fail; any
independent cold deployment fails the strict gate; source origin/callbacks
mismatch; or rollback cannot be demonstrated. Keep Vercel's public origin
serving, report the exact failing evidence, and do not relax the SLO.
