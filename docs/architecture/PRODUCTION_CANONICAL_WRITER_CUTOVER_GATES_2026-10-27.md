# Production canonical writer closure and owner-only storefront release gate
**2026-10-27 · Review-required draft · NOT READY FOR PRODUCTION CUTOVER**

## Outcome of source audit
GitHub Actions [canonical-writer-closure-audit #40583820036](https://github.com/JibrilMohamud/cove/actions/runs/40583820036) **passed**. It scanned **440 source files** and flagged **466 static candidate canonical SQL writes** across **28 files**. All 466 are **unverified ownership**; the scan does not prove that each mutation is exploitable or that it executes on production. By category:

| Domain | Static direct mutation candidates |
|---|---:|
| Publication, grants, contracts, offers, markets | 206 |
| Commerce and financial settlement | 101 |
| Catalog/source | 91 |
| Protected EPUB/audio/assets/delivery | 54 |
| Customer permissions/entitlements | 14 |

Highest-concentration files: `src/features/fore/publishing.server.ts` (88); `commerce.server.ts` (67); `publishing-trust.server.ts` (58); `traditional-publishing.server.ts` (58); `api.server.ts` (33); `commercial-audio.server.ts` (24); `catalog-model.server.ts` (21); `rights.server.ts` (18); `preorder.server.ts` (15); `delivery.server.ts` (14). Download the `canonical-writer-inventory` artifact on that CI run for every source file, line, table and operation. The pipeline is deterministic and tests that a production-owner-only `--release-gate` invocation fails even when supplied with local confidence flags.

The scan is a **lower bound**: dynamically constructed SQL, foreign repositories, operator consoles, Cloudflare API D1 writes, direct SQL executed from management scripts, provider callbacks and external cron are not statically certified. Treat zero unverified static candidates as **necessary but not sufficient**, never as proof of a deployment cutover.

## Closed staging SQL-denial coverage (2026-10-27 follow-up)
The runtime staged primary-D1 canonical write lock previously omitted **23** protected tables present in the scanner, including the financial ledger, payment attempts, audio offline events, publication and grant provenance, and publishing lifecycle metadata. Those tables are now included; `finance_parties` was also added to the static inventory. A second function-level audit added **28 further authorization-critical tables**, including contract-version territory/format/channel rules, legal disputes, copyright withdrawal records, commercial delivery policy, finance usage and publisher intake. Both registries contain the **same 120 protected tables**, enforced by a deterministic CI registry check and an executable SQL-denial suite against the bundled TypeScript runtime guard. The broadened scanner reports **466 static candidates** across 28 files; these are expanded coverage, not newly introduced application writes.

This is an **expanded DENY-ALL staging barrier**, NOT migration: no positive canonical writer has been certified by this change. The guard rejects unported writes rather than routing them, covers only Workers that actually use its wrapped D1 binding, and cannot by itself block direct Cloudflare D1 operator access or independently deployed unwrapped jobs. It must not be enabled as production owner-only authorization.

## The owner-authorization bottleneck is real
`src/storefront-strangler/bootstrap-optimized.server.ts` still uses `authorizeHomepagePresentation(rawDb,p,d1Metrics)` for anonymous catalog authorization. The `authorizeHomepageWithUnifiedOwner` branch only works in an explicitly constrained, synthetic staging environment; it requires `COVE_SSR_STAGING=1`, a pinned staging DB, `COVE_CANONICAL_LEGAL_WRITE_LOCK=1`, independent private owner binding and owner authentication. Removing primary-D1 authorization while any positive contract, grant, publication, offer, market, settlement, entitlement or delivery writer bypasses the owner can cause stale rights publication. Setting `COVE_LEGAL_OWNER_WRITER_CLOSURE_AUDITED=1` alone does **not** close those paths.

## Required canonical command ordering

**Deny/suspend/withdraw/refund, including evidence and regional market changes:** validate immutable principal + entity + operation ID; synchronously commit durable negative denial to the global strongly consistent owner; require a valid exact scope and epoch acknowledgment; **then** mutate canonical D1 with a guarded predicate and durable reconcile receipt. If D1 fails, leave the owner denial in effect. Retries must not resurrect positive rights.

**Positive grant/contract/offer/publication or paid entitlement activation:** write verified canonical version under a fenced writer; independently fetch the canonical version, source evidence and current legal state inside the owner; publish the **fresh** positive only when the owner epoch and revocation fences still match; ensure no legacy D1 customer consumer can use the intermediate positive. A stale snapshot, old payment webhook, reverted contract, source withdrawal or ABA restart must be denied. Verification and positive commit must be atomic within the owner.

**Protected media/device/offline:** original customer EPUB grant/download, audiobook chapter/stream and online license issuance/verify must consult that same owner per protected operation. Offline receipts already stored on a fully disconnected device are not instantly remotely revocable; seven-day expiry and reconnect checks remain an explicit product/legal tradeoff.

## Closure audit work required before enabling owner-only read

1. Move **every** rights and contract editor, traditional publisher/offer writer, all positive and negative publication lifecycles, territory/market activation, catalog ingestion and background maintenance to exact scoped owner-first commands. Inventory includes API endpoints, jobs, scheduled publishing and support consoles; operator/direct Cloudflare mutations need an independently enforced policy.
2. Port checkout, Stripe signed webhook + settlement, prepaid/store-credit/gift tender, finance/royalty outbox, entitlement grants/refunds, hold/dispute settlement and preorder conversion behind owner-first commit paths. The previous deployed Stripe+R2 QA validates isolated synthetic scenarios only; do not treat it as canonical production writer closure.
3. Port EPUB/audio asset versions, commercial delivery grants, device registrations, reading/offline leases, audiobook contracts, narrator rights and publication evidence. Enforce withdrawal-to-protected-byte denial in the actual customer handler.
4. Run `node scripts/check-canonical-writer-closure.mjs --audit` continuously, with an explicit review/port for **every** unverified candidate and generated/foreign writer. Owner-only `--release-gate` fails closed until externally certified.
5. Require a complete **deployed** multi-writer reconciliation certificate: owner negative before D1 mutation, fresh positive verified after canonical write, interruption/replay/concurrent webhooks and loss of the D1/provider, plus rollback and stale-reinstatement tests. Do not use a GitHub self-declared readiness string as evidence of a closed write plane.
6. Cut over anonymous authorization in a revision-pinned **owned Cloudflare domain** only after all writers and deployed owner dependencies pass. No stale KV/R2 authority; private R2/KV stores presentation-only bytes. Preserve zero-drop, all-maxima-under-800ms cold/concurrency/100-RPS release gates without exclusions.

## Independently checked Cloudflare topology
At this audit Cloudflare returned **zero account-owned zones** and **zero custom Worker domains**. This is a separate blocker for production-domain end-to-end performance/edge-tail certification. Existing `.workers.dev` QA or a staging address cannot replace an owned-domain SLA claim.

## Code changes and release behavior
- `scripts/check-canonical-writer-closure.mjs`: actual on-checkout, line-addressable, deterministic direct canonical SQL inventory; `--audit` saves review evidence; `--release-gate` **refuses** production activation, including on zero static candidates until independent controls are verified.
- `scripts/test-canonical-writer-closure.mjs`: asserts scanner coverage, deterministic evidence, known high-risk writer files and that attempted owner-only release always fails.
- `.github/workflows/canonical-writer-closure-audit.yml`: publishes CI evidence on the reviewed branch.
- `.github/workflows/release-staging-certification-preflight.yml`: verifies the same fail-closed requirement before further staged release work.

**No production D1 mutation, owner binding, customer domain, canonical writer cutover or production routing change is authorized by this branch.** It must remain draft; the requested production migration and performance cutover are **not complete**.
