# Cove Cloudflare production cutover — blocked release record

Status: **DO NOT ROUTE CUSTOMERS TO CLOUDFLARE YET.** This is a release gate,
not an approved cutover. Update this checklist with verifiable evidence before
the owner promotes the Cloudflare frontend.

## Verified infrastructure (October 18, 2026 UTC)

- Connected Cloudflare account `d26430caa63ec55f6612e32f36aca5e9`
  has **0 DNS zones** and **0 Worker custom domains**.
- Vercel project `cove` (`prj_bq7hKQw8JKWE6vpfdOgwowa8cjjM`) exposes
  exactly one verified project domain:
  `cove-puce-theta.vercel.app`. This is a Vercel-owned platform hostname,
  **not** a transferable/Cloudflare-managed domain.
- The only audited native SSR stage service,
  `cove-storefront-ssr-staging`, has native `DB`, `BUCKET`,
  `ASSETS` and `COVE_STOREFRONT_READ_LIMITER` bindings plus staging
  flags. The only bound secret is `COVE_SSR_STAGING_GATE_KEY`.
  **Supabase auth and Stripe checkout/webhook bindings are absent.**
- D1 production database reports `read_replication.mode=auto`. Stage SSR
  uses primary-anchored Sessions API for configuration, while rights
  eligibility remains direct primary D1.
- Existing protected staging HTML tests cover anonymous, rights-checked
  storefront SSR. They do **not** establish signed-in sessions, orders,
  entitlements or installed-reader portability on a new origin.

## Requested Workers.dev hostname clarification

The connected Cloudflare account is registered under the account subdomain
`cove-jibrilmohamud`. Cloudflare's documented Worker addressing uses
`https://<worker-name>.cove-jibrilmohamud.workers.dev`. Therefore the
requested account-root URL `http://cove-jibrilmohamud.workers.dev/` is
**not** an assignable Worker hostname. The planned frontend Worker script
is `cove`, yielding
`https://cove.cove-jibrilmohamud.workers.dev/`.

Its separate `wrangler.frontend.production.toml` production **candidate**
has `workers_dev=false`, `preview_urls=false` and no routes, deliberately preventing an
unverified app from going public. The file and static release assertion can
be built/dry-run-tested, but **do not deploy/publicly enable it until**
all of the following independent gates pass: production runtime secrets,
sign-in/callback testing, Stripe sandbox payments and webhook fulfilment,
reader/offline migration, primary territorial rights verification, repeated
cold deployment performance, and reversible traffic cutover. Cloudflare's
own documentation recommends a verified custom domain over Workers.dev
for business-critical production; the Workers.dev hostname alone does not
change that release safety assessment.

## Infrastructure prerequisites

1. Owner supplies a registered custom hostname/domain under their control.
   Verify authoritative Cloudflare DNS zone ownership and active delegation.
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
