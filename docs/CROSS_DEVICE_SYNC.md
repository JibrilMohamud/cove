# Conflict-aware cross-device sync

Cove synchronizes an ordered mutation stream while keeping reader-domain tables authoritative. Every mutable entity has an explicit conflict policy; there is no generic "latest timestamp wins" fallback.

## Synced entities

- reading position
- highlights/notes (`annotation`)
- first-class text bookmarks
- reader settings (per-setting-key optimistic versions)
- commercial audiobook location
- Biosync location
- shelves
- wishlist
- sample position
- per-device download metadata
- device state

## Client identity and cursors

A browser/device generates a random sync client key locally. The server stores only its SHA-256 derived hash and returns a `clientId`. Pulls use the monotonically increasing `sync_mutations.sequence` cursor. Revoking a sync client prevents future writes/pulls by that client identity. Sync-client identity is intentionally separate from the account `devices` table used for offline-license/security registration; an offline-license device can never impersonate a sync client. Device capabilities are stored on the sync client and a client may mutate only its own `device_state`.

## Concurrency

Client mutations include `expectedVersion`. If the current server version differs, Cove records an immutable conflict containing both payloads and returns a conflict instead of overwriting. Resolution can keep the server value, accept the client mutation (including a delete), or submit a merged payload. Accepted/merged resolutions update the underlying domain entity first and then append the resolved sync mutation.

Reader settings use independent versions per key so changing font size on one device does not conflict with an unrelated theme change elsewhere. Reading/sample/audio/Biosync locations use optimistic versions. Highlights and text bookmarks retain tombstones so deletion synchronizes safely.

Shelves and wishlist are projected through the same stream. Shelf domain mutations carry an optimistic `version`, so edit/add/remove/reorder operations fail with HTTP 409 when another device has already changed the shelf. Wishlist entries use product identity plus retained sync tombstones (OR-set semantics), including move-to-cart removals. A conflicting full shelf/wishlist sync mutation is surfaced for resolution rather than silently timestamp-overwriting state.

## Bootstrap / legacy reconciliation

`/sync/bootstrap` returns the current reader state and backfills content-addressed sync projections for existing domain rows. This lets accounts created before unified sync join the mutation stream without losing prior highlights, shelves, playback positions, or registered sync-client state.

## Text bookmarks

`text_bookmarks` are separate from annotations/highlights. They carry CFI, optional label/excerpt, chapter/progress, product/version bindings, a server version and deletion tombstone. Commercial EPUB delivery reconciles bookmark anchors across publication versions: identical EPUB bytes can preserve the CFI exactly; changed bytes create `manual_required` migration evidence and preserve the source-version bookmark instead of guessing a destination CFI.

## Offline/download metadata

Downloaded bytes themselves are not synced through this API. Cove syncs device-scoped metadata (state, asset hash, byte counts and offline-license expiry) so the account can reason about device state without treating another device's local file as present.
