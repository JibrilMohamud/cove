# Isolated music qualification — initial staged milestone

**Status (2026-10-24): code-only, off by default. No production ingestion,
new customer music publication, scheduled processing or storefront routing.**
This adds the missing handoff from immutable supplier master/full-decode QA to
music profiling and a versioned, rights-fenced *private* qualification receipt.

## Isolation and trust boundaries

- `MUSIC_DB` and `MUSIC_BUCKET` are the detached music-supply QA bindings.
  Apply `infra/music/0002_qualification_leases.sql` **only to that MUSIC_DB**
  before staging the feature; never run it against Cove's primary D1.
- `MUSIC_SUPPLY_ENABLED=0`, `MUSIC_ANALYSIS_ENABLED=0` and
  `MUSIC_AUTO_QUIET_APPROVAL=0` in the checked-in QA Worker.
- Existing production supplier handoff behaves as before when analysis is off.
  When analysis is on, full-decode QA instead creates a durable job and does
  **not** enqueue a `master_qualified` event.
- Each job keys to the exact master SHA-256 and `cove-quiet-reading-v2`.
  The analyst uses a separate `MUSIC_ANALYSIS_TOKEN_SHA256`, never the
  license reviewer, source ingest, audio QA or general operator credential.
  The 15-minute lease uses fenced tokens, capped retries and explicit backoff.
- Full audio is only accessible on an active lease after rights and private R2
  integrity checks. Completed analysis is bound to that exact master and
  cross-checked against the independent FFmpeg quality measurements. Its report
  lives in private R2 under a content-addressed key; its result is committed
  with an isolated durable handoff event in a single D1 batch.
- The new private catalog projection and the supplier outbox both enforce
  active contracts, unchanged masters and acoustic approval. Old qualification
  messages are not publishable if the original master has since been withdrawn.
  Canonical customer rights, playback and country enforcement are unchanged.

## Running an explicitly authorized QA cohort

1. Apply the isolated migration to the QA music database.
2. Issue a **new independent, high-entropy analyst credential**, store its
   SHA-256 as the isolated Worker's secret `MUSIC_ANALYSIS_TOKEN_SHA256`;
   never send the token in chat, code, Actions logs or manifests.
3. Explicitly enable the isolated supply service and
   `MUSIC_ANALYSIS_ENABLED=1` on a non-public QA Worker with staging-only
   R2/D1. **Do not enable** `MUSIC_AUTO_QUIET_APPROVAL` until blinded
   human-listener validation proves acceptable false-quiet rates. With that
   switch off, promising candidates end as `needs_review`; this milestone
   does not silently publish them.
4. On a trusted isolated analyzer host, install pinned
   `scripts/soundtracks/profile-requirements.txt`, CPU Torch and FFmpeg
   as specified by `.github/workflows/profile-music.yml`. Inspect the
   dedicated secrets and feed; then explicitly set
   `COVE_MUSIC_ANALYSIS_RUNNER_ENABLED=1`,
   `COVE_MUSIC_ANALYSIS_TOKEN` and run:

   ```sh
   python scripts/music-supply/analyze-qualifying-masters.py --execute --semantic-model --max-tracks=4 --max-minutes=20
   ```

   Without `--execute` the runner is dry and does not request a lease.
5. Inspect `GET /v1/analysis/status` with the isolated operator token,
   verify exact R2 receipts, compare measured quiet decisions with independent
   listener judgments, and test contract/master revocation before approving
   larger batches. Never interpret CLAP similarities as calibrated confidence
   or as rights evidence.

## Required next engineering steps

This is the **first**, not the final, scaling milestone. Before continuous
autonomous intake, add a versioned human music-review approval route with
independent credentials; a validated holdout set (see
`docs/QUIET_READING_BLIND_EVAL_PROTOCOL.md`); optional Queue wakeups backed
by these durable leases; isolated autoscaled FFmpeg/model consumers; supplier
source rate limits and acquisition agreements; telemetry for decode throughput,
cost, retry age and release yield; and a certified canonical audio/R2 publisher
with live territory rights and revoked-master cancellation.

The existing supplier handoff currently delivers metadata only. This change
**does not** make a qualified master publicly playable and does not backfill
or relabel existing QA records. Before any production cutover, execute the
strict background OFF/ON/OFF commercial performance campaign without relaxing
Cove's cold/concurrency/100-RPS/mobile-LCP/rights gates.
