# Detached Commons original technical QA

This lane handles a **small cohort of audio originals from the independent
`music_open_source_candidates` discovery queue**. It is not a source license
review, supplier contract, automatic quietness approval, or a customer publisher.

## Boundary and admission

- Input: detached MUSIC_DB only, exact candidate id/page/title/Commons SHA-1,
  declared license URL and original size. The authoritative Commons exact-file
  API must return the same current facts **before and after** processing.
- Work: one recording by default, two maximum, one serial runner, bounded time,
  <=25 MiB original, redirect-free HTTPS fetch strictly from
  `upload.wikimedia.org`; full-source SHA-1/SHA-256; FFprobe+FFmpeg complete
  decode/loudness/silence and DSP over the complete signal. CLAP is not run:
  its similarity values require independent human calibration.
- Storage: private, content-addressed R2 under `music-open-qa/` with an
  entire-object SHA-256 read-back. Additive migration
  `infra/music/0006_open_technical_qa.sql` in MUSIC_DB only.
  `music_open_technical_qa` hard-codes both rights and quietness to
  `unreviewed` and has **no customer D1, master approval, entitlement, URL
  issuance or publisher event**. Prior upload without D1 receipt is harmless
  private orphan content and safe to replay.
- Failures: source drift, changed license, bad hashes, decode/report drift,
  storage errors or budget exhaustion never produce a measured receipt.
  Successful source QA is still not proof of underlying composition,
  arrangement, performance or territorial permissions.
- Revocation: authoritative customer delivery continues to use independent
  canonical live rights and deny/tombstone checks. No private QA result may
  bypass those checks. A separate operator deletion/purge is required to
  remove previously staged original R2 bytes if upstream permissions end.

## Activation (off by default)

CI tests the SQL and boundaries on pull requests with no network credentials.
The protected-main schedule now runs four times per day (01:55,
07:55, 13:55 and 19:55 UTC), processing at most **two** unprocessed
Commons originals per run (at most eight attempted originals per
day). Processing is serial, bounded to 840 seconds and a 20-minute
GitHub Actions job, with one global workflow concurrency group.
Success writes only immutable private technical evidence in MUSIC_DB/R2,
then queues unapproved rights and quietness cases. Technical QA does not
claim that a recording has been licensed, qualifies as quiet, or is playable.
Manual workflow dispatch still requires the repository variable
`COVE_MUSIC_OPEN_QA_ENABLED=1`. A one-time, explicitly tagged merge commit
`[one-source-qa]` also authorizes **exactly one** no-publication technical
original on that single `main` push. Scheduled runs are limited to two
and a merge-tagged run is limited to one. Every path uses the protected
`CLOUDFLARE_API_TOKEN` already installed for detached MUSIC_DB and Cloudflare
R2. `COVE_MUSIC_R2_BACKEND=cloudflare_api` transfers original bytes through
Cloudflare's account-authenticated private object API and enforces exact,
content-addressed `music-open-qa/` keys, no redirects and full read-back
integrity. No persistent R2 S3 credentials are needed. This job may only
write technical, permanently unapproved receipts; review Cloudflare API token
privileges before reusing it beyond this bounded cohort. Install migration
0006 **only** in
the detached music database and verify D1 and R2 access are limited to that
environment before enabling. No customer routing, direct R2 access, automatic
playback or publishing feature flags are changed by this lane.

## Further certification before release

Technical QA may produce private original and DSP evidence. To release a
recording: reconcile composer/performer/work provenance and the exact original
license with a human exception path as necessary; independently approve
territorial master, composition, performance and arrangement rights; calibrate
quiet scoring against blinded human reviews; then use the existing separately
fenced canonical signed publication handoff, including source drift,
revocation, retry and refund/entitlement denial checks. Do not conflate
`music_open_technical_qa.status='measured'` with licensed or playable.

## Hands-off progress and exceptional reviews

Each qualified original is listed as `music_open_technical_qa.status='measured'`,
which is **technical-only**. The scheduled runner also executes
`queue-open-review-cases.py` with a separate `COVE_MUSIC_REVIEW_APPLY=1`
control to produce independently audit-friendly, immutable review evidence
cases, one for rights and one for quiet reading. Both remain `needs_review`
without authorizing public access. This is an exception/audit ledger, **not**
a requirement that the owner personally approve every ordinary open-licensed
Commons candidate. The existing source-reliance curator may still accept
fully qualifying original recordings under its own file-specific, legally
bounded policy and source checks.

The daily isolated-music report now distinguishes the still-unprocessed
Commons candidates, complete private original QA results, durable technical
holds, rights cases and quietness cases. Actual measured provider costs cannot
be inferred from GitHub Actions wall time alone: do not display them as zero.

A pre-existing technical receipt is excluded from subsequent scheduled
cohorts; permanent exact-source mismatch/decoder failures are held in the
independent database and are never automatically retried or published.
Transient source/network failures may retry and require operator observability
before increasing throughput beyond the two-original cap.
