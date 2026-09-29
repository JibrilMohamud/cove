# Cove Social Reading Ecosystem

Cove's social layer is designed around one constraint: **the book remains a book until the reader deliberately asks for social context**. The community product therefore has three layers rather than one overloaded "social" feature: shareable Reading Journeys, optional in-book social reading, and a broader reader/author community.

## Privacy and audience model

Private highlights, notes, bookmarks, reading positions, and settings remain private source records. Publishing a highlight creates a separate `social_annotation_shares` projection. The projection carries an explicit audience (`public`, `followers`, `friends`, or one reading group), a progress anchor, moderation state, and a separate `share_note` consent bit. A private note is never copied into the social projection merely because its highlight is shared.

Readers can make profiles public, follower-visible, or private. Follows can be open, approval-required, or closed. Blocking is symmetric for content discovery; muting is viewer-local. Blocked readers are manageable from the account owner's Community settings so blocks can be reversed without making the blocked profile browseable. Replies on reader profiles obey the profile's reply policy. Social objects never gain broader feed visibility simply because the owner's general activity setting is broader: object visibility is the upper bound.

## Social Reading in the reader

Social Reading is off by default. When enabled, readers choose friends/mutuals, people they follow, a reading group, or public readers, and can independently show discussions, shared highlights, and reactions. Density is a 0–100 preference presented as Quiet/Balanced/Lively.

The server ranks passage clusters and returns at most one, two, or three margin indicators at a time depending on density. It does not paint every public highlight into the book. Opening an indicator reveals the associated passage conversation in a side panel.

Progress anchors are recorded by Cove when an annotation/discussion is made. Shared-highlight spoiler position comes from the stored annotation progress (or trusted server reading state for legacy annotations), not from a caller-supplied percentage. Content past the viewer's progress is withheld/locked. Replies inherit their parent thread's audience, passage, and progress anchor so a reply cannot widen a private/group thread or move a spoiler earlier in the book.

## Reading Journeys

A completion event can generate one immutable-source Reading Journey composed from recorded reading sessions and progress samples. The journey captures elapsed days, session count, read/listen time, ebook/audiobook/Biosync progress samples, biggest day, preferred hour, highlight/note/bookmark counts, and optional rating/review snapshot.

Users can customize visibility, theme, which stats appear, a favorite quote, and a short review. Cove renders square and vertical SVG cards and supports PNG export plus Web Share/clipboard links. Public share tokens are random, rotatable, and revocable. Journey settings use optimistic concurrency.

The intent is reflection, not speed competition: cards show a reading path rather than leaderboards or "fastest reader" ranking.

## Community

Reader profiles support a pinned Top 3 ("The Three"), follower/following counts, current reading visibility, finished-book journeys, reading lists, and full discussions distinct from reviews. Activity feeds are follow-based and cursor-ready. Lists support ranking, notes, likes, saves, comments, and "add all to wishlist".

Reading groups support buddy reads, private groups, and clubs; public/unlisted/private discovery; open/request/invite membership; owners/moderators; current/upcoming/completed books; polls with durable member votes/results; and group discussions. Progress/chapter spoiler modes bind a new group post to the poster's server-side current-book position rather than trusting a client-supplied percentage. Private groups are invite-only. Deletion/ownership transfer and optimistic versions prevent orphaned or stale group state.

Work-page discussions are conversational objects and are deliberately separate from ratings/reviews. Spoiler posts can be manually disclosed even outside in-reader progress gating.

## Authors and creators

Verified publisher-author mappings can publish author updates, announcements, and linked reading lists/books. Human author publishing actions require Cove authentication plus MFA/AAL2 (except trusted host identity). Posts are versioned, editable, removable, auditable, and fan out to followers through a leased retrying job queue rather than a synchronous request loop.

## Integrity, moderation, and lifecycle

Social reports enter Cove's existing community moderation case system. Follow/reaction/post velocity and duplicate-content signals feed `social_integrity_signals` so rating/review-ring and coordinated engagement investigations can share the platform's fraud/moderation tooling without silently deleting speech.

Mutable social resources use optimistic concurrency where stale writes matter. Posts preserve revisions; lists/groups/journeys/profile changes are versioned; soft deletion closes dependent discussion contexts. Social administrative actions write `social_audit_events`. Notification delivery uses Cove's durable notification/outbox system.

Account export includes social state. Account erasure anonymizes authored discussions/audit actors and removes private relationship/list/profile data. An owner cannot erase an account while a live multi-member club would be orphaned; ownership must be transferred first.

## Scale boundaries

Public feed and discussion queries are bounded. Author follower delivery uses batches and expiring leases so crashed workers can be reclaimed and stale workers cannot acknowledge another worker's lease. Notification dedupe keys make follower fan-out idempotent. Social creation/reaction endpoints are rate limited and feed integrity signals into manual review when thresholds are exceeded.

The social layer is built on Cove Work/Edition/Product IDs, entitlements, synchronized reading state, Biosync, moderation, notifications, account privacy, and global storefront infrastructure rather than maintaining a parallel identity or permissions system.
