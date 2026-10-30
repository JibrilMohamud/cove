# Isolated owner checkout quote and tax evidence cutover (2026-10-30)

The protected staging `POST /checkout/quote` path now calls `commerce.create-quote` before the legacy quote handler can perform any caller-owned SQL. This is not a production migration.

The private Durable Object is gated by the existing short-lived, synthetic D1 QA lease. The owner independently recomputes the live canonical cart, offer/territory pricing, promotion and available gift/store-credit using its own `PRIMARY_DB`, obtains Stripe Tax with its own key, writes the quote and associated tax evidence/calculation, and independently reads the persisted quote before acknowledging. The caller supplies only authenticated user ID and form data, not prices, SQL, quote fingerprints or tax amounts. On owner refusal the staging caller returns 503 and never falls back to its own D1.

Customer-visible quote totals, quote IDs, 30-minute expiry, tax breakdowns and payment follow-up route remain identical. Non-enrolled production uses the original code and therefore keeps the same customer payment behavior. This change does not enable production owner authority, payment, entitlement, contract, refund or publication activation.

**Audit:** 33 original API source SQL sites were source-hash rebased without removing or changing any SQL literal, function, disposition or owner-required classification. All 56 legacy commerce findings remain, and the conservative overall count remains 371 owner-required. This is strictly an isolated QA writer path migration. No production D1 privileges were retired.

**Rollback:** disabling the ephemeral QA lease restores the owner refusal (503) for enrolled requests; non-enrolled production never uses this path. Restore the API route and owner command together to roll back staging. Future production cutover requires full Stripe/media/rights replay QA, proof of authorization and deny-first withdrawal, verified production writer privilege retirement, and deployed rollback rehearsal. No release gate is waived.
