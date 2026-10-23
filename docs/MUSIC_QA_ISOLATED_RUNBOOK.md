# Staging-isolated, full-decode music QA

**Status:** opt-in / staging only. There are no new customer routes, automatic
licensing grants, published recordings or production cron jobs.

## Actual gap (Oct 23 read-only audit)

In production, 1,790 discovered Commons recordings have `quality_status=pending`.
This runner can prove the exact Wikimedia Commons audio master has the stored
source SHA-1 and byte size, fully decode audio, calculate integrated LUFS and
true peak using FFmpeg's loudnorm analyzer, and stream full PCM to measure
clipping/silent half-second windows. The output uses Cove's existing
`soundtrackQualitySchema` fields. Its playback gate is **unchanged**:
only separately rights-reviewed, commercially licensed, R2-stored,
territory-allowed master recordings may become public.

## Usage

GitHub Actions -> `music-qa-isolated` -> Run workflow, providing a genuine
QA/staging HTTPS origin (hostname must contain a `qa` or `staging` segment).
Configure **dedicated staging only** secret
`COVE_MUSIC_QA_STAGING_SERVICE_TOKEN` with the required existing
`soundtracks.review` service scope; never use a production or general-admin
credential. Dry-run is the default. To perform the small QA *quality only*
writes, explicitly set `commit_quality_results=true` and
`COVE_MUSIC_QA_STAGING_WRITES_ENABLED=1` GitHub Actions staging secret.
Without both controls the runner refuses writes.

The operator job scans at most 8 untouched, untriaged candidates and refuses
untrusted media URLs, redirects, oversized assets, source hash changes, audio
decode failure, malformed audio, and invalid payloads. New source evidence
never implies license permission, commercial recording rights, composition
rights, editorial quietness or market authority.

For the real scale-out, move discovery and QA leases into a physically
independent content D1/Queues domain before continuously operating workers.
Use immutable R2 source checksums, signed source-license catalog attestation
and bounded final canonical projection; acquire licensable masters through
trusted creators/contractual catalogs or verified individual CC masters.
A common-domain/public-score claim cannot authenticate a specific
performance/master license. Run right-change cancellation, R2 integrity,
audio Range and 100 RPS multi-geo customer testing with background ingest
OFF/ON/OFF before enabling production processing.

The published music count is NOT expected to change merely from this PR:
it removes a measurable verification bottleneck, but provenance/approval
remains independently fail-closed.
