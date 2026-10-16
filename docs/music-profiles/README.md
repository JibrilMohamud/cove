# Recording profiles: measured audio, qualified semantics, separate provenance

The minute Worker sweep enumerates every released Commons and authorized external
recording by keyset, without the public listing's 300-result cap. Each gets a
provisional profile, pinned to its audio hash, catalog attributes, supplied musical
chronology, and policy. Unpublished/revoked/territorially unavailable audio is never
made available by a profile. Changes withdraw a stale public profile immediately;
reprocessing happens asynchronously. New imports join the same sweep automatically.

## Analysis

`profile-audio.py` reads the exact original; the consumer verifies its complete byte
length and SHA-1 before analysis, and publication also checks its SHA-256 and duration
against original QA. Originals are never normalized or transcoded for distribution.

Full decoding and FFmpeg EBU R128 on the original yield duration, integrated LUFS,
true peak, and loudness range. A bounded 16 kHz mono analysis derivative yields RMS
variation, spectral centroid/rolloff/flatness, zero-crossing rate, positive spectral
flux onsets, an optional onset-autocorrelation tempo, pitch-class entropy, rhythmic
activity and an explicitly heuristic energy estimate. Every sample is covered in
five-second (or bounded larger) timeline bins. Relative low/high-volume regions and
low-volume transition candidates are recorded in seconds. They are not musicological
claims about form, cadences, harmonic complexity or emotional climaxes.

Pinned LAION CLAP (`laion/clap-htsat-unfused`, revision
`8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a`) compares actual audio embeddings against
versioned descriptions. Up to eight nonoverlapping ten-second windows span the
beginning, middle and ending. Text embeddings/model weights load once per consumer.
Composer, filename, date, catalog mood and performer are never model inputs. Labels
include wistful/serene/warm/menacing, and nuances such as delicate/fragile, slightly
uncanny, restrained/introspective, or dark/claustrophobic. It estimates instruments,
texture, ensemble scale, acoustic character, vocal presence, valence and arousal.

Cosine similarities and dimension contrasts are **uncalibrated estimates**, not
probabilities or human listening judgments. Weak/ambiguous comparisons abstain;
confidence has a 0.60 ceiling. Vocal presence does not establish lyrics; lyrics stay
unknown. A CLAP sample can miss an unsampled vocal entrance or change of mood. Actual
windows, seconds and semantic coverage fraction are returned. Catalog declarations
remain separately visible and are never silently converted into measurements.
Composition date, recording date, instrument tradition/geography, historical
reliability and historically informed performance require provenance evidence;
waveform analysis cannot establish those facts. Unknown chronology stays unknown.
The historical-reliability field explicitly identifies source declarations.

## APIs and operations

- `GET /api/fore/soundtracks/recordings/:id/profile`: current profile, provenance,
  exact fingerprint, measured signal timeline, model estimates, limitations, and
  reading-suitability estimates. The public recording list includes `profileUrl`.
- `GET /api/fore/admin/music-profiles/status`: profile and job counts.
- `POST /api/fore/admin/music-profiles/seed`: one bounded sweep.
- `POST /api/fore/admin/music-profiles/claim`: exclusive expiring claim for one
  already-published master; no arbitrary URLs or storage keys are accepted.
- `POST /api/fore/admin/music-profiles/complete`: validate exact source, schema,
  complete timeline, semantic sample bounds, policy and live lease before publication.
- `POST /api/fore/admin/music-profiles/fail`: release for delayed retry, at most five
  attempts. Expired fifth attempts become terminal failures visible to operators.

Admin operations require the existing scoped `soundtracks.review` service principal
or a staff reviewer with MFA. The scheduled GitHub Actions `Profile published music
masters` workflow uses the existing review secret, runs two independent bounded
consumers hourly and on relevant main changes, and retains sanitized receipts. Each
consumer handles at most 40 masters/24 minutes, with a maximum 30-minute claim.
Weights are cached. The readiness check waits for backend migration/deployment;
PRs never receive production credentials. A credential-free PR smoke runs the real
pinned model on generated waveform bytes before release.

Full reports live in private R2, with an immutable D1 revision pointer. Published
profiles currently include their bounded timeline JSON in D1 for straightforward
reads. At a materially larger corpus, move those timeline bodies entirely to R2 and
retain an indexed compact D1 summary. A million recordings has not been load tested.
The current two-consumer runner is bounded initial capacity, not a million-recording
throughput claim; its consumer protocol supports more runners without duplicate
claims. Analysis never approves licenses, changes territory, or republishes originals.

## Validation and accuracy work

`npm run test:music-profiles` covers real SQLite/R2 publication, claim exclusivity,
wrong-master rejection, expired/stale claims, immediate source invalidation,
territorial withdrawal, full signal coverage and reading-time policy. Python tests
use generated quiet/loud/quiet audio and test window coverage and URL boundaries.
The real model smoke verifies runtime and output, **not perceptual accuracy**.
A representative, independently listened-to labeled corpus is still required for
calibration and measured agreement (mood, instruments, vocals, distraction and
transition quality). Preserve disagreement/unknowns rather than asserting a measured
accuracy rate without that evaluation.

## Model notices and sources

The selected revision's model card declares Apache-2.0:
https://huggingface.co/laion/clap-htsat-unfused/tree/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a

CLAP architecture and feature APIs:
https://huggingface.co/docs/transformers/v4.57.1/en/model_doc/clap

The weights remain upstream/cached, not redistributed in Cove's source repository.
Model/dependency terms and recording licenses are independent. NC-restricted music
models or recording licenses are not silently substituted.
