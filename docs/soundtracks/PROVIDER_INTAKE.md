# FMA / Musopen: permission-gated source intake

**Status: private-staging intake backed by a production Worker and R2 release route.** The validator accepts originals obtained by Cove's operator; it does NOT crawl or download FMA/Musopen sites. A stored file is never public until named MFA-authenticated staff complete the rights review.

## Why unattended bulk extraction is disabled

FMA's [terms](https://freemusicarchive.org/terms_of_use) prohibit automated requests, data mining and deep-linking audio. Its [license guide](https://freemusicarchive.org/License_Guide) allows commercial redistribution for *specific* CC0/BY/BY-SA recordings but says FMA itself is not the licensor. Musopen's [terms](https://musopen.org/tos/) restrict website copying to personal, noncommercial use, even while its [FAQ](https://musopen.org/faq/) describes uploader declarations of public-domain rights. Neither repository's general reputation is sufficient to authorize website scraping, commercial mirroring, or use of a particular third-party master.

## Recording-by-recording fast-lane intake

1. Select a specific FMA original licensed CC0, CC BY or CC BY-SA, and confirm the audio file's own license, creator and master rights. FMA prohibits bulk automated requests and deep-linking. Obtain the original through normal permitted **manual acquisition** or a separately authorized delivery; do not run site scrapers.
2. For a manually obtained FMA recording, provide `acquisitionEvidence` with `method: "manual_download"`, the identical `sourcePageUrl`, an ISO-8601 UTC `acquiredAt`, `noAutomatedProviderAccess: true`, and `originalUnmodified: true`. No fabricated provider permission letter is necessary. Alternatively, provide a genuine source-specific `providerAccessGrant`.
3. Musopen public-domain claims are not treated as permission to commercially mirror material from its website. Musopen staging still requires a genuine acquisition/delivery grant and record-level rights evidence.
4. For every recording, supply exact SHA-1/SHA-256, byte count, playable MP3/OGG file, title, composer, named performer, period, moods, energy, instruments, vocal status, credits, attribution, license URL and five-layer rights dossier. The `unresolved` list must be empty; territory is US.
5. Keep original audio in a private local directory and the schemaVersion 1 manifest outside Git. Run:

    python scripts/soundtracks/external-source-intake.py --manifest /secure/intake.json --audio-dir /secure/masters --output /secure/review-receipt.json

6. Stage at most 20 originals per delivery operation using `scripts/soundtracks/submit-authorized-provider.py` with the source manifest, QA receipts, operator directory, scoped secret and `--apply`.
7. Review each staged record at Cove's `/admin/soundtracks/external`. MFA-authenticated staff must inspect track-specific license and acquisition evidence, listen to the *exact* master, and record a substantive rights assessment before approval. Only then is playback publicly enabled for the US.
8. Verify the public 200/206 audio response, attribution, country restriction, and emergency withdrawal. Keep original evidence and revoke access immediately if challenged.

Neither license labels alone nor downloaded/staged file counts satisfy the 150–300 playable-recording target. See [PROVIDER_RELEASE.md](PROVIDER_RELEASE.md) for the complete operational runbook.

## Coverage and automation

Production as inspected October 15/16, 2026: 17 ready and 733 pending; another 133–283 verified, stored and publicly playable records are needed to reach 150–300. Intake metadata, approval votes and staging receipts **do not count**.

The Commons curator is scheduled hourly and remains gated by an active, narrowly scoped GitHub Actions secret COVE_SOUNDTRACK_REVIEW_TOKEN. Its push-trigger smoke run is read-only. The rights-backed source delivery pathway cannot be automatically enabled until site access agreements and an authenticated provider-release integration exist.

## Wikimedia Commons copies of FMA recordings: license conflicts

Wikimedia Commons has a [Classical music from Free Music Archive category](https://commons.wikimedia.org/wiki/Category:Classical_music_from_Free_Music_Archive) with hundreds of file records. Cove may discover *Commons-hosted* files using Commons' API, not FMA site scraping; the original audio is not retrieved unless the individual rights and QA gates pass.

**Important verified conflict:** at least some files imported from FMA display a Commons CC0 label while the audio's embedded copyright metadata names **CC BY-NC-SA**. An example is [Aaron Dunn's Goldberg Variations Aria](https://commons.wikimedia.org/wiki/File:Aaron_Dunn_-_Goldberg_Variations_BWV_988_-_Aria.ogg). This is not an acceptable automatic commercial license. Treat the most restrictive credible rights claim as unresolved; never prefer a CC0 wrapper over NC evidence. A source file whose native metadata contains NC is excluded from automatic discovery/approval; an FMA/Musopen-origin page is held for independently documented commercial master-rights review. Underlying composition, arrangement, performance, and recorded master rights must still be established. Do not use ambiguous copies to hit an arbitrary track-count target.

The provider pipeline continues to accept **genuine**, exact-recording CC0/CC BY/CC BY-SA rights and authorized deliveries, not blanket assurances about entire catalogs. Track-level upstream declarations, attachment metadata, credits and their history should be preserved for audits and takedowns.
