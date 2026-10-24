# High-throughput isolated music QA and review

**Status: implementation and CI opt-in. No production source access, customer music
publication, production routing or new permissions are enabled by this PR.**
Depends on merged PR #284; all state below lives in separate `MUSIC_DB`.

## Execution components

- `infra/music/0003_execution_quotas_metrics_reviews.sql`: durable source-specific
  `music_intake_jobs`, source quota/paused controls, the append-only stage usage
  ledger and one immutable acoustic human-review receipt per analyzed policy.
- `POST /v1/execution/source-limits` is an **isolated operator** action
  applying per-contract intake and analysis daily and parallel limits. Absent
  or paused records yield no claims. Initial QA cap: 20 source masters/day,
  2 concurrent transfers, 40 analyses/day, 2 simultaneous analyses (set
  explicitly per signed contract; these are examples, not defaults for activation).
- `POST /v1/execution/intake/claim`: ingestion principal only. It durably
  seeds manifests already registered under active licensed contracts, then
  atomically claims *one* exact original with a 12-minute lease while enforcing
  per-supplier limits and logging an idempotent claim event in the same D1 batch.
  Only an unexpired lease permits PUT to the existing authenticated R2 staging
  API when `MUSIC_EXECUTION_ENABLED=1`. Lease completion and upload receipt
  are committed together; failed acquisitions get bounded retries.
- `POST /v1/analysis/claim` retains its existing 15-minute fenced lease,
  now requiring a live, unpaused per-source quota when execution is enabled.
  Audio QA and analysis never run in the storefront. Completed exact-master
  analyses store a versioned report, policy outcome, optional cost and processing
  time in an atomic transaction. Actual billing cost remains **unknown/null**
  until a trusted compute-pricing/usage integration provides it.
- `GET /v1/execution/review`: private human listening exception queue.
  `GET /v1/execution/review/{id}/audio` streams an exact R2 master only
  to a distinct authenticated acoustic reviewer, with active contract and
  object integrity checks. `POST /v1/execution/review/{id}` requires an
  exact master + report hash, full-master listening attestation, independent
  reviewer identity and a substantive rationale. Only a current
  `needs_review` result can be approved/rejected; the action is fenced
  against rights withdrawal and replay. Publication remains a private
  metadata outbox event, never customer playback authority.
- `GET /v1/execution/metrics`: isolated operator summary, rolling 24-hour
  stage success/failure counts, bytes, processing duration, per-source quotas
  and backlog, known priced micro-USD amounts **plus unpriced job counts**.
  It must not assert unmeasured executions are free.

## Deploy and operate — QA only

1. Apply migration 0003 **only to** `cove-music-supply-qa-20261023`, never
   primary D1. Preserve the earlier migrations and independent R2 originals.
2. Install separate least-privilege credentials:
   `MUSIC_INGEST_TOKEN_SHA256`, `MUSIC_ANALYSIS_TOKEN_SHA256`,
   `MUSIC_MUSIC_REVIEWER_TOKEN_SHA256`, legal reviewer and operator hashes
   on the isolated Worker. Acoustic reviewer must not be the legal reviewer.
   Keep plaintext secrets solely in the isolated run environment.
3. Explicitly turn on `MUSIC_SUPPLY_ENABLED=1`, `MUSIC_ANALYSIS_ENABLED=1`,
   `MUSIC_EXECUTION_ENABLED=1` **in an isolated QA environment only**,
   after enabling per-provider quotas via the operator. The checked-in
   Wrangler config keeps all three at 0, as well as
   `MUSIC_AUTO_QUIET_APPROVAL=0`. Keep automatic approval off until the
   independent blinded acoustic validation has passed.
4. Register actual rights-covered manifests with the existing scoped
   supplier ingestion flow. The source runner fetches only those immutable,
   exact-master URLs; it does **not** crawl FMA or Musopen or acquire
   commercially restricted masters.
5. Run bounded intake from a trusted isolated compute environment:

   ```sh
   COVE_MUSIC_EXECUTION_RUNNER_ENABLED=1 node scripts/music-supply/drain-source-intake.mjs --execute --workers=4 --max-tracks=32 --max-minutes=20
   ```

6. On separately scoped CPU/GPU runners, install FFmpeg and pinned
   `scripts/soundtracks/profile-requirements.txt`/Torch runtime, then:

   ```sh
   COVE_MUSIC_ANALYSIS_RUNNER_ENABLED=1 python scripts/music-supply/analyze-qualifying-masters.py --execute --semantic-model --max-tracks=8 --max-minutes=24
   ```

   Each process loads the CLAP model only once. A protected GitHub Action
   `isolated-music-high-throughput-qa` provides a four-lane execution matrix.
   Its schedule performs **no processing at all** unless an operator separately
   configures `vars.COVE_MUSIC_HIGH_THROUGHPUT_QA=1` and scoped QA secrets.
   It does not connect to primary D1 and is not a verified production capacity
   claim. Source and analysis admission remains globally capped in MUSIC_DB
   even across concurrent hosts/lane retries.
7. Human reviewers use `scripts/music-supply/review-private-queue.mjs`
   with `--list`, `--audio=master-id --output=private-original.ogg` and
   `--decision=attestation.json`. Review JSON must contain:
   `masterId`, `masterSha256`, `reportSha256`, `decision` (approve/reject),
   `heardFullMaster: true`, `reviewerId`, and substantive `rationale`.
   Delete local licensed master copies after the permitted review.
   Operators use `--metrics` with the separate operator token.
8. Keep revocation processing live even when supply is paused. Validate
   old/expired lease replay, source-day caps, concurrent claims, forged
   analysis, incorrect acoustic report, human reject/approve, withdrawn
   contract, and canonical tombstone precedence before any customer release.

## Explicit boundaries and what is not yet certified

This code creates **real durable detached worker admission and multiple
parallel consumers**. It does not provision real supplier rights, execute
commercial source requests, label a recording with verified listening
accuracy, pay for external GPU compute, or authorize playback. The current
supplier handoff remains metadata-only; it cannot release sound to readers.

Before enabling ongoing production processing, run background OFF→ON→OFF
multi-region acceptance with 100 RPS phases, zero dropped requests, p95
<600ms, p99 <750ms, max <800ms, cold and 32-concurrent TTFB <800ms,
mobile LCP, real entitlement/media and live rights revocation tests.
Record signed review and supplier licenses as independent legal gate evidence.
