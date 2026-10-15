# Cove Soundtracks: recording-rights ingestion runbook

## What gets imported
The Worker discovers up to 250 **metadata candidates** from selected Wikimedia Commons classical-music audio categories. Discovery occurs at most once an hour. Candidates claiming CC0, CC BY 2.0–4.0 or a public-domain mark may be staged, but they are never automatically approved, copied to R2 or publicly played. NC, ND, SA, unknown licenses, files over 25 MB, and unsupported audio types are excluded. Commons license metadata is not independent proof of recording rights.

## Individual review
A qualified rights reviewer obtains the pending candidates with an authenticated GET request to /api/fore/admin/soundtracks?status=pending_review&limit=40. The existing scoped audio.ingest service credential is required and must never be included in browser code.

For each recording the reviewer must:
- Open the original Commons page and inspect the individual version of the sound recording.
- Verify composition, arrangement, performance, performer, master-recording rights and historical dates independently of the Commons tag.
- Document allowed territories. A public-domain composition does not imply public-domain recording rights.
- Confirm attribution, actual music metadata and the applicable license version.
- Preserve a dated rights-review note including the evidence sources, and verify performer and composer identity.

Submit POST /api/fore/admin/soundtracks/recordings/cm_<pageid> with an authenticated JSON body containing these properties: action: approve, reviewer: a traceable ticket ID, reviewEvidence: at least 80 characters of detailed evidence, compositionRightsConfirmed: true, performanceRightsConfirmed: true, attributionReviewed: true, territories: an array such as ["US"], composer, performer, period, instruments: an array, moods: an array, energy: 0..1, hasVocals: boolean. Wildcard territory "*" is only appropriate when rights have been established worldwide.

The server re-fetches Commons file metadata and invalidates approval if license, URL, SHA-1, size or MIME has changed. On the 10-minute schedule, only approved recordings may be downloaded, directly to private R2; SHA-1 is verified on upload and the object size is verified before publication.

## Lifecycle and takedown
pending_review: discovered; no file or public visibility.
approved: reviewed by a person; queued for storage.
importing: exclusive ingestion in progress.
ready: recorded review, checksum-matched R2 file, public only in approved territories.
import_failed: requires investigation or an explicit retry.
rejected: excluded by reviewer.
revoked: file removed from R2 and withdrawn from public delivery.

Reviewers may submit reject, revoke, or retry actions on the same endpoint. Rights challenges should trigger prompt revocation and escalation. Review evidence and source provenance remain preserved on the D1 row.

## Public use
The /soundtracks page displays composer and performer, source link, license text/link, credit, and corrected musical tags alongside an opt-in audio player. Public APIs only return ready tracks for the active rights territory. Byte-range audio streams are served from private R2 rather than hotlinked to Wikimedia Commons.

To audit the rollout, query SELECT status,COUNT(*) FROM soundtrack_recordings GROUP BY status; and verify R2 objects for ready rows. A pool of 250 staged candidates is NOT 250 rights-cleared songs. Initially the ready count is expected to be zero until individual independent reviews and imports complete.
