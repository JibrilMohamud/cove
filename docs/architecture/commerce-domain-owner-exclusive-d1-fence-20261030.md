# Incremental domain-exclusivity fence for the commerce writer family

**Status:** source implementation and isolated tests only; production setting is NOT enabled. This document is not certification, a SQL audit reclassification, a release approval, or a claim that the complete production commerce family has migrated.

## Strategic purpose

The previous all-owner D1 facade blocked **every** persistence and scheduled canonical mutation at once, coupling the 56-site legacy commerce retirement to the remaining publishing, trust, catalog, and other migrations. The new `COVE_COMMERCE_OWNER_D1_FENCE` permits non-commerce canonical D1 writes while denying direct transaction, money, refund, Stripe, preorder, purchased-version, entitlement, fulfillment-revocation, and royalty-table mutations outside the owner.

Unlike a route flag, the same restricted D1 facade surrounds **both** backend HTTP and cron. It rejects SQL DDL, CTEs, PRAGMA, comments, stacked statements, and unknown verbs; its `batch` accepts only statements prepared through the same verified facade. It exposes no `exec` or `withSession`. Dynamic SQL still goes through `prepare`, where it is checked before reaching D1. No API caller may supply its own SQL to the owner.

This is a pre-cutover safety boundary, not a reliable substitute for Cloudflare D1 table-level permissions. SQL triggers, indirect writers, other Workers, operator tokens, and external API credentials are **not** restrained by this process-local proxy and must be independently inventoried and retired. The exact production principal is still accessible to the backend today.

## Activation policy

Default and `0` leave the environment and DB binding byte-for-byte unchanged, preserving current customer transactions. Any malformed configuration fails closed. Opt-in requires exact production D1 ID, legal write lock, a configured private owner binding and secret, and no QA/staging mode; those prerequisites **cannot by themselves certify** owner authority. Do **not** set `COVE_COMMERCE_OWNER_D1_FENCE=1` in live Cloudflare until complete checkout quote/payment, settlement, webhook, dispute, refund, reconciliation, financial admin, prepaid tender, invoice, and relevant background writer behavior has been switched to independently authorized production-owner commands. Existing QA commands are still hard-coded to synthetic databases.

Before activation independently verify production owner execution, signed Stripe events and settlement/refund provider queries, exactly-once ledger/tender outcomes, grant and media delivery, source withdrawal and refund/chargeback revocations; survey triggers and all other production principals; rehearse a deployed rollback. Then *remove*, not just bypass, 56 legacy caller SQL sites and independently prove no alternate production paths. Rebase the exact source review with deployed retirement evidence; only then can the metric decrease.

## Validated properties

`node scripts/check-commerce-d1-write-fence.mjs` compiles the **actual** TypeScript fence and tests both entrypoint bindings, no-op production defaults, strict opt-in, independent read access to checkout orders, continued unrelated non-commerce writes, direct and quoted commerce table names, subquery mutations, finance and entitlement side effects, forged batch objects, DDL, CTE, and stacked SQL. The existing global write fence and all production release blockers remain unchanged. Audit should still report 371 owner-required sites and 56 commerce sites.
