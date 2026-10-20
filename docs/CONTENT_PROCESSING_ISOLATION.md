# Content-processing isolation — operator rollout

This phase adds an independently scheduled Cloudflare Worker binary for two
background roles, instead of running EPUB downloads and literary inference
inside the persistence Worker's minute maintenance chain.

## Roles and guarantees

- assets: invokes the existing serialized, leased, source-rate-respecting EPUB downloader.
- literary: invokes the existing literary sweeper, durable preparation jobs and
  budget-limited per-job inference claims.
- Both default to disabled via FORE_CONTENT_PROCESSOR_ENABLED=0.
- A read-only D1 probe runs once per tick, deferring nonessential work when the
  primary has high latency or is unavailable. Budget is configured by
  FORE_CONTENT_D1_ADMISSION_MAX_MS (default 300ms).
- The HTTP handler returns 404 and performs no mutations or authorization.
- This separates Worker CPU, memory and scheduling ONLY. Both roles still
  share the same primary D1 database until the authority/data model is moved.
  Therefore this alone is NOT proof of production database isolation or
  commercial performance.

## Staging and deployment

Build with npm run build:content-processing, test with
npm run test:content-processing-isolation.

Provision two separate staging Workers from content-dist/worker.js, with
FORE_CONTENT_PROCESSOR_ROLE=assets or literary respectively. Each requires a
fully migrated and isolated staging D1 plus private R2; literary also requires
AI. The Worker must start disabled, on a one-minute cron. Do not bind staging
to production D1/R2 or customer identities.

Do not use automatic production deployment for this candidate.

## Two-stage, reversible cutover

1. Prove rights, R2 integrity, leases, inference reservations, crash recovery,
   D1 admission and a capacity gate on production-shaped staging.
2. Deploy both processors disabled and verify environment bindings, Worker
   versions and that the HTTP path cannot run a job.
3. Enable both separately (enabled=1), verify they claim and finish jobs and
   their output matches the old scheduler. Keep this overlap brief.
4. Switch the existing persistence Worker flag FORE_CONTENT_PIPELINE_EXTERNAL=1,
   which bypasses only asset/literary minute tasks; audio QA and music
   profiling remain active.
5. Watch database wait time, storefront/reader/rights/checkout latency,
   per-source EPUB failures, Worker CPU, stuck leases, job retries and cost.
6. Roll back by resetting FORE_CONTENT_PIPELINE_EXTERNAL to 0 first and then
   disabling the new processors; verify leases drain, no lost work and correct
   catalog/rights/reading behavior.

The database write domain still needs physical isolation before declaring
a commercial-scale fix. See issue #238 for remaining milestones. Do not
raise source concurrency, model daily units, or auto-approve audio licenses.
