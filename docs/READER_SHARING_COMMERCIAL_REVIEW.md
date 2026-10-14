# Reader sharing and discussion review

This review covers the ten reported reader-sharing defects. Most core corrections
were already present in PR #15; the follow-up hardens concurrency, passage identity,
mobile access, permission changes and recovery around those flows.

| Requirement                                                 | Resulting behavior                                                                                                                                                                                                                                                                                  | Verification                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discussion publication must not inherit viewing preferences | The margin composer has independent audience, member and group choices. Publication requires explicit audience confirmation. Changing a destination resets consent; replies retain the parent discussion's audience.                                                                                | Browser publishes into a second group while viewing preferences remain on the first; API rejects missing confirmation and invalid membership.                                   |
| Sharing needs its own group picker                          | Each sharing dialog selects from the owner's current joined groups. The reader checks fresh profile/group data when opening the composer. Deleted/suspended groups cannot be used through stale membership records.                                                                                 | Browser chooses two distinct groups; API rejects suspended/deleted group writes and hides their margin posts from other members.                                                |
| Saved highlight defaults must be used                       | The composer starts from the saved public/followers/friends/private preference, fetched when opened, and still requires confirmation. A private default never publishes implicitly.                                                                                                                 | Browser sets followers as the default, then opens the composer while viewing group activity.                                                                                    |
| One highlight needs multiple simultaneous audiences         | Migration 0048 stores separate, versioned publications by annotation/audience. Creating another audience preserves existing publications. A create-only version of zero rejects concurrent replacement.                                                                                             | Browser retains two independent group shares and a named-member share; API exercises version-zero collision rejection and per-audience withdrawal.                              |
| Private note edits must not change published copies         | Publications have separate note snapshots. The note editor identifies current sharing, shows the exact copy to publish and lets the owner select audiences. Sharing/republishing requires the private-note version reviewed by the owner; stale source/share versions fail without partial updates. | Browser changes only Bob's published copy while Charlie retains the original; another-device edit causes a conflict, refreshes private data and changes neither published copy. |
| Margin threads need complete controls                       | Shared discussion controls provide paginated replies, reactions, published edits, confirmed deletion and reporting with a selected reason/details. Mutations are disabled while in flight.                                                                                                          | Real EPUB browser flow replies, reacts, edits, confirms deletion and submits a harassment report. API enforces parent audience, ownership and spoiler access.                   |
| Indicators need actual passage positions                    | Keys include the EPUB location, so identical words in different chapters stay separate. Markers use visible CFI range geometry and update on layout/page/resize/scroll/font events rather than a twice-per-second timer.                                                                            | Browser checks marker alignment and disappearance on page turn; API distinguishes identical quotations with different CFIs.                                                     |
| Older conversations must stay reachable                     | Cursor pagination covers all eligible activity and replies. The side panel lists all loaded clusters, gives passage previews and can navigate to a passage. Density limits only visible gutter markers. Older pages cannot replace the newest authorized published note.                            | Database traversals cover older discussion/reader pages; browser appends authorized projections, preserves the newest note and opens an older thread.                           |
| Feed pagination must not omit filtered/tied activity        | Continuation follows the last scanned row, not visible-result count. Timestamp plus ID cursors give stable tie ordering. Invalid limits return 400 instead of a query error.                                                                                                                        | Database regression traverses filtered empty/short pages and identical timestamps without missing activity.                                                                     |
| Particular members need search                              | Discovery supports username/name search and stable pagination, with private-profile and block restrictions; the recipient picker resolves a specific username before sharing.                                                                                                                       | Browser finds one exact username and an empty result; backend checks pagination, blocks and private-profile fields.                                                             |

## Additional integrity and performance changes

- Saved Gutenberg highlights/bookmarks match public, internal and source book
  references, so opening the reader through its public URL preserves saved notes.
  Book access continues to be checked by the backend.
- Note inclusion is a reviewed publication of a specific private-note version.
  Version checks are repeated inside the SQL mutation, not only in a prior read.
  A conflict refreshes the appropriate source and never retries publication silently.
- A margin thread can render the authorized post already supplied by the reader
  snapshot instead of issuing an extra request per root post. Its cache key no
  longer changes with caller progress. Accepted saved progress invalidates relevant
  discussion queries; spoiler eligibility remains authoritative on the server.
- Sharing, reporting and note dialogs scroll inside the viewport, including long
  note previews and multiple audiences. Confirmation controls remain reachable.
- The QA server prepares its initial client dependency graph before readiness.
  This addresses the cold Vite history-module request cancellation found by CI.
  Runtime-error assertions and flaky-test failure remain enabled.

## Validation and rollout

Local Chromium desktop and Android emulation passed all 30 scenarios. Database
checks cover sharing/erasure, authoritative progress, stable pagination and catalog
caching. The Vercel frontend and persistence Worker builds and lint baseline gate
pass; the recovered repository retains its existing TypeScript debt. Current
six-project CI results are linked from PR #15; that matrix must pass before rollout.
Emulation does not establish physical-device behavior or certify the entire app.

This follow-up adds no schema migration. Multi-audience snapshots require migration
0048; recipient-bound journeys require 0049; audio compute admission requires 0050.
Apply all unapplied migrations through the normal deployment workflow, deploy the
persistence Worker, then deploy/promote the frontend and Python service. Old clients
that omit note-version confirmation fail closed and must refresh before publishing
notes. Production and billing improvements must be verified after rollout.
