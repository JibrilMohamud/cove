# Book and chapter matching

`cove-matching-v1` replaces the old catalog-tag playlist ranking. It runs without
an LLM request, uses current audio analyses, and keeps rights checks independent
of model judgments. It is a transparent initial ranker with an operational path
to human-trained ranking; it is not a measured perceptual-accuracy claim.

## Request and response

`GET /api/fore/books/:ref/literary-profile/playlist`

Optional query parameters:

| Parameter        | Default                                                 | Meaning                                                                  |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `spine`          | whole book                                              | EPUB spine section; a missing chapter has explicit book-profile fallback |
| `mode`           | saved preference or `atmosphere`                        | `focus`, `atmosphere`, `immersion`                                       |
| `vocals`         | saved preference or literary listening constraint       | `none`, `limited`, `any`                                                 |
| `progress`       | `0`                                                     | Fraction already read within the selected book/chapter, 0–0.99           |
| `sessionSeconds` | estimated remaining reading time, at most 7,200 seconds | Optional shorter session horizon, 30–7,200 seconds                       |
| `maxTracks`      | `24`                                                    | Bound on sequence length, 1–32                                           |

The response includes policy/model identifiers, a reproducible input fingerprint,
the effective book/chapter scope, scoped reading seconds and uncertainty, retrieval
coverage, exclusion counts, up to 30 scored matches and a separate ordered playlist.
The input fingerprint includes actual literary, section-duration and compact audio
analysis snapshots: ongoing enrichment or a recount invalidates it even if the
underlying book/audio source bytes have not changed.
Each match exposes features, reasons and uncalibrated evidence confidence. Each
playlist entry has original-recording metadata, attribution, license/source/profile
URLs, start/end seconds and a measured transition cost. Original recordings are not
edited, crossfaded or republished by the planner. Playback still uses the existing
live rights/territory/QA-gated audio endpoint.

An EPUB spine is not necessarily a printed chapter. The planner uses the actual
edition's retained section addresses. Chapter duration sums its measured section
seconds even when its literary analysis needs an explicit book-profile fallback.
Whole-book estimates and partial-text lower bounds remain distinguishable. A
lower-bound text count cannot produce a claim that the full book has been planned.

## Retrieval, scoring and sequencing

Migration 0068 materializes compact audio features and mood tags from previously
validated profiles. SQLite triggers maintain them atomically as music profiles
change or become provisional. The compact record includes original SHA-1/SHA-256,
signal/loudness/semantic estimates, actual entry/exit bins and up to eight measured
signal bins across the recording. It does not duplicate the full signal timeline.

Up to 600 indexed profiles are evaluated exhaustively. Larger catalogs use indexed
energy-range and mood retrieval, bounded to 600 candidates; the API identifies this
as a shortlist, not exhaustive catalog coverage. This initial retrieval strategy has
not been load tested on a million recordings. Query-time live catalog eligibility,
territory, QA and exact profile fingerprint are rechecked. A stale materialized row
cannot authorize a match. The public recording list's 300-item cap is not used.

The versioned baseline combines sixteen inspectable features: emotional tone,
atmospheric nuance, energy, tension, valence, instruments, texture, attention demands,
volume stability, semantic sample coverage, vocal declaration, composition/style
context, duration, explicit personal feedback, evidence quality and focus stability.
The semantic basis is an explicit small ontology applied to CLAP-derived mood and
nuance labels. It is not arbitrary-text neural retrieval or an audio-caption model.
Unsupported words do not acquire invented semantics. Composer names never predict
audio character. Recording dates never stand in for composition dates.

Focus reduces intensity and rewards stability; atmosphere gently follows the text;
immersion follows its energy more closely while retaining intensity ceilings. Dense
literary-style declarations lower the ceiling. These are versioned initial policies
to evaluate with readers, not established cognitive-effect measurements.

Instrumental mode requires an explicit non-vocal catalog declaration and rejects
strong contradictory sampled vocal estimates. Sampled absence is not proof of a
vocal-free full recording. Unknown or uncited literary dimensions do not become
facts. Too little literary evidence returns no invented matching playlist.

A deterministic beam search considers at most 80 finalists, 8 partial sequences,
16 expansions per step and 32 tracks. For longer catalogs, finalist retrieval retains
40 global leaders, then samples the remaining reading session at six narrative
checkpoints to recover tracks that are locally strong but weak against the whole-book
average. A final global fill preserves capacity when evidence is insufficient.
The selection is deterministic and never bypasses global rights, territory, QA,
intensity or reader-exclusion checks. It rescores local chapter targets and measured
signal trajectories across candidate playback, penalizes entry/exit discontinuity,
repeated composers and inferred repeated work titles, and forbids repeating the same
SHA-1 under alternate recording IDs. The response reports duration overrun, insufficient
catalog coverage or a track limit. Alignment is an estimate and should be refreshed
from actual reading progress at natural musical boundaries; the backend does not
claim precise scene synchronization or add a reader-player UI in this release.

## Personal preferences and feedback

Verified signed-in accounts can use:

- `GET /api/fore/matching/preferences`
- `PUT /api/fore/matching/preferences` with `{ "mode":"focus", "vocals":"none",
"avoidRecordingIds":[], "preferredInstruments":["piano"], "intensityCeiling":0.5 }`
- `POST /api/fore/matching/feedback` with `{ "productId":"...", "spine":null,
"mode":"atmosphere", "recordingId":"cm_...", "reason":"too_intense" }`
- `DELETE /api/fore/matching/feedback` to clear personal feedback.

Other reasons: `good_fit`, `poor_fit`, `distracting_vocals`, `too_repetitive`.
Personal feedback is pinned to the book, recording, mode and chapter fingerprints.
Poor fits/distracting voices exclude that pair for that reader; other feedback has
a bounded effect. Old source versions do not silently inherit it. Preferences and
feedback are included in account data export and removed during account erasure.
They are not copied into the editorial training dataset. Anonymous GET requests
create no listening-history records. Network actors are hashed for read rate limits.

## Editorial dataset and learned ranking

The following require existing MFA `storefront.manage` staff access or a service
credential with `literary.profiles.manage`:

- `POST /api/fore/admin/matching/evaluations`: independent human pair judgment.
- `GET /api/fore/admin/matching/evaluations?after=0`: 200-row keyset export pages.
- `GET /api/fore/admin/matching/models`: active learned ranker, or null for baseline.
- `POST /api/fore/admin/matching/models`: validate/store an artifact, optionally activate.
- `DELETE /api/fore/admin/matching/models`: atomically fall back to baseline.

Example judgment body:

```json
{
  "productId": "prd_gutenberg_1",
  "spine": null,
  "mode": "atmosphere",
  "a": "cm_123",
  "b": "cm_456",
  "preferred": "a",
  "bookFamily": "canonical-book-work-id",
  "workFamilyA": "canonical-composition-a",
  "workFamilyB": "canonical-composition-b",
  "assessorKind": "human",
  "judgmentId": "00000000-0000-4000-8000-000000000001"
}
```

Judges must read the passage and listen to the recordings. Canonical families must
group alternate editions and performances correctly; unreliable family annotations
cannot establish leakage-free results. Each judgment needs a fresh UUID idempotency key; transport retries reuse that UUID
and cannot inflate the dataset. The API captures current feature vectors and
fingerprints itself. It accepts eligible pairs, rejects private imports from the
global dataset, and keeps editorial judgments immutable. Ties can be recorded but
are excluded from pairwise optimization. Multiple independent listeners and actual
reading/comprehension studies are still needed; a single editor is not consensus.

Combine the complete export pages, ordered by ID, into:

```json
{ "source": "independent_human_judgments", "evaluations": [] }
```

Then run offline:

```sh
node scripts/matching/train-ranker.mjs --input judgments.json --output ranker.json --id editorial_v1
```

The trainer uses projected pairwise logistic optimization over the same sixteen
features, with nonnegative weights and regularization. Families deterministically
divide into training, unseen-book and unseen-composition holdouts; held-out families
cannot enter training. Mixed/joint holdout pairs are unused in this first trainer.
At least 100 training pairs and 20 pairs in each holdout are required. The trained
model must improve unseen-book accuracy by at least two percentage points and not
regress unseen-composition accuracy. These are initial release gates, not statistical
significance or calibration guarantees. Confidence intervals, rater disagreement,
subgroup outcomes and live concentration/comprehension results should inform promotion.

Submit `{ "artifact":<ranker.json contents>, "activate":false }` for review, or
`activate:true` to promote after review. The backend recomputes the canonical dataset
checksum and both holdout metrics against the authoritative immutable export before
accepting it; self-reported metrics alone cannot activate a model. Version IDs and
artifact bodies are immutable, and one model can be active at a time. There is no
automated training or promotion on user engagement. A new policy requires new labels.

No human-trained model ships by default. Regression training uses explicitly synthetic
fixtures and is never reported as real matching accuracy.

## Validation

`npm run test:matching` covers current audio over catalog tags, 360-record retrieval,
a 1,010-index shortlist with 650 revoked nearest neighbors, chapter duration, uncertainty/abstention, emotional arc and progress, measured
transition penalties, duplicate-master avoidance, immediate source/territory/rights
withdrawal, materialized invalidation, private personalization/export/erasure,
held-out family isolation, authoritative artifact verification and rollback.
The existing literary and music suites validate upstream evidence and audio reports.
