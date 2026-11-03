# Cove audio: Cloudflare Queues + Python Container migration

Status: **source migration prepared; live activation not certified**.

Cove's previous Vercel service uses `scripts/audio_pipeline/service.py` as
the HTTP producer, `subscriber.py` as the Vercel Queue consumer, and
`worker.py`/`runner.py` as the actual Python audio engine. The replacement
retains the existing Python `RunRequest`, `execute_pipeline`, `reserve_compute()`,
canonical D1 job leases, media fingerprint requirements, and publisher rights
checks. It does **not** introduce independent canonical database writers.

## New architecture

Cloudflare persistence-backend cron scheduler → private Worker service binding
`COVE_AUDIO_DISPATCH` with shared `COVE_AUDIO_DISPATCH_SECRET` →
`cove-audio-pipeline-cloudflare` Worker → Cloudflare Queue
`cove-audio-pipeline-v3` → one-at-a-time Queue consumer → durable
idempotency ledger → private Python 3.12 Cloudflare Container running
`audio_pipeline.cloudflare_service` → authenticated
`https://api.covereads.com` job/rights/media backend.

Queue failure, unavailable credentials, budget deferral and Container failure
do not silently route back to Vercel. The worker has per-delivery backoff,
36 retries and a `cove-audio-pipeline-v3-dlq` dead-letter queue. Jobs are
deduplicated at enqueue and delivery using a 5-minute path/payload digest
and durable ledger. The existing backend's D1 job-lease/fingerprint model
remains authoritative, which also protects retries after an interrupted
Container process.

The Python image is built from `scripts/Dockerfile.cloudflare-audio`,
with `scripts/requirements.cloudflare-audio.txt`, and **does not depend on
`vercel-queue`**. It keeps the FFmpeg/AV and faster-whisper dependencies
required by existing `track`, `align`, `discover`, and `scan` work.

## Safety and release defaults

- The new Wrangler config has `workers_dev=false`, `preview_urls=false`,
  no routes, no D1 or public R2 binding, and
  `COVE_AUDIO_QUEUE_ENABLED=0`. Its Container and ledger are private
  Durable Objects; no arbitrary browser may enqueue jobs.
- Production backend Wrangler config retains `FORE_AUDIO_COMPUTE_MODE=paused`
  and `COVE_AUDIO_PROVIDER=legacy`. This means the new worker has NOT been
  activated. When independently certified, switching to `cloudflare`
  removes the dependency on the current Vercel audio trigger.
- The old Vercel audio functions and queues are preserved **only for
  fail-safe rollback**, not because they are needed by the new implementation.
- The Python Container's `/run` requires
  `COVE_AUDIO_EXECUTION_SECRET`; startup health fails if its backend
  credentials are missing. A Cloudflare Queue Worker adds this header only
  via its private Durable Object binding.
- Cloudflare Containers can incur billable compute/disk and Queues operations.
  Confirm plan and budgets before initial deployment.

## Provisioning and live acceptance still required

1. Create `cove-audio-pipeline-v3` and
   `cove-audio-pipeline-v3-dlq` as isolated Cloudflare Queues,
   and confirm that the account supports Cloudflare Containers (Workers Paid).
2. Provision appropriately scoped Cloudflare deployment credentials, then
   securely install `COVE_AUDIO_DISPATCH_SECRET` in both backend and
   audio Worker (same fresh random secret, 32+ chars).
3. Install `COVE_AUDIO_EXECUTION_SECRET` and properly scoped
   `FORE_BACKEND_TOKEN`, `FORE_SERVICE_TOKEN` in the **private audio Worker
   only**. Cloudflare transfers the secrets as Container environment at
   startup; restart the Container after rotation.
4. Build and deploy the private Worker + Docker image using a protected
   reviewed, least-privilege operator. Confirm no publicly attached route,
   one Queue consumer, exact inactive state and no canonical D1 binding.
   Test against an isolated test D1 with synthetic rights, not live customer
   grants.
5. Activate an isolated canary and validate all four audio job kinds, queued
   delivery, source fingerprint verification, restricted R2 media access,
   hosted BioSync transcript identity, deadline/compute budgets, actual
   duplicate delivery, retry/DLQ recovery, and no grant resurrection after
   withdrawal. Check cold model starts and 5-minute budget.
6. Require owner-approved production access before setting
   `COVE_AUDIO_QUEUE_ENABLED=1` and
   `COVE_AUDIO_PROVIDER=cloudflare`. Audit the queue backlog, D1 job
   leases, login/payment flows, rights and protected playback. Cloudflare
   must keep processing successfully with Vercel audio deliberately
   unreachable before customer traffic is considered migrated.
7. Rehearse rollback to `COVE_AUDIO_PROVIDER=legacy` with the Vercel
   service intact. Only after a soak and verified zero Vercel jobs may the
   old Vercel Queue, FastAPI service, secrets and `vercel.json` audio
   binding be deleted in a separate protected release.

CI runs the real JS Worker bundle, a backend bundle, deterministic queue
contract checks and mocked FastAPI execution/authentication tests. These
are **source tests**, not Cloudflare Container deployment or LIVE proof.
Do not revoke the legacy credential or delete Vercel before steps 1–7.
