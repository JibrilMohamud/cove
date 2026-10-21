# Cove fast storefront — production-equivalent preview certificate

Status: **BLOCKED — do not enable production canary**.

## Isolation

The Vercel team project `cove` has branch-scoped preview variables only:

- `COVE_FAST_STOREFRONT_MODE=preview`
- `COVE_FAST_STOREFRONT_RELEASE_CERTIFIED=1` — **preview branch only**
- `COVE_FAST_STOREFRONT_ORIGIN=https://cove-fast-customer-gateway.cove-jibrilmohamud.workers.dev/`

These variables do not affect production. The Cloudflare gateway's **production release flag remains 0** and the shared HMAC relay key has not been provisioned; the preview will therefore fall back to the original Cove app until both sides are explicitly configured.

### Secrets required (configure via dashboard; never commit)

1. Generate a cryptographically random 32-byte hex secret (64 hex characters).
2. Create a branch-scoped encrypted `COVE_FAST_RELAY_KEY` Vercel Preview environment variable for `release/cove-fast-preview-qa-20261021`.
3. Configure that **identical** key as a secret in the dedicated Cloudflare gateway. Do not expose this key in logs or front-end code.
4. Only in a separate, reviewed preview gate may the customer Worker release flag be temporarily set to 1. The Vercel production variable **must remain absent** until all release tests pass. Restore Worker flag 0 after testing.

## Acceptance checks

- Signed US, CA, SA and JP territory selection; cross-territory denial; revoked-rights immediate denial; direct unsigned Workers.dev requests return 401.
- Mobile 390x844 and desktop 1440x900 against same catalog and settled assets. Both: **less than 10% viewport pixel mismatch** under comparable image-load completeness, plus functional filter/search/save and keyboard/screen-reader parity.
- Authenticated disposable test account: verify login, library save/state, checkout with **sandbox payment only**, idempotent fulfillment, entitled reader/EPUB/protected audio, refund/revoke, offline renew/expiry, and logout.
- Independent cold deployments across Cloudflare locations with **all maxima under 800ms**; 1/4/8/16/32-request headroom; isolated synthetic 100 RPS (2000/2000 valid, no dropped arrivals, p95 <600ms, p99 <750ms, max <800ms). **Do not subject production D1 to a synthetic 100-RPS load.**
- Measure **actual preview Vercel→Cloudflare** mobile p75 LCP and all core journeys, not just the Worker-origin number.
- Inspect proxy failures and verify automatic SSR fallback. Rehearse rollback and production release certificate. Enable a **maximum 1% anonymous GET /** canary only with signed-off evidence; do not proxy cookies, checkout, accounts, API or reader.

## Evidence / blockers as of 2026-10-21

- Merged PRs #251, #253, #254, #255, and #256 delivered the optimized isolated Worker, browser controls, real production catalog checks, signed Vercel territory relay, and a locked cloud deployment.
- Production D1: 24/24 edition URLs matched; cold observations included ~371ms and ~754ms passes **and an unacceptable 2994ms outlier**. Cold repeatability not certified.
- Comparable desktop viewport has reached 5.61% but other observations suffered incomplete imagery; mobile around 11.6%, above target.
- Cove Supabase Auth currently has **zero registered users**. An authenticated QA identity, entitlement and Cove-specific sandbox checkout must be provisioned through the supported service APIs. Never create auth.users records by direct SQL, charge real cards, use a live customer's session, or fabricate a purchase/entitlement.
- Existing Cloudflare customer gateway `COVE_STRANGLER_RELEASE_CERTIFIED=0`. Production Vercel `COVE_FAST_*` variables absent; **no customer cutover**.

This document is a release checklist, not a claim of passed certification.
