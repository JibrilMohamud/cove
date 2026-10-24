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
Scheduled execution requires a protected-main repository variable
`COVE_MUSIC_OPEN_QA_ENABLED=1`, scoped
`CLOUDFLARE_API_TOKEN` for the detached MUSIC_DB and dedicated private R2
S3 secrets `COVE_MUSIC_R2_ACCESS_KEY_ID` and
`COVE_MUSIC_R2_SECRET_ACCESS_KEY`. Install migration 0006 **only** in
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
