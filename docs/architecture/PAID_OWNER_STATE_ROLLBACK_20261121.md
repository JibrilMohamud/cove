# Protected paid-owner state rollback

The previous isolated rollback probe switched a stateless test Worker. It did
not exercise the real owner, its SQLite denial state, paid D1 state or refunds.
The paid full-schema QA can now rehearse an actual immutable Worker version
rollback with the real `CoveLegalAuthority` class and signed Stripe TEST flow.

Every fresh per-run QA owner explicitly enrolls the current SQL mutation
journal. The gated QA caller forwards the challenge-only, nonauthorizing fence
read. Initial enrollment must be epoch zero; real settlement must advance it;
an acknowledged refund must advance it again. The owner still refuses
historical enrollment, damaged journals and production mutation mode.

For the protected rehearsal, manually dispatch
`paid-legal-full-schema-private-qa` on main with the exact
`reviewed_main_sha` and `confirm_owner_state_rollback=true`. The secret-bearing
job is restricted to main and the `cove-production-release-audit` environment;
the previous special PR branch secret paths are removed. Relevant main pushes
retain the existing hosted TEST certification, now with journal checks; only
an explicitly confirmed manual run performs the additional version rollback.

The rehearsal performs:

1. Capture immutable owner version A and its actual SQLite namespace. Require
   the synthetic paid QA primary, private workers.dev and preview settings,
   the exact journal version and the expected production backend/owner pins.
2. Complete the existing real signed Stripe TEST payment, ledger, entitlement,
   EPUB/audio/offline, fault/replay and owner-outage checks.
3. Deploy a distinct actual owner version B with a QA receipt revision marker.
   The application code and schema are identical; only the revision binding
   differs. Verify both metadata and a fresh challenge from runtime B.
4. Refund the actual TEST purchase and acknowledge its owner-first revocation
   on B. Require the mutation epoch to advance before rollback.
5. POST an immutable 100% deployment of A to this exact run's synthetic owner.
   Verify runtime A, unchanged namespace and exact post-refund epoch, unchanged
   D1 order/entitlements/ledger, immediate 451 authorization denial and refusal
   to resurrect access on replay. The existing media denial checks run on A.
6. Verify production pins throughout; remove all four run-specific Workers and
   synthetic private media using the existing always-cleanup procedure.

The artifact `paid-owner-state-rollback.json` contains version IDs and bounded
booleans/counters, never buyer/payment details or secrets. Offline regressions
reject namespace replacement, stale challenges, epoch regression or unexpected
advance, production D1, production-version drift and untrusted worker names.

This is a synthetic QA business-state and immutable-deployment rehearsal. A
and B deliberately have identical code/schema: it does not establish historic
production code/schema compatibility, full-catalog parity, exclusive production
write authority or Stripe LIVE commerce. `productionRollbackCertified` and
`releaseCertified` remain false. No production serving proof consumes the QA
journal; no customer authorization query or production config is changed.
