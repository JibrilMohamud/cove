# Verified 150-recording milestone

As of 2026-10-16 08:16 UTC, Cove publicly listed **155** individual recordings.
All 155 passed the independent audit. Total verified original audio: **862,496,021 bytes**.

- D1 ready-recording set and a complete R2 object listing contained the same 155 originals.
- R2 object keys, sizes and audio MIME types matched the imported recording manifests.
- Public catalog entries carried source attribution and recognized commercial US license declarations; NC and mismatched license links were rejected by the existing probe.
- Every public audio URL returned an accurate HEAD response.
- Every original passed byte-range reads at the beginning, midpoint and end, with exact HTTP 206 and Content-Range values.
- Every complete public download matched its stored byte length and imported SHA-1.
- ffmpeg decoded every complete original audio stream without a decoding error.

This establishes retrievable and decodable original audio for the minimum library,
not merely candidate or database status. It is not a new legal opinion or a claim
that a person listened to every recording. Existing per-recording source/rights and
quality review controls remain authoritative and continue to recheck published masters.

Evidence: `R2_OBJECT_PROOF_2026-10-16.json` and
`PUBLIC_PLAYBACK_PROOF_2026-10-16.json`. The manifest records original-file SHA-1s
for equality checks, not authentication or signature security.

Reproduce the complete public part with ffmpeg installed:

```sh
python3 scripts/soundtracks/verify-complete-library.py \
  --manifest docs/soundtracks/R2_OBJECT_PROOF_2026-10-16.json \
  --output playback-receipt.json
```

Capture a new independently compared D1/R2 manifest when the published set changes.
The audit fails on mismatched snapshot ID sets instead of silently changing its denominator.
The existing rotating six-hour production checks continue to monitor playback after
this complete audit.
