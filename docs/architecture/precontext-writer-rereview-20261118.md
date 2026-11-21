# PR #781 — source-bound canonical writer re-review for diagnostic markers

**Review date:** 2026-11-18 UTC  
**Baseline:** `main` `c25fa51c2e380428cd91a045d458574160b5dead`  
**Scope:** `src/features/fore/api.server.ts` only; read-only fault-attribution instrumentation, not release authorization.

## Why the gate failed

The canonical writer inventory binds each SQL site to a SHA-256 digest of the **entire** containing source file, plus function, SQL literal, operation, and occurrence. Even non-SQL code changes invalidate every reviewed site in the edited file; the three CI failures were correct. This is **not** merely a line-number shift. The diagnostic patch changed the source fingerprint, invalidating all 33 reviews recorded for this file.

## Independent, strict source review

Compared the full 274,792-byte original file with the proposed 503 instrumentation. Deleting exactly one fixed, numeric-only `observedPreContext` helper and reversing precisely four known edits reproduces the baseline file **byte-for-byte**, not just its SQL strings. The edits are:

1. Legal-contact call: wrap without changing arguments or return/throw behavior
2. Auth-handler call: same pass-through wrapper
3. Identity lookup: same pass-through wrapper
4. Database binding resolution: catch only to mark a fixed numeric diagnostic and rethrow the **same exception**

The wrapper does not catch and recover, change principal identification, enable owner authority, change D1 bindings, or expose request/header/user/SQL/error details. It adds only constant, request-local `Server-Timing` stage markers.

All 33 previously reviewed SQL statements match one-to-one on `file`, `functionName`, `table`, `operation`, and exact `sqlSha256` (the one site below the instrumentation moves down 22 lines). Each review still has `owner-command-required`, `productionOwnerGuarded: false`, its original command family and its original explanation; **no site was reclassified**. `releaseApproval` remains `false` and all 281 other reviewed sites are unchanged.

The JSON review updates only the 33 exact new source-bound site IDs and the one new line number. This is a re-review of the unchanged SQL and guards in the changed source, **not a blanket rebase**. The independent `scripts/release/check-precontext-writer-rereview.mjs` runs inside PR CI with full git history: it reconstructs the original baseline exactly, independently checks every old/new review entry, and runs the complete current writer inventory/reconciliation to reject a single remaining unknown or stale site. Future changes to the source, new SQL, altered authorizing guards, or reduced denials break the check.

## Strict negative statement

This re-review does **not** certify physical D1 writer exclusivity. Existing shared API writer sites still require owner-only migration; the primary legal-owner Worker remains disabled, the production persistence Worker retains its competing primary-D1 binding, and account-level Cloudflare mutation tokens still require retirement. The read-only production rights comparison, LIVE Stripe fulfillment/refund/revocation, four-region latency/100-RPS targets, 503 recovery, and protected rollback remain independent release blockers. No production Worker, database, credential, domain, or route is changed by this PR.

**Release decision: NO-GO.** The dependency vulnerability audit remains mandatory and cannot be waived to merge this patch.
