# First-payment and protected-media isolation QA — 2026-10-27

## Certification status

**PASS: isolated, deployed first-payment Stripe TEST → ledger/outbox → owner entitlement, and QA-only private R2 EPUB/audio bytes + P-256 offline EPUB receipt → refund/denial. NOT production-route or rights-writer release certified.**

This document distinguishes observed results from work which has **not** been proven. No production Stripe payment, actual user account, primary production D1, catalog-capacity D1 write, production media storage, owned domain, checkout/customer routing, or anonymous authorization cutover was performed.

- [Real first-payment acceptance](https://github.com/JibrilMohamud/cove/actions/runs/40560262095): passed on `9e373c1ccafd919a5a7abfe9465b143523868672`.
- [First complete live private R2 media acceptance](https://github.com/JibrilMohamud/cove/actions/runs/40561009757): passed on `d04ffe5c8f4455484ce0be42ac58008284f16692`.
- [Private owner QA baseline](https://github.com/JibrilMohamud/cove/actions/runs/40485832897): passed preexisting already-paid synthetic fixture only.
- New regression `scripts/check-customer-media-owner-order.mjs` inspects the original customer EPUB/audio/offline entrypoints for required fail-closed owner checks **before** bytes/signatures are issued. This static proof is not a substitute for deployed original-route execution.

## Physical isolation

- Test account ID: `d26430caa63ec55f6612e32f36aca5e9`.
- Paid QA D1: `7c7ab994-f6b3-419d-a72d-71eb9ea22e7e`. Separate synthetic schema-only source: `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3`.
- The source's missing DDL, and indexes only, were copied into the **paid QA** D1. No capacity or production rows were copied, and no capacity DB mutations were issued.
- Every campaign adds a unique synthetic `order_initial_qa_<runId>`, `user_initial_qa_<runId>`, item and idempotency key by cloning one already-authorized immutable checkout scope.
- The private Durable Object owner and legal writer are service-bound only; short-lived bearer authorization is required to reach the temporary QA proxy.
- Media campaign creates a per-run ephemeral **private R2 bucket** with one original minimal EPUB ZIP and one original silence WAV. Both are uploaded to Cloudflare R2 and read back from the deployed Worker using a private R2 bucket binding. Each successful response is SHA-256 checked.
- Both ephemeral media objects and the bucket are deleted after the Workers are torn down; a cleanup failure fails the workflow.

## Real first-payment acceptance

1. Start with canonical order in `pending_payment`, **no buyer entitlement** and `stripe_due_minor=399`, using a separate synthetic user. No paid content is accessible before settlement.
2. Create and confirm a real **Stripe TEST** $3.99 PaymentIntent. The official Stripe CLI signs the actual `payment_intent.succeeded` event bytes.
3. Forward the signature and untouched event bytes to the deployed QA Worker, which invokes Cove's **original** `stripeWebhook` and `finalizePaidOrder`.
4. Inject a deterministic **owner-only failure after D1 has committed paid order, buyer entitlement, financial ledger and royalty reconciliation outbox**. The signed webhook is marked failed and content stays denied by the independent owner.
5. Validate canonical `paid` and `paid_at`, nonempty double-entry ledger with amount sum zero, and pending `finance.royalty_fee_reconciliation_required` outbox row.
6. Replay the **same signed original event** without the injected failure. It invokes the original already-paid recovery handoff to independently verify and publish owner proof; content becomes available. Parallel replays are duplicates and ledger rows remain bit-identical.
7. Refund the **TEST** PaymentIntent using Stripe's real provider API; owner-first revocation of the exact order immediately prevents access even if canonical entitlement reconciliation lags. Replay after refund cannot resurrect buyer proof.

## Private media and offline receipt acceptance

The **QA-only** `/qa/epub-bytes` and `/qa/audio-bytes` routes require the canonical buyer/order and call the same `requireStagePaidEntitlementAccess` strong-owner procedure as Cove's protected customer routes. They read the real ephemeral private R2 objects, with no-store response headers and correct EPUB/WAV MIME types. Both file hashes are checked against generation-time hashes. Owner outage returns 503, never stale cached permission.

The **QA-only** `/qa/offline-epub-license` issues a seven-day P-256 signed receipt using the production application's `OFFLINE_EPUB_CONTEXT`, claim format, hash and key-ID helpers, and an ephemeral test signing key. The actual application's `verifyOfflineEpubReceipt` verifies this receipt, and rejects a different buyer. Owner outage fails issuance. After refunded-order tombstoning, EPUB, WAV and offline license routes deny. The real customer issuer `issueOfflineEpubLicense` was **not** exercised here.

### Critical offline revocation semantics

A previously issued and locally stored seven-day offline receipt **cannot be invalidated on a fully disconnected device immediately after a refund**; no remote owner RPC can reach the device. The successful test proves immediate denial of **new online requests/issuance**, not retroactive invalidation of previously stored offline bytes and cryptographic receipts. Offline clients must revalidate on reconnect, and product/legal policy must explicitly accept expiry-bounded revocation delay or shorten offline lease duration.

## Remaining mandatory production-release gates

1. **Original customer-media routes:** Deploy against a fully provisioned authorized paid EPUB edition and an independently licensed commercial audiobook with actual release/publication, digital-asset versions, narrator/rights/manifest, device registration and grant rows. Certify **original** `issueCommercialEpubGrant`, `serveCommercialEpubGrant`, `handleCommercialAudio` tracks and audio offline-license, `issueOfflineEpubLicense`, user identity, download usage, concurrency and bytes after authorization, owner failure, refund and contract withdrawal.
2. **Production canonical writer migration:** Convert and audit all grant, contract, offer, publication, territory, paid settlement, entitlement and delivery writer paths, including background/support jobs, behind private owner-first/fail-closed positive proof; eliminate all raw D1 bypasses before anonymous storefront primary-D1 authorization can be removed.
3. **Strict hosted capacity and owned Cloudflare domain** remain unpassed/uncertified for this stacked branch. Do not use isolated media/Stripe CI to release routing.

Keep PRs #356/#357/#358 draft until these requirements and production safety gates are met. The prior passing tests do not change source-of-truth ownership or grant commercial distribution rights.
