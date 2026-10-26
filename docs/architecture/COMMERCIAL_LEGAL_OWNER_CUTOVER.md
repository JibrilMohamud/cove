# Commercial legal authority cutover — isolated implementation and release gates

**Status: staging-only implementation; not a certified production ownership transfer.**

## Design constraints

The hard hosted-capacity gate is **cold 3/3**, concurrency **1/4/8/16/32**
with each request under **800 ms**, and **two 120-second 100-RPS phases** of
12,000 valid responses each, zero drops, p95 < 600 ms, p99 < 750 ms,
and absolute measured response max < 800 ms. Never relax these,
remove slow requests, substitute a synthetic catalog, or infer a guarantee
about future public-network tails from one passing run.

The passing baseline on commit
`70c22824b796fa3c2e5dda95ebbcd5e2dfa13618`
used real authoritative primary-D1 rights, still under intermittent
D1 service/HTTP transport risk. **Preserve that revision as the control.**
Commercial work must not add owner or D1 RPCs to anonymous first paint.

## Implemented ownership primitives (off by default)

- `legal-authority-core.ts`: deny-first public-domain Gutenberg authority,
  immutable evidence/market proof with monotonic revision; no paid fallback.
- `commercial-legal-core.ts`: **separate** product-level grant scope keyed
  by canonical product, country, retail/subscription/library channel, edition,
  canonical grant, contract and contract version. Source-of-truth D1 is
  consulted **only during positive proof publication** in the private
  `legal-authority.worker.ts`, using the existing canonical
  `resolveProductRights(..., {persist:false})` evaluator. The owner
  rejects stale positive publication after an intervening denial.
  Positive refresh of an **identical** still-authorized grant keeps the
  product epoch and preserves buyer proof validity. Substituting the grant
  or contract version without a prior owner denial is forbidden.
  Contract/grant withdrawals are serialized in batches of at most 25.
- `commercial-entitlement-core.ts`: a distinct buyer-specific entitlement
  epoch and 5-minute proof. Positive publication demands canonical active
  purchase, paid order, granted order item, matching purchased grant and
  contract version, and absence of buyer-risk fulfillment holds.
  Reinstatement is tied to the exact new *product epoch*. An old purchase
  proof cannot revive when a withdrawn contract is reapproved for a
  different grant. A refund denial is acknowledged before any D1
  entitlement-status mutation.
- The combined private `/commercial/entitlement/authorize` performs
  one service-binding RPC and one indexed SQLite join of product grant,
  owner epoch, buyer identity and entitlement epoch. It is called on
  **authenticated protected delivery only**, not anonymous storefront
  rendering; missing/expired/revoked proof fails closed.
- `legal-quarantine-qa.writer.ts` has narrowly specified and QA-only
  operations for commercial grant suspension, contract suspension, and
  exact buyer entitlement revocation. It discovers canonical product
  scope itself, refuses >25 affected products, requires the private
  owner denial receipts **before** canonical SQL, and never accepts
  caller-supplied arbitrary SQL. Partial D1 failure leaves owner denial.
- Full Stripe-success **refund** webhooks now have an opt-in QA-only owner
  handoff: before the canonical refund is acknowledged, the private writer
  discovers every buyer entitlement for the order, serializes at most
  25 denial operations in one Durable Object transaction, then updates
  exactly those entitlements in one canonical D1 batch. It fails closed
  if an owner receipt is missing or D1 fails; the same refund event may be
  retried without advancing the denial epoch. Zero additional calls occur
  on anonymous homepage loads, product cards or music discovery routes.
  The legacy direct entitlement mutation remains only when the stage
  ownership flag is off. **Real production Stripe webhook cutover is not
  yet activated.**
- The existing staged `scopeStageLegalWriterEnv` write lock denies all
  unfenced legal mutations in the legacy API/cron and never enables on
  production. Consumer opt-in additionally requires exact QA-D1 ID, a
  live private DO binding and an operator secret. No public callback
  authorizes paid grants.

## Additional customer invariants

A product grant is **not** an entitlement. Checkout still verifies
canonical offer, discounts, territory, price and captured rights snapshot,
and now compares the strong owner's exact paid grant/edition/contract
version to the pricing snapshot under staging. Protected issuance and
redemption continue requiring active canonical entitlement, buyer-risk
clearance, publisher delivery policy, version, DRM, device, download
limits, user identity and usable asset. The new combined paid authority
fence is **additional** rather than a replacement until the independent
customer data plane is fully certified.

Offline EPUB licenses are time-limited, signed artifacts. No server can
retroactively erase an offline license from a fully disconnected device;
revocation is enforceable when it reconnects or the existing license
expires. Do not advertise instantaneous disconnected-device revocation.

## Unfinished and mandatory before production

1. **Close every writer.** Full-refund revocation is now present for the
   QA-only staging event, but paid purchase **issuance** and paid order
   settlement/recovery must be moved to a durable, idempotent outbox
   executor before the legal write lock can activate. A captured payment
   cannot be left "paid" with unfulfilled entitlements on a retry;
   no ad hoc owner lookup in a public request should be used to conceal
   missing fulfillment.
   Enumerate and move all direct grant/contract,
   scope/territory-language, source evidence and canonical publication
   writers, publishing contracts and policy-version transitions, purchase
   fulfillment, refund, disputes/chargebacks, entitlement grants/revokes,
   offline signers and every downstream grant/token mutator into audited
   owner-first operations. The existing QA writer covers narrow suspension
   paths, not arbitrary creation/update. The legacy production writer
   cannot remain capable of changing authorization without a strong
   owner receipt.
2. **Certify real paid fixtures.** The existing separate QA-D1 binding is a
   deliberately minimal publication fixture and lacks the full product,
   contract, order and entitlement schema. Unit SQLite regression tests
   exercise the commercial state machine, but the live Cloudflare QA
   environment does **not yet** represent a full paid order/contract.
   Provision a full-schema isolated QA fixture, confirm Stripe test
   webhook → payment → entitlement → protected delivery → refund →
   immediate revocation, and test interruption/replay/canonical failover.
3. **Publication refresh.** Versioned positive proof publication should
   run from an independent bounded queue, with explicit per-source D1
   statement/byte/service-time accounting and durable settlement receipts.
   Refresh the existing immutable grant off-path before its expiry;
   customer endpoints must not do opportunistic D1 reauthorization or
   silently extend their own leases.
4. **Rights propagation.** Verify identical owner vetoes across
   homepage, product details, checkout quotation/payment, reading,
   protected EPUB/audio endpoints, entitlement creation/redemption
   and offline issuance. Verify territorial and customer identity
   separation and contract-specific acquired-access policy.
5. **Transport/provider release gate.** Provision a user-owned Cloudflare
   zone and custom Worker domain. The connected account currently has
   neither. Repeat full strict acceptance on the same SHA/domain across
   target geographic regions with edge/Worker/D1 wall-time evidence.
   The isolated-product models do not solve independent public HTTP/2
   1–2-second delivery tails; track provider investigation separately
   in issue #353.

**Production routing and canonical owner switch remain off** until all
five conditions pass. A passing single run of 24,000 hosted requests
does not waive this release checklist.
