# Hosted proof — rights-gated primary outbox to isolated literary D1

Date: October 20, 2026. Release status: **DRAFT, OFF**.

A real protected Cloudflare Worker, bound to **two different nonproduction
D1 databases** plus nonproduction private R2, exercised an atomic
rights-checked source intent, one-at-a-time primary outbox claim, delivery
to the independent preparation queue, simulated missing primary ACK and
an idempotent replay, followed by independent grant revocation.

Actual Actions evidence:
https://github.com/JibrilMohamud/cove/actions/runs/39486334005

Actual result:
`{"pass":true,"duplicateAcknowledged":true,"replayDeduplicated":true,"revokedCancelled":true,"independentJobs":1}`.

Read-only post-run Cloudflare audit:
- **0** synthetic literary primary outbox records.
- **0** synthetic secondary literary preparation jobs.
- No lingering `cove-literary-handoff-smoke-20261020` Worker.
- Cove's production persistence backend deployment timestamp unchanged.

This run used synthetic AU source/product/retail rights grants in staging.
After one deliver, the secondary held a single idempotent content-addressed
job. Requeuing the original primary event to simulate a response/ACK loss
and redispatching it kept **one** secondary job, not two.
Revoking a second book's grant between intent creation and delivery
cancelled its outbox intent and created no second preparation job.

The isolated preparation job's separate source/EPUB/rights validation,
explicit-deny precedence, protected private R2 evidence, final nonpublic
primary import and music inventory were verified in prior separate hosted
and local tests. All remain release-gated.

## What this does NOT prove

The combined pipeline does not yet produce customer-visible enriched
`literary_profiles` with chapter sequencing parity. It does not
demonstrate 60-minute mixed load, 100 RPS, p95/p99 or 32-concurrent
hard TTFB/LCP limits, offline/checkout flows, or 1,000 streaming users.
Two bounded primary D1 writes per delivered book and eligibility SELECTs
remain, by design. Running a 100-RPS synthetic request flood against
Cove's shared production D1 is **not** acceptable release evidence when
the corresponding isolated rights/commerce/reader environment is not
fully provisioned and the preexisting D1 contention remains unresolved.

Production catalog, legal-rights grants, actual music curation, Worker
runtime configuration, cutover flag and routing remained unchanged.
