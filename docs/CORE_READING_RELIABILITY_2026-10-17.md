# Core reading reliability release — 2026-10-17 UTC

## Reproduced problems and changes

- The service worker persisted navigated HTML, including potentially personalized documents. It could reopen a document offline without having every reader chunk. A separate, versioned public offline reader now has a complete build manifest. Installation fails atomically if an asset fails. Navigation HTML and all API responses are excluded from caches. Older shell caches are retired; hashed public code caching is bounded. A saved EPUB requires a prepared offline shell before reporting success.
- Public reader startup awaited account loading, audio lookup and whole-book TOC fragment resolution. Guest public text now opens independently of stalled account/audio calls. Returning readers still restore account state before autosaving; exact-edition BioSync deep links retain their required matching semantics. Ordinary BioSync positions load locally first; optional remote sync and TOC fragment mapping run after text is displayed. Navigating away cancels the EPUB transfer.
- On-demand US EPUB delivery checked only ZIP magic bytes and did not update completed-storage evidence. It now applies the archive/package/spine/chapter validator, records a checksum and storage state, and repairs a corrupt cached public US file through its permitted source. Imported, publisher-controlled and regional editions are never replaced from another source.
- The validator now parses each spine chapter, catching malformed content before publication or delivery. Byte downloads have a size limit and deadline. Known terminal unavailable editions omit the EPUB format and their book-detail reading action; on-demand editions disclose their source-download status.
- The live retail rights view materialized every grant even for a single product. Migration 0070 preserves the rules and specializes the retail channel, allowing indexed product-scoped grant checks. Contract/language/date/territory/deny/DRM checks remain live. Stable popularity and grant-lookup indexes support browsing.

## Production evidence before release

At the audit snapshot: 6,686 completed storage records, 38,727 pending, 318 retry and 1,271 failed. These are records, not a physical verification of every object. Of the failures, 1,169 were copyright/permission exceptions and 13 were regional licence/branding holds; these remain quarantined. There were 53 oversized files and 36 missing-source responses. No rights hold was lifted and no oversized source was silently truncated.

A subsequent physical inventory compared all 6,705 then-completed records against the EPUB object listing: none were missing. The listing contained 6,712 objects; no empty objects were found in the preceding inventory. Six real public books (1342, 84, 24923, 21609, 166 and 11666) returned HTTP 200 and passed archive/package/spine chapter parsing. Object presence is distinct from full content validation of every stored book.

An equivalent, read-only production lookup for Gutenberg 1342 changed from 183,532 rows / 212.8 ms to 10 rows / 2.2 ms with the specialized retail query. This is a query probe, not a whole-site performance claim.

The initial HTTP probes include this execution environment’s network/proxy path. First-observed/repeat measurements are not guaranteed empty-cache tests and are not field Core Web Vitals. The homepage’s server render spent about 5.2 seconds at its bootstrap deadline. First-observed bootstrap phase diagnostics reported about 10.6 seconds in catalog work. The original measurements are in `CORE_READING_BASELINE_2026-10-17.json`.

## Verification and release gates

- Migrated-database integration exercises real book endpoints, valid/malformed chapter payloads, stored-object corruption and repair, unavailable metadata, and set equality between generic and specialized retail eligibility.
- Service-worker behavior tests verify a complete install, partial-install rejection, old private-cache retirement, document non-persistence and safe offline fallback.
- Browser/device tests save a real EPUB, close the page, disable networking, open a fresh reader page, render book text, reopen the offline app and reconnect. A separate case stalls account/audio requests while requiring public book text to display.
- During offline browser tests, the isolated QA origin also refuses application connections. Playwright's own Firefox service-worker policy test documents that its offline emulation does not reach worker fetches; origin refusal exercises the actual network-failure fallback without skipping the browser check.
- Existing rights/contracts, source isolation, offline authorization, reader restoration, search/cache, bootstrap and notification checks remain gates. TypeScript, lint, builds, six browser/device configurations and native NVDA gate release.
- Post-deployment measurements and sample public EPUB retrieval must be recorded before claiming verified production results.

## Boundaries

This release does not instantly download the pending catalog or override quarantines. Offline access requires a completed save and available browser storage; browser eviction, cleared site data and private-mode limitations remain real. A fresh-page standalone-mode browser exercise is an automated installed-app proxy, not a human OS installation certification. Performance measurements here must retain their environment and sampling limits.
