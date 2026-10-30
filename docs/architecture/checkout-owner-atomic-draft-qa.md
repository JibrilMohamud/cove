# Checkout owner migration: isolated atomic draft stage (October 30, 2026)

**Status: private-QA implementation only. Not a certified or activated checkout.**

The original checkout starts with a canonical, previously quoted cart, but writes
`commerce_orders` and each `commerce_order_items` row sequentially on the
shared D1 principal. An intermediate failure can leave a pending order with
missing lines, before fraud assessment, tender/promotion reservation and quote
consumption. Its 56 reviewed direct-commerce SQL sites remain unresolved.

This increment introduces an authenticated, strictly typed
`commerce.materialize-checkout-draft` owner command. The legal-authority
Durable Object performs the actual canonical D1 inserts. It reads the quoted
buyer, identity, prices, currency, territory and immutable item snapshots from
the **canonical D1 quote**, validates 1–25 scoped line items and exact money
allocation, and commits the parent order plus every line with **one D1 batch**.
It refuses a mismatch, replay identity collision, malformed or expired quote.
The caller cannot send SQL, a price, a fee or an entitlement. The receipt
explicitly says `riskAssessed:false`, `tenderReserved:false`,
`quoteConsumed:false`, `paymentAuthorized:false` even after successful
materialization. This is a preparatory write, never a payment receipt.

**No production and no checkout caller are switched to this route.** The
existing commerce checkout path, risk policy, direct writer SQL and 371
owner-command-required findings are unchanged. A command from an unenrolled
principal, stale test lease or production primary is denied before the handler.
The independent canonical release gate remains closed.

## Follow-on work necessary before cutover

- Reprice the cart in the trusted API before sending the expected fingerprint;
  the private owner independently checks the persisted quote fingerprint, but
  cannot infer live catalog/risk changes from that string alone.
- Move fraud-policy evaluation and its risk assessments/cases/holds under
  owner-first control, with recovery for a durable partially prepared order.
- Atomically reserve gift-card/store-credit/promo tenders and consume only the
  validated quote, with concurrency-safe balance checks and replay receipts.
- Enroll only fenced staging checkout callers in the owner commands, preserve
  the external Stripe TEST idempotency and payment-intent attachment, and
  certify retries, races, cancellation, refunds and provider outages.
- Retire legacy commerce SQL only after a real, complete deployed replacement
  is independently proven, then remove alternate production D1 credentials.
  Only after this can the full production release gates be reconsidered.

The regression script checks quote expiry, immutable buyer/quote pairing,
strict command input, total/tax/tender consistency, duplicated products,
nonretail scope and the owner-only atomic draft boundary. Source tests are
not a substitute for deployed fault-injection and settlement QA.
