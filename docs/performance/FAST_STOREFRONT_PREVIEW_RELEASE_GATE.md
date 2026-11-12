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
- Cove Supabase Auth now has **one confirmed user** (aggregate checked 2026-10-22 UTC), but this is not an approved disposable QA login. An independent QA identity, entitlement and Cove-specific sandbox checkout must be provisioned through the supported service APIs. Never mutate auth.users directly, charge real cards, repurpose a customer session or fabricate a purchase/entitlement.
- Existing Cloudflare customer gateway `COVE_STRANGLER_RELEASE_CERTIFIED=0`. Production Vercel `COVE_FAST_*` variables absent; **no customer cutover**.

This document is a release checklist, not a claim of passed certification.

## Updated release evidence — 2026-10-22 UTC

- Merged primary-D1 workload isolation PRs [#262](https://github.com/JibrilMohamud/cove/pull/262) and [#263](https://github.com/JibrilMohamud/cove/pull/263), retaining live primary territorial-rights revalidation. Merged [#264](https://github.com/JibrilMohamud/cove/pull/264) to hard-cap production anonymous canary at exactly **1%**.
- PR [#260](https://github.com/JibrilMohamud/cove/pull/260) remains **unmerged**. The guarded 100-RPS synthetic integration with 40 interleaved synthetic D1 reads/writes passed twice: 2000/2000 valid, zero dropped; p95 **228 / 409 ms**, p99 **350 / 531 ms**, max **768 / 620 ms**. One campaign had only **32 ms margin** to the hard 800 ms ceiling. Protected cold real-D1 tests also revealed an older **4,628 ms** replica metadata service stall; new staging-only 200 ms hedged presentation read is being independently evaluated. No legal grant cache.
- The visual gate is now enforced rather than informational. Latest comparable real-D1 screenshot campaign on 2026-10-22 failed with **11.31% mobile and 11.83% desktop** mismatches; category controls and field dimensions are being aligned. Both must actually measure **<10%** on the same immutable revision.
- Existing production customer gateway flag is still **0**, and Vercel production has **no COVE_FAST** environment bindings. The preview branch has an encrypted relay-key variable and the Cloudflare Worker has a secret binding, **but matching secret material cannot be verified**. Automated secret rotation was blocked by safety controls. Resolve out of band; never print, paste, or log secrets.
- The connected Stripe TEST account is named **Ko-fi**, not Cove. It is not suitable evidence for Cove payment integration. Cove sandbox keys/identity and end-to-end signed preview checkout/fulfillment, reading, audio, revoke/refund, cookie isolation and rollback remain **NOT TESTED**.
- **NO-GO**: do not deploy/enable anonymous canary until all gates above pass, including the complete signed Vercel→Cloudflare user journey, 1% cap, rollback test and multi-region acceptance. Maintain original SSR fallback.
