# Reader, sharing withdrawal, and offline media hardening

This change addresses website audit items 1–5. Other audit findings remain separate work.

## Rendering

Reader preview mode and Community subviews read the TanStack router's search string. They no longer read browser globals during rendering. The regression suite server-renders the actual components under a memory router, including sample, profile, journey, club and list URLs, without a browser environment.

## Withdrawing highlights and notes

Migration 0046 makes withdrawal part of the database write. Soft-deleting an annotation removes its share and scrubs all shared-highlight feed payloads. Removing or changing a share also retires the earlier feed copies. Triggers reject new shares for deleted or foreign annotations and repair older orphaned shares/feed copies.

Margin queries exclude tombstones and mismatched annotation owners. Feed reads require a current live share, apply its current audience and the current profile/activity privacy, and return a live quote projection rather than the historical payload. An owner may idempotently unshare an already deleted annotation. A new share has a fresh event identity, including within the same minute.

Open reader panels derive their content from current query results. Reader/feed views revalidate every 30 seconds while open; paginated feeds refresh their loaded pages. Previously viewed/exported content cannot be recalled, but subsequent server reads and background refreshes withdraw it.

## Licensed offline audio

Issuance requires an authenticated account, an active purchase entitlement, an active registered device, and an offline-eligible recording. A signed P-256/SHA-256 receipt binds the account, product, edition, device identity hash, token hash, exact track/hash manifest, issuance time and expiry. Expiry is at most 30 days and never beyond entitlement expiry. New requests declare protocol version 1 so older clients cannot create new unprotected caches.

`FORE_OFFLINE_AUDIO_SIGNING_JWK` is the optional dedicated P-256 private JWK. Existing deployments bootstrap with `FORE_INGESTION_SIGNING_KEY`; offline signatures use a distinct `cove-offline-audio:v1` message prefix and audience. Only public verification material is returned. Keys are pinned from authenticated HTTPS issuance responses, never imported from a local media package. A dedicated key can be provisioned independently; rotation requires renewed offline downloads when an old trust key is retired.

The browser verifies the signature, owner, device, token, manifest, expiry and clock before opening cached audio. Files use account-specific keys and AES-GCM encryption with per-file random IVs and authenticated license/asset identities. Nonextractable encryption keys are stored in IndexedDB. Account changes and sign-out purge private downloads; asynchronous writes are fenced against account changes. Unsigned legacy private caches are retired and require saving again.

Online access checks reject revoked, expired, foreign, changed-manifest or device-revoked licenses. A 401/403/404/410 response never falls back to remembered access. Network/502/503/504 failures may use a valid previously issued receipt; no receipt means no offline permission. The player rechecks cached access during playback, and the downloads screen displays renewal needs and expiry.

This is browser entitlement enforcement, not a substitute for a publisher-required hardware-backed DRM system. Revocation while disconnected takes effect on reconnection or signed expiry; the website cannot query the server while offline. Hostile browser extensions, developer tools, or an already-compromised origin are outside this browser storage boundary.

## Public offline EPUBs

One shared key convention is used for saved Gutenberg files and reader lookup. Canonical IDs require a complete registered public download manifest; a `prd_` ID alone never establishes public access. Downloads retain SHA-256 checksums, and source/public-ID aliases resolve to the same validated file. Valid existing registered public downloads remain readable. Numeric legacy Gutenberg keys remain compatible. Samples never use the full-book cache; publisher and personal-import files cannot enter this public namespace.

Public metadata fallback is limited to availability failures and verified saved public files. Authoritative permission/not-found errors remain visible. Public downloads survive sign-out and account changes.

## Verification

`npm run test:reader-sharing-offline` exercises all migrations, actual annotation APIs and sharing/feed functions, structured-clone IndexedDB transactions, native Web Crypto signing/encryption, account-switch races, denial responses, canonical/source-ID EPUB lookups, tamper rejection, and SSR route shells. It runs in persistence and security CI. Service and security/sync regressions cover surrounding annotation and account behavior.

Browser/device playback and storage compatibility still require device QA. The suite is behavioral verification and does not claim publisher DRM certification or a production load benchmark.
