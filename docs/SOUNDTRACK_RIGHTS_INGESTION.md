# Cove Soundtracks: recording-rights ingestion runbook

## Verified operational findings — 15 October 2026
The original first release made zero progress: Cloudflare's Fetch runtime rejects
`redirect: "error"`. Commons exposes playable Ogg files as
`application/ogg`, frequently appends UTM parameters to its upload URLs,
and commonly uses CC0 deed URLs ending in `/deed.en`. The corrected importer
canonicalizes verified Commons metadata and allows the platform-supported
`redirect: "manual"` (still never following redirects). It also rotates source
periods, capturing a capped pool of 250 unique candidates in 50-file API batches,
at least eight minutes apart. These are not recorded as approved music.

The unmodified source recordings under CC BY-SA 2.0–4.0 (and applicable 2.5)
can be candidates for commercial redistribution, subject to full license
conditions, copyright review, attribution, and share-alike/no-additional-
restrictions compliance. The review must document these conditions for that
individual track. Do not mark an audio file as a derivative or add license
restrictions that conflict with the underlying share-alike terms.

A Commons `Public domain` label, including ones attached to US Government
performances, is only a **claim** until rights in score, arrangement, recording,
performers and source jurisdictions have been independently established.

### Individual research example (candidate; not final approval)
Source: [Albéniz — Rondeña from Iberia, performed by La Pianista](https://commons.wikimedia.org/wiki/File:Alb%C3%A9niz_-_Ronde%C3%B1a_from_Iberia.ogg)

- The file page identifies composer Isaac Albéniz (1860–1909), work composed
  1905–1909, performance by La Pianista in 2014, and uploader-made original
  recording under explicit CC0 dedication. The page provides a visible author/
  performer statement, file history, media checksum and CC0 dedication.
- The published composition is historically well outside the US public-domain
  expiry window; no new arrangement is claimed on the file page.
- The performer or creator uses the Commons upload account and affirmatively
  declares being the rights holder; the original recording and page source
  should be verified against its upload history and any contrary claim before
  assigning the territories. No attribution is legally mandated by CC0, but
  Cove should still credit the musician accurately.
- **Disposition at research stage: strong CC0 candidate, pending documented
  reviewer attestation and exact-file import.** This note alone is not a
  completed rights clearance.

### Rights audit
Every authenticated approve, reject, revoke and retry action is written to
`soundtrack_rights_decisions`, including the responsible service principal,
source checksum and the submitted rights evidence. This is a decision history,
not a substitute for the original evidence. On takedown Cove revokes the
database entitlement **before** removing the R2 object; inaccessible R2 should
never delay an immediate distribution halt.

## What gets imported
The Worker discovers up to 250 **metadata candidates** from selected Wikimedia Commons classical-music audio categories. Discovery is rate-limited to one 50-file metadata page per ten-minute maintenance window. Candidates claiming CC0, CC BY, CC BY-SA (supported versions), or a Commons public-domain claim may be staged, but they are never automatically approved, copied to R2 or publicly played. NC, ND, SA, unknown licenses, files over 25 MB, and unsupported audio types are excluded. Commons license metadata is not independent proof of recording rights.

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
