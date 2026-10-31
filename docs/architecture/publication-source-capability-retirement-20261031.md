# Continuous publication canonical D1 capability retirement

The scheduled `cove-pub-qa-continuous-capture` Worker now binds only its independent public snapshot D1. Its canonical production D1 binding was removed and replaced by an authenticated service binding to fixed advisory snapshot reads on `cove-legal-authority-production`. The reader accepts an active country or a market-list request; it accepts no SQL, identifiers, customer data or legal commands. A reader outage has no direct-D1 fallback. The production legal authority remains disabled.

Verified on October 31, 2026:

- Owner reader version: `3f5850868d9442e28649a1de3a74aee5`.
- Continuous capture version: `07fc397a823446098f017c8ac4adf786`, independently read back at 100%. The minute cron is unchanged.
- A separately authenticated, expiring Worker with no canonical D1 binding exercised the actual capture implementation and private reader. HTTP 200; IE and IN captured, 23 expected markets, complete coverage. The verifier was deleted.
- After cutover, the scheduled capture reached cursor ZA, 23 expected markets, released lease, and a full-cycle timestamp of `1793455969067`.
- A fresh complete inventory read all 450 Workers without errors. Six non-owner canonical D1 principals remain: literary handoff, literary preparation, literary inference, literary publisher, persistence backend and storefront SSR staging. Several literary Workers are enabled; their names do not establish inactivity. External API principals remain unaudited.

The prior soundtrack migration also remains deployed without canonical D1. Local publication-feed tests exercise the real source handler and capture adapter, authorization failures before D1, bounded markets, SQL/customer-input rejection, ambiguous capability rejection and source outages. All 91 owner-workflow steps, TypeScript and lint passed before the final capacity-only changes.

This retires an advisory reader capability. It does not certify production legal commands, canonical writer exclusivity, LIVE payment processing, geographic performance or production rollback.
