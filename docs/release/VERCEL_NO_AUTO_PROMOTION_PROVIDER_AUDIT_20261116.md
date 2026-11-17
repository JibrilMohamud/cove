# Cove — real-provider audit-only merge safety witness

**Scope:** documentation-only candidate to verify provider-side no-auto-promotion
after the November 16, 2026 production incident documented in issue #718.
This is not a production release, test-pass assertion, or permission to
enable rights/payment/traffic changes.

## Preconditions

- Operator independently verified in **Vercel → Cove → Settings →
  Environments → Production → Branch Tracking** that **Auto-assign Custom
  Production Domains** is disabled.
- Before this audit, both `covereads.com` and `www.covereads.com` pointed
  to the prior, deliberately restored production deployment
  `dpl_HrWWUHUhMkDQjbFmZ5TW8g8dHWBr`.
- Cloudflare read-only preflight independently found these deployed Worker
  versions pinned to 100%:
  - `cove-persistence-backend`: `401f2af2-6e69-4611-8110-1d127af6eecf`
  - `cove-canonical-d1-readonly`: `f252025f-04c4-4e71-a9e9-134ee3f4c6c3`
  - `cove-legal-authority-production`: `3463ff93-f077-40bf-a4d5-fb7bfc143cd5`
- Production legal authority remains **disabled**:
  `COVE_RIGHTS_OWNER_ENABLED=0`.
- Only this file is added. No executable source, runtime config, workflow,
  dependency, D1 migration, DNS or Cloudflare deployment input may change
  in the audit candidate.

## Real-provider check after an approved merge to main

1. Compare exact PR tree to the approved one-file documentation change, require
   successful applicable checks and a pinned head SHA.
2. Observe the actual Vercel Git-connected **main** event/deployment record.
   Distinguish **no deployment**, **preview/READY without promotion**, and
   **automatic production-domain assignment**; do not infer provider behavior
   from a source `ignoreCommand` or offline mock.
3. Independently retrieve **both** domain aliases after the merge. They must
   still point to the *same* preflight production deployment. If either
   moves, immediately request targeted provider rollback to the prior pinned
   production deployment and recheck both aliases; treat the audit as failed.
4. Inspect actual production persistence, canonical-read and legal-owner
   Cloudflare deployments and owner setting, comparing *all* three to their
   preflight pins. Any difference is a failed audit and an incident.
5. Confirm that no protected D1 migration/deploy workflow was dispatched.
   Control-plane deployment pins can exclude a version promotion, but cannot
   alone prove that no independent D1 writer mutated records. Keep the separate
   physical-writer/primary-D1 gate open until approved audits pass.
6. Retain issue #718 open until this exact real-provider witness, the Vercel
   production auto-assignment setting, and a usable protected rollback are all
   reviewed. A single clean audit-only merge does **not** certify arbitrary
   future production changes or the full protected rollback gate.

## Hard NO-GO boundaries

Do not activate the production legal owner, publish or reinstate rights,
increase traffic, switch aliases, change Stripe LIVE, run customer loads, or
merge the experimental phase-telemetry #740/#741 stack based on this document.
The release performance targets, production 503 elimination, exclusive writer
authority, rights/legal evidence, Stripe LIVE settlement-to-revocation and
protected rollback remain independently required.
