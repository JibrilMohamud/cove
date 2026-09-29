# Cove production operations runbook

## Health, telemetry, and error tracking

Public probes:

- `GET /api/fore/health/live` — process/liveness only; does not touch dependencies.
- `GET /api/fore/health/ready` — verifies D1 access and active storefront configuration; returns 503 when not ready.

Every Cove API request receives `x-fore-request-id` and W3C `traceparent`. Request summaries, trace spans, latency metric points and error fingerprints persist in the operations tables and emit structured JSON logs. Configure `FORE_ERROR_REPORTING_URL`/`FORE_ERROR_REPORTING_TOKEN` to mirror unexpected server failures into the chosen specialist error tracker; the bridge must use HTTPS and is best-effort so an error provider cannot take Cove down.

The operations scheduler should run `POST /api/fore/machine/v1/ops/check`, `/ops/slos`, `/ops/synthetics`, and `/ops/alerts` with the operations service principal. The check path validates D1, catalog freshness, Stripe webhook processing, publisher-feed processing, DLQs, backup age, restore-drill evidence, R2 write/read/delete, and the public CDN edge endpoint. Durable incidents deduplicate recurring signals.

Configure `FORE_ALERT_WEBHOOK_URL` and optional `FORE_ALERT_WEBHOOK_TOKEN` to send incidents to PagerDuty/Opsgenie/a private alert router. Alert deliveries persist attempts, response status, retry backoff and terminal dead state. The staff reliability dashboard remains usable if the external paging provider is unavailable.

## Queues and dead letters

`ops_queue_definitions`, `ops_jobs` and `ops_dead_letters` provide a common lease/retry/DLQ substrate. Leases are bound to a service-principal worker ID. Completion checks the active lease. Retries use delayed availability; max attempts move the payload into a durable DLQ. Staff DLQ replay creates a fresh job and records who replayed it rather than mutating the failed history.

Domain queues that predate this generic substrate remain visible through dependency/worker monitoring until migrated. A queue migration should preserve its idempotency key and dead-letter semantics.

## SLOs

Seeded SLOs cover storefront API availability, p95 latency, catalog freshness, payment-webhook success and synthetic checkout resolution. SLO measurements retain good/total events, achieved basis points and error-budget evidence. Production alerts should page on burn rate, not merely on one slow request.

Initial objectives are deliberately explicit policy records, not promises hidden in code. Review them after measured production traffic and tighten only when capacity and incident response can support the target.

## Backup, restore, RPO and RTO

The primary database policy starts with RPO 15 minutes / RTO 60 minutes. Asset storage is RPO 60 / RTO 240; search is rebuildable and has a broader RPO. These values live in `ops_recovery_objectives` and should be changed by an operations review, not silently in a script.

A backup is not considered operational evidence until the provider artifact is registered and verified. Missing/stale verified database backups open a critical incident. A restore drill is not `passed` unless both data-integrity and application probes pass. Missing or overdue restore evidence also opens a critical incident.

Recommended drill sequence:

1. Restore a selected production backup into an isolated account/project.
2. Record exact backup ID/checksum and start time.
3. Run schema integrity + FK checks and important aggregate counts.
4. Start an isolated Cove API against the restored DB/object snapshot.
5. Run readiness, browse/search, entitlement/delivery and non-charging checkout-resolution probes.
6. Measure restore time and observed data-loss window.
7. Register the drill with evidence. If either integrity or application probe fails, mark the drill failed and open remediation work.

Never perform a restore drill over the active production database.

## Deployments, migrations, rollback

Production deployments support blue/green, canary, rolling and explicit emergency strategy records. A canary requires a percentage. Before a production deploy/verifying/promote transition, every listed schema migration must have an `ops_migration_controls` entry. Non-emergency gradual deployments reject migrations not marked backward-compatible. A production deployment requires an explicit rollback plan; promotion additionally requires health-criteria evidence.

Use expand/contract database migrations: add nullable/new structures -> deploy code that can read both -> backfill/verify -> switch writers -> later remove old structures in a separate release. Roll application binaries back before contracting a schema. A `rolled_back` record requires `previousVersion`.

Recommended canary gates: health readiness; 5xx/error-fingerprint deltas; p95/p99 latency; checkout/payment webhook success; queue age/DLQ growth; R2/CDN probes; synthetic storefront/search/checkout; fraud false-positive and entitlement failure rates. Promote only after the observation window remains inside thresholds.

## Synthetic tests

The built-in checkout synthetic is intentionally non-charging: it selects an actually available product and executes the production rights + regional pricing resolver. Stripe webhook health is monitored independently. End-to-end payment-method synthetics should use a separate Stripe test-mode deployment/account and must never send live card data from the production scheduler.

## Capacity testing

`scripts/fore-capacity.mjs` is a bounded HTTP load harness for staging or an explicitly isolated production-shadow environment. It defaults to the liveness endpoint and reports achieved RPS, error rate, status distribution, p50/p95/p99. Record approved results through `/api/fore/admin/operations/capacity` so each release has durable evidence.

Do not point the harness at mutation/checkout endpoints. Capacity scenarios for D1, R2, search, publisher feeds and delivery should use synthetic fixture data and provider-specific load tools in isolated environments.

## Monitoring cadence

Suggested starting cadence:

- liveness/edge: external uptime monitor every 1 minute from multiple regions
- operational dependencies: 5 minutes
- checkout/search/storefront synthetics: 5–10 minutes
- SLO refresh: 5 minutes
- alert delivery: 1 minute or event-triggered
- verified database backup: <=15 minutes according to provider policy
- restore drill: at least monthly for primary DB and after meaningful restore-process changes
- capacity test: before major launch architecture changes and periodically against expected peak x safety factor

The operations dashboard in `/staff/storefront` exposes current dependency checks, SLOs, incidents, queue/DLQ state, backups/restores, synthetics, deployments, capacity evidence and machine identities to authorized operations staff.

## Enforcement details added for production safety

Queue leases are recoverable rather than permanent: the scheduler returns expired `leased` jobs to `retry` before leasing more work, and a worker may only complete a job while its own lease is still unexpired. This prevents a crashed worker from wedging a queue and prevents a stale worker from committing a result after another worker has taken ownership.

Backup status is evidence-bearing. A backup cannot be registered as `verified` without provider verification evidence. A restore drill can only be marked `passed` when integrity and application probes pass, measured restore duration and data-loss window are recorded, the relevant RPO/RTO policy exists, the measurements are inside those objectives, and any referenced backup is a verified artifact for the same service. This makes the restore drill a tested recovery assertion rather than a checkbox.

Deployment records enforce a state machine (`planned -> deploying -> verifying -> promoted`, with explicit failure/rollback paths). Release/environment/strategy identity is immutable after creation. Migration safety metadata can be reviewed through `/api/fore/admin/operations/migration-control`; `down_sql` controls require concrete rollback SQL, while forward-fix/restore/expand-contract strategies remain explicit policy choices.

Alert and external error-reporting sinks are HTTPS-only, reject embedded credentials and obvious loopback/private destinations, disable redirects, and redact bearer/service/Stripe-secret material from persisted diagnostics. These controls are defense in depth; production egress policy should additionally restrict the worker to approved observability and paging destinations.
