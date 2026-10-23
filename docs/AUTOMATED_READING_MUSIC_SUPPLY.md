# Automated reading music — suitability, supply and storefront isolation

**Status:** code-only pilot. Do not enable new production music discovery, approvals,
work queues or customer routing based solely on this change.

## Baseline (production read-only, 2026-10-23)

- 206 ready Commons recordings, zero ready external-provider recordings.
- 1,827 pending rights-review discoveries; 1,800 have explicit triage holds.
- 1,790 recordings have pending source-audio QA, 231 QA-passed in all statuses.
- 212 analyzed music profiles; stored measurements cover whole waveform but
  model semantics are sampled (CLAP scores are **not** calibrated probabilities).

The supply bottleneck is rights and audio QA throughput, not category crawling.
In particular, triage-held records cannot be bulk published by flipping a flag.

## Acoustic suitability (not rights adjudication)

`quiet-reading-score.ts` implements policy `cove-quiet-reading-v2` on existing
validated, full-duration music reports. It combines signal energy, within-track
loudness variation, abrupt transitions, onset density, climaxes, spectral
flatness, tonal entropy and low-weight sampled arousal. Likely vocals,
sustained climaxes, strong transients, extreme energy and peak clipping veto
a quiet recommendation; missing vocal information becomes
`needs_vocal_evidence`, **not** a quiet pass. Semantic vocal evidence is used
only when at least three windows / 20 analyzed seconds are present.

The result is a deterministic, versioned screening label, not a calibrated
probability or proven predictor of human focus. It is serialized as
`music_profiles.profile_json.quietReading` during normal, already-authorized
music-profile completion. Old profiles remain readable; nothing triggers a
retroactive mass backfill. Full signal QA still precedes analysis. Public
music playback still requires the original rights, territory and R2 checks.

Before asserting high accuracy or making acoustic scores the default:
1. Assemble genre-, era-, recording-quality- and instrumentation-stratified
   blind human listening labels on a few hundred tracks, including poor fits.
2. Train/calibrate the weights on one split, then report *precision of quiet
   recommendations*, recall, and false-quiet rates on a sequestered holdout,
   broken down by vocals, dynamic range and source. Require at least 95%
   precision and audit subgroup errors before automatic recommendation.
3. Run an opt-in A/B evaluation of skip rate, interruption, volume changes,
   replay and reading-session completion. Listening behavior is feedback,
   not proof of rights or the reader's ability to concentrate.
4. Version every policy revision, isolate re-analysis jobs and allow a
   one-flag fallback to the current score.

## Commercial-grade supply expansion, without primary-D1 contention

**Acquisition**: contract/licensed delivery feeds and original creators first;
verified CC0/CC BY/CC BY-SA individual masters next. Public-domain *scores*
do not establish public-domain *recordings*. No NC or unclear commercial
streaming rights. Every recording requires immutable page/contract snapshot,
master checksum, region, performer, composition/arrangement and attribution
lineage. Explicit source-license reliance can reduce legal review to
source-policy auditing where contract/policy and evidence are machine-readable;
exceptions and ambiguous chains still require rights expertise.

**Parallel content plane**: receive candidates and fetch original bytes through
a dedicated bounded content Worker, put immutable masters and per-source rights
evidence into private R2, queue QA, fingerprints and audio-text analysis on
separate D1/Queues. Detect duplicates by master SHA-256 and acoustic fingerprint,
not title. Track exact per-source quotas and provenance. Non-customer jobs
must not write or list large batches in primary D1. Final publication is
a tiny, idempotent, canonical rights-checked projection. Recheck upstream
revocation and revoke rapidly.

**Scaling target**: plan for many thousands of unique cleared recordings and
thousands of hours, not one track per book. Start with a 1,000-master cohort,
then aim for 5,000+ if rights-cleared supply and operational tests justify it.
Measure unique **performances**, distinct composers/performers, hours by
quietness, market, era, instruments, tempo/dynamics and audiobook matching
needs. These are targets, not current inventory.

**Programming**: `reading-music-program.ts` composes deterministic session
programs from an *already authorized and precomputed* catalog, using affinity,
low recent play count, composer concentration limits and strict master dedupe.
The caller supplies listening history and a session seed. Never query shared
production D1 per listener for this operation. The module is not yet wired
to customer playlist delivery; do so only through an isolated, signed,
periodically refreshed R2/KV read model after the publisher is certified.

## Non-regression and release gates

No production secrets, flags, routes, worker triggers, upstream rights grants
or existing soundtrack statuses change in this PR. CI runs the original
soundtrack/music-profile regression tests and the new scoring/diversity tests.

Any later ingestion deployment needs a same-revision background-OFF/ON/OFF
campaign, simultaneous actual checkout / territorial-deny / protected EPUB /
audio streaming, repeated 1/4/8/16/32 concurrency, two 12,000/12,000 100-RPS
phases with no drops, p95 <600ms, p99 <750ms, absolute max <800ms, cold and
multiple geographies, mobile LCP parity, R2 integrity, rights revocation and
rollback. Do not enable background work if those strict gates regress.
