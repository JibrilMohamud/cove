# Fenced content-worker transfer and budgets (not a release authorization)

A separate Worker alone does not isolate primary D1. Keep external content
processors disabled while live marketplace traffic is being certified.

## Single owner, reversible drain

Both the persistence Worker cron and the external `assets`/`literary`
roles check **canonical primary D1**, using these independent keys:

- `content_assets_owner`
- `content_literary_owner`

The missing-key default is `legacy`. Only the literal values `legacy`,
`draining`, and `external` are recognized; other values fail closed.
`FORE_CONTENT_PIPELINE_EXTERNAL=1` is a second mandatory gate for the
external Worker; it also prevents the legacy minute scheduler from starting
those roles. External Workers additionally require their existing
`FORE_CONTENT_PROCESSOR_ENABLED=1` and precise role.

The asset runner's claim/lease INSERT is also guarded **inside the same
primary-D1 SQL statement**. A stale worker that preflighted before ownership
changed cannot start a new asset lease after the fence. Existing leases and
in-flight processing may finish: wait for actual Worker termination *and*
expiry/clearance of any relevant leases before changing the owner.

In isolated staging only, after all participating Worker versions have the
owner predicates:

1. Check current primary owner, Worker versions, `catalog_asset_runner`
   lease, literary lease statuses, and background metrics.
2. Pause external Workers. Set the chosen owner from `legacy` to
   `draining` with a conditional `UPDATE cove_runtime_config SET
   value='draining' WHERE key=? AND value='legacy'`. Existing assets finish,
   no new ownership claims are admitted.
3. After **drain plus queue reconciliation** and a rollback rehearsal,
   conditionally change `draining` to `external`. Enable both sides'
   `FORE_CONTENT_PIPELINE_EXTERNAL=1` only after all old deployments have
   the owner checks; otherwise keep `draining` and both lanes idle.
4. To roll back, first quiesce external Workers, set the owner to
   `draining`, wait for all external leases to clear and independently
   reconcile the queue. Only then conditionally return `draining` to
   `legacy` and unset the external switch. Do not flip directly from
   `external` to `legacy` while work is active.

The separate legacy `literary` external role is **hard disabled** as
`legacy_literary_claims_unfenced` until its primary-D1 claim/sweep writes
receive atomic owner predicates. Only the separately fenced
`literary-prepare`/`literary-handoff`/`literary-infer` roles can participate
in a later authorized isolated-data-plane cutover. That takeover also needs
its own `literary_processing_owner` fence and migration reconciliation;
the `content_literary_owner` key alone cannot safely migrate those claims.

## Actual asset resource envelope

`assets` in the external Worker meters and refuses further operations when
a limit is reached. Default (bounded) per tick:

| Dimension | Default | Max configuration |
|---|---:|---:|
| D1 statements, including atomic batches | 32 | 100 |
| D1 mutating statements | 16 | 50 |
| Accumulated D1 request/service elapsed milliseconds | 2000 | 10000 |
| Total R2 PUT payload bytes | 32 MiB | 128 MiB |
| Elapsed wall-time cutoff | 40 seconds | fixed |
| Separate asset attempt count | 1 default, hard max 4 | 4 |

Environment overrides:
`FORE_CONTENT_MAX_D1_STATEMENTS`,
`FORE_CONTENT_MAX_D1_WRITES`,
`FORE_CONTENT_MAX_D1_SERVICE_MS`,
`FORE_CONTENT_MAX_R2_BYTES`. Invalid/nonpositive overrides fail
closed. The database admission probe counts against the D1 budget.

A single in-flight D1 request cannot be preempted; the next is refused once
service time is exhausted. Failure still leaves the source's atomic download
claim to normal lease/retry recovery. The surrounding asset-runner lease may
expire; it must not be forcibly cleared on a concurrent old worker.
R2 payload bytes are counted on writes; upstream response parsing has its
pre-existing 30-MiB-per-response hard bound. These protections constrain
individual ticks; they do **not** prove the 800-ms production latency gate.

The rights/commerce gates, published music scope, and release routing remain
unchanged by this PR.
