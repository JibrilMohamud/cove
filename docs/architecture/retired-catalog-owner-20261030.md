# Exact private catalog writer retirement — October 30, 2026

## Physical source cutover

All **21** `owner-command-required` SQL sites from `src/features/fore/catalog-model.server.ts` have been moved byte-for-byte into `src/storefront-strangler/legal-authority.worker.ts`, and their original identities are frozen in `docs/architecture/retired-catalog-owner-lineage.json`. Seven existing API Gutenberg-normalization callsites and one authenticated personal-import creation callsite now require typed owner RPC. Original shared model no longer offers the mutation statement builders.

Owner-required findings: **281 → 260**; audit remains releaseApproval=false. All 33 retained `api.server.ts` protected SQL sites were source-rebased by exact SQL source-line matching and retained owner-required disposition.

## Privacy, authorization and revocation boundaries

CoveLegalAuthority remains disabled for production. The Durable Object only works on two fixed synthetic QA D1 IDs with a ≤15-minute lease and a 64-hex private bearer. For Gutenberg, it independently reads the source cache plus an approved public-domain territory evidence row and requires completed EPUB storage before its original atomic SQL batch. No public API may supply SQL, legal evidence, product ID or a grant. For private imports, the owner checks the exact user-bounded EPUB R2 object, fresh creation timestamp and existing owner record before an atomic batch, returning an identity-matched receipt.

**Production commercial/public rights are NOT certified**. Positive free-edition grants remain strictly QA-only pending separately proven deny-first cross-jurisdiction owner epochs and source verification, automated replay and offline revoke paths. Personal imports and on-demand source normalization now refuse unbound production routes rather than writing directly; this can temporarily prevent those flows pending the complete migration. Do not turn on production or weaken the guard just to restore an old write path.

Before public activation verify copyright takedowns, publication, staff/cron/API bypass retirement, Stripe TEST-to-media delivery/refund/revocation, protected rollback, performance capacity and all production D1 privilege removal. The count is a source-level retirement, not production readiness.
