# Cove paid legal owner: isolated full-schema staging proof

Status: **private QA certified for synthetic canonical paid order; NOT production-ready** (2026-10-27).

## Physically isolated ownership

- Cloudflare account: `d26430caa63ec55f6612e32f36aca5e9`.
- Dedicated ENAM D1: `cove-paid-commerce-legal-qa-20261027`, ID `7c7ab994-f6b3-419d-a72d-71eb9ea22e7e`. This is NOT production D1 and not the hosted-capacity D1.
- The D1 is a **canonical rights/commerce dependency subset**, not a 508-table full production clone. Installed table definitions and 54+ indexes are copied **schema only** from separate synthetic capacity QA D1 `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3`; no customer records and no shared writes. A canonical `retail_product_availability_rows` view and isolated synthetic price/catalog book fixture were also installed.
- The synthetic book `prd_paid_qa_20261027` is paired with exact US-retail contract/version/grant and USD 399-cent offer, a synthetic settled order `order_paid_qa_20261027` and buyer entitlement `ent_paid_qa_20261027`. **No Stripe TEST charge or webhook was created by this fixture.**

## Owner and test entrypoints

`wrangler.legal-paid-authority.example.jsonc` is permanently **disabled, without routes/workers.dev/preview URLs**, and pins the dedicated new D1. The owner runtime allows only two exact QA primary IDs (this D1 and the older negative-rights QA D1) under a short-lived secret lease; neither the production primary nor the capacity database is an allowed owner primary.

`scripts/staging/prove-private-paid-owner.mjs` creates per-run uniquely named owner and bearer-gated caller Workers with randomized credentials and a 12-minute expiry. Owner has **no public route**. The caller is workers.dev-accessible only for an authenticated CI QA session, never for shoppers. Both Workers are deleted in a `finally` cleanup (fail the job if cleanup fails); the owner secret expires even if CI is interrupted.

`.github/workflows/paid-legal-full-schema-private-qa.yml` proves on the actually deployed Worker:

1. No synthetic product authorization before owner-first positive verification.
2. Canonical active grant + live contract/version verified and published with epoch, US retail only.
3. Canonical USD offer and exact 399-cent amount published separately; EUR has no inherited rights or price proof.
4. Canonical paid order + individual buyer entitlement published only after the current legal proof and no active risk hold.
5. Cross-territory and cross-buyer protected reads rejected.
6. Strong order refund tombstone immediately revokes previously issued paid access even while canonical paid/entitlement rows remain present.
7. Exact operation replay is idempotent; old positive entitlement publication cannot resurrect the refunded order.
8. Private caller/owner teardown; no capacity database writes.

Initial live workflow: https://github.com/JibrilMohamud/cove/actions/runs/40439882000.
Extended live positive-offer workflow: https://github.com/JibrilMohamud/cove/actions/runs/40440196022.

## Critical remaining release gates

This proof is **not** deployed Stripe webhook → captured tender → immutable settlement receipt/outbox → EPUB/audio/offline access → refund/withdrawal certification. Canonical positive publishing, offers, contracts, grants, checkout, settlement and revocation must all be owner-first or fenced with durable reconciliation before replacing the anonymous storefront's primary D1 read. A green synthetic owner test is not a justification to switch source-of-truth ownership.

Hosted-capacity still measures a synchronous-primary-D1 path and has independently recorded both D1 service waits and HTTP/2 header-delivery stalls after fast Worker execution. Keep the strict cold 3/3, concurrency 1/4/8/16/32, **2 × 12,000 complete valid requests at 100 RPS**, **zero drops**, **every end-to-end response <800ms**, and mobile p75 LCP <2.5s with all parity constraints. No outlier removal, rerun-until-green approval or best-of-N result. No owned Cloudflare zone/custom domain existed as of this QA run; do not claim owned-domain capacity certified.

Separately, the public taxonomy display-count API now avoids a synchronous expensive aggregate on Cloudflare-less `waitUntil` transports. Category counts are **presentation labels**, never permission checks; the actual listings, payments and delivery must still use current legal authority. The repository's existing fullsite browser CI points to the old `cove-puce-theta.vercel.app` host by default, so its LCP outcome is **not a deployed PR-head performance certification**.
