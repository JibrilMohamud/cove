# Production commerce ownership — 30 October 2026 read-only cutover audit

**Release decision: BLOCKED. Production commerce authority remains disabled. This note is not retirement evidence.**

## Verified inventory

The canonical exact-SQL source review on `main` after PR #489 reports **370** `owner-command-required` findings, including **56** in `src/features/fore/commerce.server.ts`. The other large unretired writer families are publishing trust (53), publishing (49), and traditional publishing (38). Removing their entries from the registry without removing executable production write paths is explicitly forbidden.

## Verified production-boundary evidence

Read-only Cloudflare Worker settings for account `d26430caa63ec55f6612e32f36aca5e9` were queried during this work:
- `cove-legal-authority-production`: `COVE_RIGHTS_OWNER_ENABLED=0`, canonical `PRIMARY_DB` points to production D1 `4bd657ac-8789-403e-a28c-93aba8d0a989`. **No `STRIPE_SECRET_KEY` binding and no `STRIPE_LIVEMODE` binding** are present. An independent owner cannot verify payment provider metadata or refund settlement from these deployed bindings.
- `cove-persistence-backend`: still has a direct production D1 `DB` binding; commerce-only execution fence and production commerce enrollment flags are **not set**. Existing live direct SQL remains possible.
- `cove-storefront-ssr-staging`: likewise uses the production D1 database. It does not itself certify an exclusive commerce production owner.
- The connected Cove Stripe account visible through the Stripe plugin is **test-mode only**; a real live-mode payment/refund/chargeback transaction cannot be certified through that connection.

The source revealed a configuration-contract defect: commerce's deployment-only D1 fence previously required `STRIPE_LIVEMODE="1"`, but the private legal owner determines live Stripe identity using the **exact string `"true"`**. This PR aligns those checks. It does **not** enable either flag, modify Cloudflare resources, or change Stripe transactions.

## Fastest defensible closure

To retire all 56 commerce source sites together rather than repeatedly touching individual SQL lines:
1. Provision an independently authenticated **production** commerce owner, with *live* provider key and mode, rights/entitlement authority, strong serialization/idempotency, and separate privileges. Do not reuse QA-only leases.
2. Enroll *every* live checkout quote, payment setup, zero-due settlement, payment webhook, disputed charge, refund, reconciliation, promotions/tender, scheduled and administrative writer to typed private commands. Preserve existing user-facing responses and fail-closed behavior.
3. Verify actual live provider-originated event signatures and API reads; perform a complete controlled payment-to-entitlement-to-delivery-to-revocation/refund journey and replay/crash tests, including withdrawn commercial rights and preorder settlement. Stage/test-mode evidence alone is insufficient.
4. Verify that all concurrently deployed APIs, cron jobs, backup/old Worker scripts, D1 direct credentials, triggers, and administrative principals are incapable of competing financial writes. A process-local D1 regex proxy is not database-level privilege retirement.
5. Only after that, delete the old 56 SQL literals and their reachable legacy callers, generate independently reviewed source retirement evidence, run the exact source reconciler and security CI, rehearse rollback, then update the deployment. Keep the independent release gate closed otherwise.

**Do not** set `COVE_RIGHTS_OWNER_ENABLED=1` or `COVE_COMMERCE_OWNER_D1_FENCE=1` before these checks. The deployed owner remains QA-gated in source and production-disabled in runtime. The verified SQL finding count remains 370 throughout this patch.
