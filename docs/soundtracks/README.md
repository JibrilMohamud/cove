# Cove soundtrack clearance pilot — 15 October 2026

This folder contains evidence, individual research dossiers, and measured audio
reports. It does not replace a rights holder's license or claim a human lawyer
reviewed the catalog. `reviewMethod: ai_assisted` means an AI inspected the source
and prepared the documented assessment. It must never be relabeled as a human
attestation. Open questions stay in `unresolved` and block approval.

## Evidence and review status

- 250 production candidates captured at exact Wikimedia Commons revision IDs.
- All 250 captured source SHA-1 hashes matched the production discovery register.
- 25 individual five-layer research dossiers, with corrected performer credits,
  recording dates, license selection, US territory basis, and distribution notices.
- 25 original files independently downloaded and SHA-1 verified for local QA;
  SHA-256, full decode, duration, channel count, sample rate, integrated LUFS,
  true peak, clipping screen, and silence measured without transcoding originals.
- 22 files passed the conservative audio screening. Three failed true peak:
  `cm_2370219` (+0.3 dBTP), `cm_3308570` (+0.2 dBTP), and
  `cm_654356` (+0.5 dBTP). These original files cannot be approved as measured.
- Open score-publication or performer/arrangement questions remain in seven
  dossiers. Those cannot be approved until resolved; complex provenance needs a
  second independent principal's review of the same dossier and source checksum.
- Musical moods and energy are editorial interpretations from the identified
  works and styles; measured loudness is separate. No human audition is claimed.

`REVIEW_REGISTER.csv` describes all 250 candidates, priorities, immutable source
revision links, evidence checksums, pilot dossiers, reports and outstanding work.
Its research dispositions are not production approval or playback counts.

## Reproduce and operate

Run from the repository root with Python 3, FFmpeg and ffprobe available:

```sh
python scripts/soundtracks/capture-evidence.py
python scripts/soundtracks/measure-audio.py /path/to/original.ogg --output /path/to/report.json
python scripts/soundtracks/build-register.py
```

The capture tool only retrieves source metadata and revisions. The audio tool
only measures a local file; neither grants approval nor uploads music.

Use `/staff/soundtracks` with a verified staff account and `soundtracks.review`
permission. Service integrations need that exact scope; `audio.ingest` no longer
grants rights-review access. Do not put service tokens into browser code.

1. Open the original file and exact revision, inspect all rights layers, and
   save the dossier. Record all unknowns explicitly. Drafts preserve history.
2. Upload the exact-file audio report. A report for a different source checksum
   or size is rejected. Failed thresholds cannot be overridden by approval.
3. Resolve the dossier, preserve the selected license and all credit notices,
   assign only supported territories, and record the actual review method.
4. Obtain an independent endorsement for public-domain recording claims or
   complex provenance. A reviewer cannot endorse their own approval. Endorsements
   bind the dossier digest and source checksum and do not survive dossier changes.
5. Approve a complete recording. Cove rechecks live metadata and archives the
   original source revision in private R2 with a SHA-256 identity. Approval and
   audit history commit atomically with optimistic concurrency control.
6. The bounded maintenance runner copies the unmodified original to R2, validates
   its measured SHA-256 and size, and rechecks source identity/revision. Only then
   does it publish the recording in its approved territories.
7. Verify full and ranged playback, actual credits, license, source link,
   modification notice, and original-file download from `/soundtracks`.

Requests to `/api/fore/admin/soundtracks/recordings/cm_<id>` support `draft`,
`quality`, `endorse`, `approve`, `reject`, `revoke`, and `retry`, with the current
integer `version` in every write. A stale write returns 409. The admin list uses
`after` pagination and exposes `nextCursor`; detail responses include audit history.

Withdrawal immediately removes public authorization. Failed object cleanup is
queued durably and retried by maintenance. Review evidence and immutable decision
history remain preserved. Audio responses use private/no-store caching.

Discovery is capped at 750 metadata candidates, one bounded page per cadence;
this is headroom for rejection and diversity, not a claim of 750 cleared tracks.

## Attribution for archived evidence

Each JSON source snapshot retains the original Commons file page, permanent
revision URL, creator metadata and source license. Structured Commons metadata
is available under CC0; copied Commons description text is available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), with attribution
to the contributors of the linked original revision. JSON encapsulation and the
added capture/hash fields are the changes made by Cove. The recording itself
retains the license specified on its individual file page, which may differ.
No audio is committed to this repository.

## Release criteria still requiring independent evidence

Do not call the 150–300 track target complete until that many unique recordings
have actual approval decisions, passed exact-file QA, verified R2 objects and
working territory-appropriate playback. A 25-file research/QA pilot is not a
25-file cleared library. Independent human listening, music-rights framework
review and human assistive-technology usability checks must be reported as such
only when actually performed. Original-file technical QA does not establish
editorial quality or a completed chapter-soundtrack experience.
