# Source-license curation runner

Cove's Commons metadata crawler and its rights-approved R2 library are distinct.
Discovery does **not** mean a recording is approved, technically verified, or
playable. The source-license curator bridges those steps for a **narrow subset**
of Commons files with explicit individual-recording source declarations.

## Enable it

The GitHub Action at
[Curate source-license soundtracks](../../.github/workflows/curate-soundtrack-source-licenses.yml)
runs four times a day and processes at most eight recordings, 160 MiB and
20 minutes of work per run. It remains **non-operational until**
`COVE_SOUNDTRACK_REVIEW_TOKEN` is set as a GitHub Actions repository secret.

Create a revocable service principal with only `soundtracks.review` scope via
Cove's existing scoped-credential administration, record its owner and rotation
date, and place **only** its credential in that secret. The pilot token was
revoked; do not reuse it. Do not substitute `audio.ingest` or give the
principal general staff or account rights. No credential belongs in source,
workflow artifacts, or browser code.

Before the first production promotion, trigger the workflow manually with
`dry_run=true`, inspect selection and missing license/credit coverage, and
verify that the production Worker and R2 bindings are healthy.

Run locally without modifying production:

```sh
export COVE_SOUNDTRACK_REVIEW_TOKEN="$(cat /secure/scoped-credential)"
python scripts/soundtracks/curate-source-license.py --max-scan 800 --max-tracks 8
```

Pass `--apply` to measure original files and submit the exact-file QA and
dossier without approving. Add `--approve-source-license` to authorize eligible
recordings under the owner's explicit source-declaration reliance policy.
Scheduled runs use both flags when the purpose-scoped secret is present. A
machine review is documented as `source_license`, never `human`.

## Limits and trust gates

- The runner only accepts the exact Commons source file at
  `upload.wikimedia.org/wikipedia/commons/`, with matching stored SHA-1,
  byte size, source page, specific license and canonical license URL. It
  rejects redirects, other media origins, unexpected query strings and
  changed files before writing any audio QA.
- Automated approvals are limited to source titles with a narrow recognized
  historical composer, a **distinct, unambiguous performer credit**, a piano
  source category, and non-derivative metadata. Ambiguous credits, arrangements,
  multiple composers, remixes and unknown/unlicensed files are held.
- Any existing rights dossier, unresolved question, manually reviewed QA,
  withdrawn recording or rejected recording remains untouched. The script
  never relabels old assessments as machine-clearance.
- The complete original audio is decoded using FFmpeg and checked against
  the existing LUFS, true-peak, clipping and silence thresholds. Failures are
  recorded as failed QA, without approval or playback permission.
- Successful automated assessments create five-layer source-reliance dossiers,
  preserve exact license, attribution, source checksums, US-only territory and
  an unchanged-file notice. The backend revalidates source identity, reviewer
  scope and optimistic concurrency before each approval. The existing Worker
  cron then snapshots the exact revision and ingests approved originals to R2.
- Mood, energy, period, composer-from-title and instrument cues are
  **heuristic editorial tags**. They do not establish a human listening review
  or independent legal clearance. Public distribution of a CC BY-SA recording
  must retain its actual license and applicable conditions.
- API error receipts do not include credentials or full server responses.
  Each run scans at most 800 pending items and caps its own work; scheduled
  failures produce a failed Action rather than silently claiming success.

## Verify production release

```sql
SELECT status, quality_status, COUNT(*) AS count
FROM soundtrack_recordings
GROUP BY status, quality_status;
SELECT COUNT(*) AS playable
FROM soundtrack_recordings
WHERE status='ready' AND quality_status='passed' AND storage_key IS NOT NULL;
```

Also test the US public soundtrack listing, original audio byte ranges, source
links, artist credit, license and modification notice. Inspect the machine
principal's append-only review events and verify R2 source snapshots and original
file identity. Approved counts alone are not playable counts.

## Outstanding follow-on work

This runner does **not** yet establish a 150–300-recording library. It cannot
identify every Commons performer's separate master/arrangement rights and does
not perform human auditory/editorial acceptance. Direct Musopen and Free Music
Archive adapters remain to be implemented; a repository's general reputation
is not a blanket license for every recording. The current Commons crawler
has a 750 *lifetime candidate* limit; it must be converted to a bounded
outstanding-work queue with re-crawling before new material can be continuously
discovered over the long term.
