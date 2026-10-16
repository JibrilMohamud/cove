# Automatic literary profiles

Cove profiles each active public catalog ebook edition independently. Translations,
abridgments and revised source text have separate product IDs and fingerprints.
The minute Worker cron seeds 50 editions and consumes two bounded jobs. No model
inference runs during a reader or bookstore request.

## What the profile means

Every inferred dimension includes a value, confidence and evidence IDs:

| Dimension | Meaning |
| --- | --- |
| writtenPeriod | When the literary work was written; unknown without evidence |
| publicationPeriod | Publication information present in the supplied edition metadata or description |
| settingPeriod | When story events occur, independently of the book's writing/publication |
| geography | Locations supported by the actual input |
| moods, themes, sensoryAtmosphere, literaryStyle | Multidimensional literary characteristics |
| energy, tension, valence | Narrative movement, suspense and emotional direction |
| musicalAffinity | Suggested instruments, textures and period preferences; an inference, never a rights decision |
| listening | Vocal, energy and unobtrusiveness constraints |

Music context separately records composition dates, recording dates, reconstruction
status and evoked eras. Unknown dates remain null. A modern lyre reconstruction can
suit an ancient story; its recording year cannot count as an ancient composition.
Original-recording license, attribution, QA and territory gates still apply.

## Evidence and analysis

1. A keyset sweep fingerprints catalog title, description, language, subjects,
   authors, supplementary evidence, the current EPUB asset/hash, model and policy.
   It creates an explicit provisional profile and durable preparation job.
2. Preparation snapshots the supplied metadata/description in private R2. Only
   approved public-domain Gutenberg text is automatically opened for analysis.
   Licensed titles use metadata or staff-supplied authorized excerpts/reviews;
   purchase access alone does not authorize sending their full text to a model.
3. Validated cached EPUBs are read in spine order. Scripts, styles, navigation and
   non-linear resources are excluded. Text is split into 8,000-character sections
   with offsets so later dramatic scenes are not dropped by beginning-only sampling.
4. A schema-constrained Cloudflare model analyzes the book overview and each text
   section. Runtime Zod validation rejects bad types and unknown evidence IDs.
   Book content is untrusted input, never instructions. Dates require explicit
   temporal evidence and cannot be copied from publication into story chronology.
5. Supported chapter dimensions override the overview for that spine request.
   A completed-section aggregate enriches the whole-book profile. The chapter API
   exposes the emotional arc without outputting plot summaries or source excerpts.
6. Playlist ranking combines mood (40%), energy (30%), instruments (20%) and musical
   period preferences (10%), weighted by confidence. Explicit historical mode may
   add a small composition-date overlap bonus. Recording date has zero era weight.
   Unknown vocal content is excluded when instrumental listening is required.
   Unsupported provisional profiles return no invented playlist.

The confidence ceilings are metadata 0.35, description/review 0.60, excerpt 0.70,
and full-text section 0.90. They are policy ceilings, **not calibrated probabilities**.
Each claim is capped by its cited evidence, not merely by the richest input in the
request. Editorial assessment and a labeled evaluation corpus are still needed to
measure literary accuracy. This release does not claim that model inference is
human editorial approval.

## APIs

| Route | Behavior |
| --- | --- |
| `GET /api/fore/books/:ref/literary-profile` | Current edition profile, evidence descriptors, revision and actual coverage |
| `GET /api/fore/books/:ref/literary-profile?spine=N` | Profile for a particular EPUB spine section, with explicit book fallback |
| `GET /api/fore/books/:ref/literary-profile/chapters` | Ordered text chunks with href, offsets and individual profiles |
| `GET /api/fore/books/:ref/literary-profile/playlist?spine=N` | Up to 20 currently rights-cleared recordings with scores, reasons and full attribution |
| `GET /api/fore/admin/literary-profiles/status` | Profile/job counts, daily work budget and sweep position |
| `POST /api/fore/admin/literary-profiles/run` | One bounded tick; JSON body `{}` |
| `POST /api/fore/admin/literary-profiles/sources` | Supply or withdraw up to three authorized description/excerpt/review sources |
| `POST /api/fore/admin/literary-profiles/music-context` | Supply evidence-backed independent music composition/recording dates and reconstruction metadata |

Admin routes require an existing MFA-authorized `storefront.manage` staff session
or a service credential scoped to `literary.profiles.manage`. Source intake requires
an HTTPS locator and an explicit permission basis, never provider scraping. A source
change immediately withdraws the prior active profile and queues reanalysis. Profiles
and playlists honor the edition's current storefront rights. Private imports are not
included in catalog sweeps.

EPUB spine items are the reader's actual addressable sections, not a guarantee that
an arbitrarily formatted EPUB has one literary chapter per document. Multiple chunks
within a spine are exposed separately; readers can use offsets for finer transitions.
Chapter transitions are opt-in API recommendations. This release does not implement
autoplay or community voting/canonical editorial playlists.

## Limits, operations and million-title growth

Initial production work is deliberately bounded. `cove_runtime_config` accepts:

| Key | Default | Meaning |
| --- | --- | --- |
| `literary_enabled` | `1` | Set to `0` to pause the automatic pipeline |
| `literary_jobs_per_tick` | `2` | 0–4 jobs per minute tick |
| `literary_daily_units` | `2000000` | Maximum reserved prompt + generated-output character work per UTC day; 0 pauses inference |

These units are a conservative work limit, not provider tokens, dollars or a billing
cap. Failed model calls retain reservations. Daily budget exhaustion defers work to
next UTC midnight without using up failure retries. Five attempts, exponential
backoff, expiring claim tokens and fingerprint guards prevent endless failures,
duplicate publication and stale model results. Book overview/preparation and chapter
jobs share capacity so deep books do not indefinitely block catalog overviews.
Preparation renews its claim; all evidence is content-pinned. Book model outputs
have append-only revision records; section outputs remain tied to their immutable
source fingerprint. No unknown fact is filled merely to make a profile appear rich.

Extraction is capped at a 16 MiB EPUB, validated 60 MiB expanded archive, 4 MiB per
XHTML file, 1.5 million text characters and 256 chunks. Unsupported/oversize text
falls back to metadata. Truncation, missing chapter output and pending analysis are
visible in coverage; incomplete books are never represented as fully analyzed.
Failed work is visible in staff job counts.

A million titles is an architecture target, **not a completed or load-tested corpus**.
Every active ebook gets a profile automatically as the sweep reaches it; rich analysis
is asynchronous and depends on usable source evidence and the inference allowance.
At 50 titles/minute, an initial million-title enumeration takes about 13.9 days before
retries; inference/deep chapters take longer and must be capacity-planned separately.
Production currently uses one D1 database. Millions of rich chapter profiles require
sharding by stable product hash and moving bulky profile/revision JSON to R2 before
hitting database capacity. The existing product+fingerprint job identity allows
multiple bounded consumers; provisioning shards, routing them, raising budgets and
benchmarking them are future capacity changes, not claims made by this release.

Validation: `npm run test:literary-profiles` runs a real local SQLite/R2 flow from
EPUB extraction through mocked inference and the public profile. It covers chapter
energy, unknown evidence rejection, confidence limits, independent chronologies,
modern reconstruction eligibility, concurrent claims, source invalidation and budget
deferral. `docs/LITERARY_MODEL_SMOKE_2026-10-16.json` captures a real schema-constrained
Cloudflare response; runtime validation applies before publication.
