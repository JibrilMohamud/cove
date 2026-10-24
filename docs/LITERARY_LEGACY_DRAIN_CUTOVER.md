# Literary legacy-D1 ownership drain and isolated cutover

**Status: code-only safety fence, not authorization to migrate production.** This
runbook intentionally does not contain an automatic production mutation.

## Ownership authority

`cove_runtime_config.literary_processing_owner` is the **canonical primary D1**
fence for **legacy literary scheduler writes**. Missing key or `legacy` maintains
old behavior; `draining`, `isolated`, and unknown values fail closed for *new*
legacy background sweeps/leases. The scheduler reads the flag before touching
backlog tables; both catalog-sweep lease acquisition and job claims independently
retest the flag within the primary SQL statement. The background `addJob` INSERT
is fenced in the same SQL transaction. This applies to the legacy literary
scheduler, not checkout, reader entitlements, live rights, or other catalog jobs.

**Not a global DB write fence.** A worker that obtained a valid legacy lease
*before* `draining` may finish its work. Do not set `isolated` until the legacy
workers are stopped and all such work is durably quiescent. Admin edits that
invalidate a profile may still update canonical provisional metadata; they
must enter the isolated pipeline through a separately verified handoff.

## Staging sequence (manual operator only)

1. Deploy the owner-fencing code to a dedicated staging backend. Keep all
   production cron, Worker, customer routing and `literary-infer` flags OFF.
   Confirm legacy default behavior and dedicated test suite before proceeding.
2. Confirm no other deployment writes `literary_profile_jobs` without the new
   owner gate. Disable the old scheduler trigger in **every** legacy deployment
   before writing the cutover key. Observe the off->on dry-run fence in staging.
3. As an approved off-peak staging operation, insert/update the canonical key:

   ```sql
   INSERT INTO cove_runtime_config(key,value)
   VALUES ('literary_processing_owner','draining')
   ON CONFLICT(key) DO UPDATE SET value='draining'
   WHERE value='legacy';
   ```

   If an existing row has any other value, the UPSERT changes nothing. Verify
   the final value explicitly; never force an unknown owner to `legacy`.
4. Read `literary_profile_state.lease_until` and inspect bounded/approved
   legacy job-lease and backlog reconciliation summaries off-peak. Wait for
   every in-flight sweep and preparation/analysis claim, including extended
   per-section leases, to finish. A timed-out lease is **not** proof a Worker
   stopped; also check Worker execution logs and active invocations.
5. Reconcile **every outstanding legacy book** with the independently fenced,
   replay-safe primary outbox -> CONTENT_DB preparation pipeline. Only an exact
   current source SHA, live source-specific allow, and absence of overriding
   territorial denials may seed a new isolated preparation. Do not copy grants
   or entitlements to CONTENT_DB. Old metadata-only, chapter-only and failed
   jobs are not interchangeable with completed prepared EPUB evidence; record
   which can migrate, which must be held, and which are legitimately obsolete.
   An optional, one-job-per-tick catch-up is now implemented but **OFF**:
   install `infra/content-budget/0008_legacy_reconcile_frontier.sql` only
   into the explicitly isolated CONTENT_DB; after verifying that every legacy
   Worker stopped, set `literary_legacy_reconcile_frontier.status='armed'`
   using an independently approved staging D1 operation, and enable
   `FORE_LITERARY_DRAIN_RECONCILE_ENABLED=1` only on the protected
   `literary-handoff` role. Every candidate is selected by primary PK cursor
   and must have a current provisional fingerprint. Its existing
   `seedLiteraryPreparationHandoff` call enforces live source SHA, territorial
   allow/deny and canonical primary outbox insertion. The secondary ACK cursor
   and disposition receipt are committed together; lost ACKs replay the
   deterministic primary outbox. Rights-ineligible candidates become **held**,
   never silently treated as eligible. There is no operator-facing endpoint.
   When exhausted the frontier becomes `complete`, not automatically rewound.
   **Completion alone is not approval**: compare held receipts, excluded
   chapter/obsolete jobs, old queued/running totals, isolated prepared/inference
   totals, source-fingerprint parity and primary intent receipts against a frozen
   manifest before approving the next step.
6. Only after all old writers are drained, all necessary legacy work is
   reconciled and dedicated QA load/rights gates pass, change the primary
   owner from `draining` to `isolated` using a conditional transaction:

   ```sql
   UPDATE cove_runtime_config SET value='isolated'
   WHERE key='literary_processing_owner' AND value='draining';
   ```

   A zero-row update is a failed transition. Then activate the separately
   approved CONTENT_DB budget-day fences, preparation, handoff, inference
   and private publisher roles, staged and independently verified.
7. Exercise 100-RPS 2,000/2,000-arrival, zero-drop, p95<600ms, p99<750ms,
   max<800ms, cold, 1/4/8/16/32 concurrency, 23-market rights/revocation,
   purchase->signed webhook->reader/audio->refund/revocation, and mobile
   p75 LCP gates before authorizing customer routing.

## Failure / rollback

During drain, pausing new isolated workers and **leaving primary owner
`draining`** is the safe default: customer rights and final publication
remain canonical. Never flip straight back to `legacy` while isolated
claims, outbox deliveries or inferred results can still publish. A rollback
to `legacy` requires an audited freeze of those roles, closed budget days,
lease reconciliation, a clean rights/fingerprint manifest, and separate
operator authorization. No automatic rollback action or production writes
are introduced by this PR.
