# Cove paid legal owner: isolated full-schema staging proof

Status: **private QA certified for the synthetic pre-paid order plus real Stripe TEST payment/refund and original signed webhook recovery; NOT production-ready** (2026-10-27).

## Physically isolated ownership

- Cloudflare account: `d26430caa63ec55f6612e32f36aca5e9`.
- Dedicated ENAM D1: `cove-paid-commerce-legal-qa-20261027`, ID `7c7ab994-f6b3-419d-a72d-71eb9ea22e7e`. This is NOT production D1 and not the hosted-capacity D1.
- The D1 is a **canonical rights/commerce dependency subset**, not a 508-table full production clone. Installed table definitions and 54+ indexes are copied **schema only** from separate synthetic capacity QA D1 `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3`; no customer records and no shared writes. A canonical `retail_product_availability_rows` view and isolated synthetic price/catalog book fixture were also installed.
- The synthetic book `prd_paid_qa_20261027` is paired with exact US-retail contract/version/grant and USD 399-cent offer, a synthetic settled order `order_paid_qa_20261027` and buyer entitlement `ent_paid_qa_20261027`. The fixture starts in `paid` status; the deployed integration subsequently creates a **real $3.99 Stripe TEST PaymentIntent and refund**, and delivers the Stripe CLI-signed successful-payment webhook into Cove's actual handler. This does **not** demonstrate transition of a pending canonical order through financial ledger settlement.

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

**Additional certified deployed test:** https://github.com/JibrilMohamud/cove/actions/runs/40458829507 (2026-10-27). A real Stripe TEST PaymentIntent ($3.99; test Visa) and refund are made with a restricted, CI-step-only test credential. The official Stripe CLI supplies a signature over original event bytes; a localhost relay forwards them with a separate 12-minute bearer gate to the temporary deployed Worker. That Worker invokes Cove's **actual `stripeWebhook` function**, persists the event-ID hash/lease/processed receipt to isolated synthetic D1, and invokes the actual staged paid settlement owner on its **already-paid** order. The identical signed event replays as a duplicate, and refund via exact provider refund ID durably denies the private buyer before canonical entitlement reconciliation. After refund, owner and protected read reject access. The test deletes the ephemeral Workers and restores the fixed synthetic entitlement and Stripe PaymentIntent linkage. These tests run with **no real production payments, publication or capacity D1 writes**.

## Critical remaining release gates

This proof is **not** a single deployed pending-checkout → real Stripe event → tender/ledger settlement and outbox → actual protected EPUB **bytes**, audiobook **bytes**, offline **license** → webhook-driven refund/withdrawal certification. Its payment webhook exercises the already-paid, event-recovery branch; the provider refund and private owner-deny bridge are orchestrated by the QA executor, not by the real `refund.updated` financial-ledger handler. Canonical positive publishing, offers, contracts, grants, checkout, settlement and revocation must all be owner-first or fenced with durable reconciliation before replacing the anonymous storefront's primary D1 read. A green synthetic owner test is not a justification to switch source-of-truth ownership.

Hosted-capacity still measures a synchronous-primary-D1 path and has independently recorded both D1 service waits and HTTP/2 header-delivery stalls after fast Worker execution. Keep the strict cold 3/3, concurrency 1/4/8/16/32, **2 × 12,000 complete valid requests at 100 RPS**, **zero drops**, **every end-to-end response <800ms**, and mobile p75 LCP <2.5s with all parity constraints. No outlier removal, rerun-until-green approval or best-of-N result. No owned Cloudflare zone/custom domain existed as of this QA run; do not claim owned-domain capacity certified.

Separately, the public taxonomy display-count API now avoids a synchronous expensive aggregate on Cloudflare-less `waitUntil` transports. Category counts are **presentation labels**, never permission checks; the actual listings, payments and delivery must still use current legal authority. The repository's existing fullsite browser CI points to the old `cove-puce-theta.vercel.app` host by default, so its LCP outcome is **not a deployed PR-head performance certification**.
