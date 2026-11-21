# Cove: isolated real-catalog acceptance without creating a production D1 writer

**Release state:** NO-GO. This document and PR do not create or certify a legal snapshot.

## Why the existing path was unsafe

`fast-storefront-real-catalog-acceptance` used to replace the staging
Worker's D1 binding with primary production database UUID
`4bd657ac-8789-403e-a28c-93aba8d0a989`. It then created disposable
Workers.dev Workers. Even if their application SQL happened to be SELECT-only,
a standard D1 binding has *physical* write capability and is inconsistent
with the requirement for one exclusive, legally authorized production writer.

Do not run the older protected workflow. The revised source refuses the
primary UUID before any Wrangler upload, Cloudflare D1 query, R2 or KV access.
It also rejects the two historical 50k synthetic performance databases, which
were independently found to contain **zero** edition taxonomy links.

## Preconditions for a real isolated comparison

1. A legally authorized canonical owner must approve a **single immutable
   source generation and current withdrawal-denial epoch**, captured with
   publication fencing. Do not infer a safe generation from a max timestamp,
   a percentage of records, a self-reported total, or a synthetic fixture.
   Both positive rights and independent denial fences must be checked before
   any content can be delivered. The cross-service DO/D1 withdrawal race
   remains a release blocker.
2. Obtain a privacy-minimized real-catalog **isolated database**, with 82,247+
   matched public product and edition records, actual taxonomy links, and
   strictly necessary rights-policy projections. Do not copy customer
   identities, orders, payment data, source contracts, raw protected content,
   tokens, or account secrets into the staging fixture. The source must be
   frozen by the owner, have an independent integrity receipt, and remain
   private. Do not run a full-table source export on an overloaded primary
   without a separately approved I/O budget and rollback strategy.
3. Give this isolated database its own new UUID and a name that does not
   contain `production` or `primary`. Configure the exact UUID/name in
   protected GitHub Environment variables
   `COVE_REAL_CATALOG_SNAPSHOT_D1_ID` and
   `COVE_REAL_CATALOG_SNAPSHOT_D1_NAME`. A missing value fails before
   any remote operation. Neither known 50k fixture qualifies.
4. Run the protected `fast-storefront-real-catalog-acceptance` workflow
   manually on an **exact reviewed main SHA**, with approved protected
   environment, and no automated production route or primary DB binding.
   The script independently checks bounded D1 aggregate counts before it
   creates a Worker, requires explicit zero-write result metadata, and
   cleans up all newly created Workers. A passing count is **only a minimum
   structural preflight**, not a claim that every product has correct rights.
   The generated Worker must be a fresh disposable Workers.dev identity with
   an origin bound to that identity. The pre-upload guard rejects **indirect
   owner/production access** through service, Durable Object, dispatch,
   Hyperdrive or privileged bindings, rejects customer routes, queues,
   cron schedules, tail consumers and payment/owner configuration, and limits
   any optional R2/KV binding to the pre-approved presentation staging stores.
   Worker observability/log collection is disabled for the potentially
   sensitive isolated fixture. A passing config guard cannot certify that
   external Cloudflare account tokens have exclusive physical write access.
5. Separately compare immutable owner revision, product IDs, country/language,
   format/DRM, legal expiry, withdrawal, restoration, exact search/count/
   facet/pagination envelopes and real negative witnesses. Fail closed for
   any missing, dirty, stale, unsigned or mismatched projection. A full legal
   parity witness is not implemented by this source guard and must not be
   inferred from it.
6. Run protected, version-attested staging performance in ORD/LAX/IAD/DFW:
   cold and warm 1/4/8/16/32 with every TTFB **strictly below 800ms**, then
   two 20-second 100-RPS phases with 2,000 valid responses each, p95 below
   600ms, p99 below 750ms, max below 800ms, and **zero drops or unauthorized
   books**. The legacy visual preview tests only a low-volume subgate and
   **cannot** certify these global thresholds.
7. Prove exclusive production D1/Cloudflare-token writer authority, enabled
   legally controlled owner and current independent denial fence, signed LIVE
   Stripe settlement-through-entitlement/refund/withdrawal and protected
   rollback. No staging result permits unreviewed public alias promotion.

This PR introduces the physical primary-binding deny and incomplete-fixture
preflight only. It neither creates a snapshot nor removes any of the remaining
gates. Existing customer domains and Worker pins remain unchanged.
