# Quiet reading inventory — measured supply and manual curation

**State:** release-gated staff-only reporting. This is not a music
licensing mechanism and does not create any new customer-playable media.

Staff with `soundtracks.review` permission can call
`GET /api/fore/admin/soundtracks/quiet-inventory?territory=US` (the
backend router passes `/admin/soundtracks/quiet-inventory` internally).
The existing staff-service authorization and audit controls apply;
unauthenticated requests must never access this report.

## What is counted

- **Playable Commons recording:** `status='ready'`, QA passed, both private
  media `storage_key` and immutable review `source_snapshot_key`
  populated, plus an allowed territory. This does not include separate
  external-provider recordings; the report explicitly says `commons_only`.
- **Strict measured-signal screen:** playable, `has_vocals=0`, analyzed
  `music_profiles`, measured signal energy at or below **0.5**.
- **Broader reading-distraction screen:** playable instrumental, analyzed
  signal energy at or below **0.6**, computed distraction at or below
  **0.4**. These independent screens need not be subsets of each other.
- **Duration:** summed QA-measured `durationSeconds` from immutable
  playback QA summaries; round to one decimal minute.
- **Editorial queue:** QA-passed but still `pending_review`, including
  a separately labeled group with no triage hold. Only staff can advance
  dossier, composition/master/performance rights, second-review and
  quality gates under the existing soundtrack moderation workflow.

The acoustic screens are heuristics, not human-approved quiet-listening
certifications. Measured DSP signal energy is distinct from human-tagged
catalog energy. Neither this endpoint nor its tests set rights status,
recording storage, publication flags, source snapshot or market allowances.

## Read-only production observation (October 20, 2026)

Under the existing verified Commons rights and storage definition for
**US**, 206 recordings / 882.1 minutes / 56 composers are playable;
6 recordings / 18.7 minutes pass the strict signal-energy screen and
19 recordings / 66.8 minutes pass the broader reading-distraction screen.
These are not yet independently user-listened / focus-certified.

The discovery pool includes **1,813 pending** candidate masters, of
which 13 have passed measured QA and 12 are both QA-passed and untriaged.
About 1,786 have triage hold explanations. Hold removal requires
source evidence and responsible review; never auto-approve.

These numbers are point-in-time descriptive measurements, not SLOs or
license assurances. Re-query before launch; count external-provider
media separately to avoid understating or double-counting the library.

## Release checks

1. Test permissioned and unauthorized API access, including service
   scopes, invalid territory, forged geographic headers and user roles.
2. Confirm the DB query on the production-shaped schema uses bounded
   table scans; never run it on anonymous/storefront requests.
3. Validate accurate R2 object presence for a representative set and
   redrive on withdrawn/missing assets; current queries verify stored
   pointers, not a fresh private R2 `HEAD` for every item.
4. Have licensed reviewers assess actual performances, compositions,
   attribution/ShareAlike requirements, exact origin revision, territory,
   loudness, distraction and playlist suitability before advancing
   public approvals.
5. Compare customer discovery and audio TTFB under mixed load with the
   feature on/off. Do not merge solely based on green static CI.

Release state: **DRAFT**. Production public music routing and grants remain
unchanged.
