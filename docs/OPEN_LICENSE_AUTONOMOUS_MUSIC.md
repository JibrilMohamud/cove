# Hands-off open-license music supply (Commons first)

Owner policy: **no suppliers or negotiated contracts are needed** for
genuinely open-licensed recordings. The exact original Commons file is the
unit of copyright reliance, audio QA, evidence, attribution and revocation.
Not all classical music recordings are public domain; a public-domain score
does not clear a modern performance or sound recording.

## Working autonomous fast lane (existing customer catalog)

- The existing hourly `curate-source-license.py` runner checks Commons CC0,
  CC BY and CC BY-SA exact-recording declarations and screens conflicts;
  it downloads the original from `upload.wikimedia.org`, verifies the
  Commons SHA-1 and complete byte length, measures it with isolated runner
  FFmpeg and sends a versioned measured QA, rights dossier and source-license
  reliance review to Cove's restricted review API. The publisher re-fetches
  the exact Commons page, snapshots its permanent revision to private R2,
  prevents duplicate approved SHA-1s, and checks territory rights and
  immediate revocation. The returned status is not a claim of human review.
- This PR adds a bounded (12 Commons metadata calls per reconsideration run)
  **exact-source structured credit recovery lane** for previously held
  recordings. Before replacing ambiguous composer/performer information,
  it checks the exact original source file SHA-1/size and commercial CC
  license, rejects NC/ND and FMA/Musopen provenance conflicts, requires an
  explicitly labeled composer/performer and prohibits previously unknown
  composer rights without established historical identity. Independent
  contradictory name credits remain held.
- `metadataEvidence` optionally snapshots metadata policy, source page
  revision, original SHA-1, license, recognized composer/performer and
  evidence digest into the review dossier. The existing canonical
  version-fenced source snapshot and live rights recheck remain mandatory.
- Existing periodic model profiling runs in separate GitHub compute hosts;
  FFmpeg and CLAP do **not** execute inside customer request Workers.
  Their writeback still uses the existing primary catalog review service.
  The parallel detached MUSIC_DB/R2 qualification execution layer from
  #284/#285 is implemented but remains off until its private ingress,
  open-license source policy, and signed canonical handoff are certified.

## Independent Openverse discovery

`discover-openverse-commons.py` uses Openverse's **documented audio search
API**, not website scraping. It rotates 24 instrumental search terms,
asks for just one results page per query, and validates only a small bounded
set (default two searches, at most 12) with Wikimedia Commons' own file API.
Openverse's indexed license is never publication authority. The exact
Commons file must disclose CC0/CC BY/CC BY-SA, unchanged source checksum,
original media location, legal attribution metadata and a lack of
contradictory rights evidence.

A dedicated `music_open_source_candidates` table and discovery-runs ledger
in the separate music QA database store **discovery-only** records.
Duplicate candidate ids are idempotent; contradictory future source hashes
or licenses become permanently held. There is no supplier agreement, audio
copy, approval, outbox event, customer entitlement, or production D1 write.
Production main runs a small discovery campaign daily and after the rollout;
PRs only run no-network tests. Repository-secret access occurs only for
trusted main, never an untrusted pull request. The scanner follows API rate
limits and has a meaningful User-Agent and no redirects.

## Daily operations and scaling

`report-isolated-supply.py` records rolling 24h intake/FFmpeg/model stage
counts, bytes, processing time, backlog, exception reviews, isolated
candidate totals, and **known** processing costs. Null/unpriced costs are
never counted as zero. The resulting daily JSON artifact is stored in
GitHub Actions. It deliberately does not query customer D1 and never claims
that a discovered candidate became a playable track.

Do not conflate the detached Openverse discovery queue with actual ready
customer music. Track three different measures:

1. Discovered, file-verified, source-license candidate masters.
2. Fully acquired, quality-passed, rights-approved and stored originals
   with current territorial permission.
3. Quiet-reading tracks recommended after blinded evaluation of
   `cove-quiet-reading-v2`, with false-quiet rate and subgroup audits.

The blind human calibration gate remains open: uncalibrated CLAP scores are
not probabilities, and automatic acoustic acceptance must remain OFF.
Exceptions should be sampled for human review rather than imposing
individual manual approvals on every file.

## Security and non-regression gates

No production music supply Worker flags, primary D1 schemas, customer
media delivery policies, routes or payment flows are changed by this PR.
The independent D1 schema 0004 is additive and cannot mark a discovery as
approved. Automated read/write workflows are bounded and protected by
existing scoped Actions credentials, with no private source access on PRs.
The origin-restricted QA Worker is still unpublished; the optional
private Access/service-auth transport needs setup before parallel
source/quality/CLAP workers can work against that Worker.

Do not turn on the detached customer handoff or fully automatic quietness
publication until the no-drop 100-RPS, p95<600ms, p99<750ms and maximum
<800ms, all 1/4/8/16/32 concurrency, cold deployments, mobile LCP,
territory/revocation/checkout QA and OFF→ON→OFF mixed-workload gates pass.
