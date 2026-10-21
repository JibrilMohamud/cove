# Literary inference quota ledger — first physical D1 split (OFF by default)

This milestone separates only *inference quota accounting* from Cove's
customer-critical rights/catalog/commerce D1. It is not the entire
background data-plane migration: literary_profile_jobs, literary_profiles,
literary_profile_sections, and EPUB catalog writes still use primary D1.

## Design
- Legacy primary mode is the default and continues using
  `literary_profile_budget` in `DB`.
- Opt-in mode `FORE_CONTENT_BUDGET_MODE=isolated` is permitted **only**
  on an enabled dedicated literary Worker (`FORE_CONTENT_PROCESSOR_ROLE=literary`),
  with a physically distinct `CONTENT_DB` and primary runtime-config
  `literary_budget_domain=isolated`.
- The primary config is the cutover fence. Before any uncached AI
  inference, the running worker confirms the mode. The **primary
  reservation SQL also checks this fence atomically**: a legacy request
  with a stale preflight cannot spend after the fence switches.
- The independent D1 contains only the `literary_profile_budget` ledger
  and `literary_budget_cutover` activation log, created by
  `infra/content-budget/0001_ledger.sql` on **CONTENT_DB only**.
- A separate `literary_budget_cutover` row must be seeded and actively
  approved for the *exact UTC day* before isolated SQL will reserve
  further work. The cutover predicate is repeated **inside the atomic
  quota insert/update**, so a closed ledger cannot be spent after a
  preflight. Cached R2 results make no new reservation.
- Failed inference still consumes its reservation. Only successful
  verified-cache publication may optionally settle unused output units
  in that **same selected ledger**. Spending and settlement are bounded
  character-work units, not external model token/currency billing.
- If either D1 binding, primary fence, day's seed row, or explicit role
  fails, the literary job fails closed; no primary fallback is allowed.

## Initial isolated staging rollout
1. Provision an independent **staging-only CONTENT_DB** and execute the
   migration `infra/content-budget/0001_ledger.sql` against it only.
   Use independent staging catalog DB/R2 and no real customer rights,
   billing tokens or live worker routing.
2. In staging's primary D1, configure
   `literary_budget_domain=primary`, and run one known reservation.
   Observe the primary amount and calls.
3. **Disable the old inference writer**; let any claimed jobs settle or
   expire, then verify no on-demand inference routes still write primary.
   This is a hard prerequisite, not a mere assumption based on cron.
4. Set `literary_budget_domain=isolated` in staging primary D1. Existing
   writer reservations now fail atomically, so the initial fence can
   temporarily halt inference safely rather than overspend.
5. Copy the current UTC day's exact `reserved_units,calls` from primary
   to independent D1, with an immutable operator receipt; insert the
   day's `literary_budget_cutover` control row, first `prepared`,
   then `active`. Never start at zero when the current day had spend.
6. Deploy the separate Worker with staging-only bindings,
   `FORE_CONTENT_BUDGET_MODE=isolated`,
   `FORE_CONTENT_PROCESSOR_ROLE=literary`; initially disabled.
   Test unauthorized role, missing binding, unseeded next UTC day,
   budget exhaustion, duplicate concurrent reservations and cutover
   cancellation. Enable only after full mixed-load and rights tests.
7. At every UTC-day rollover, create a new correctly seeded row. Until
   the next day is active, inference pauses rather than silently
   authorizing unbudgeted calls.

## Rollback / no-double-spend
- **Stop independent literary inference**, await all claims to finish
  or expire, and close today's CONTENT_DB control row.
- Reconcile the independent ledger's actual reserved work, calls and
  successful settlements with primary history. Apply any excess work
  to the primary ledger before moving the runtime fence back; there
  is no cross-D1 distributed transaction. Do not simply reactivate
  primary with stale units.
- Return primary `literary_budget_domain` to `primary` only after
  an immutable reconciliation receipt and confirmation that independent
  consumers are disabled.
- Do NOT restore a historical smaller counter and do NOT claim both
  databases are simultaneously writable. On ambiguity, leave both
  inference modes halted and repair the ledger manually.
- Monitor primary D1 SELECT/UPDATE latency, reader/checkout/rights SLO,
  model budget, publisher lag, missing R2 evidence and inference throughput.

### Limits / unsolved work
This first split removes a frequent *budget ledger* write from the primary.
The primary still hosts per-job leases, chapter/overview publication, source
catalog and customer rights. Sustained 100-RPS/32-request mixed traffic,
cold maxima, mobile LCP and live territorial revocation remain separate,
**blocking commercial release** until measured. This migration is an
engineering candidate, not a production runbook authorization.
