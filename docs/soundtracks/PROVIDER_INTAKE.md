# FMA / Musopen: permission-gated source intake

**Status: technically verified staging only, not production publication.** The new script validates recordings provided directly to the Cove operator. It does NOT crawl or download from the FMA or Musopen websites. No staged item can be counted as playable or approved solely on a manifest's assurances.

## Why unattended bulk extraction is disabled

FMA's [terms](https://freemusicarchive.org/terms_of_use) prohibit automated requests, data mining and deep-linking audio. Its [license guide](https://freemusicarchive.org/License_Guide) allows commercial redistribution for *specific* CC0/BY/BY-SA recordings but says FMA itself is not the licensor. Musopen's [terms](https://musopen.org/tos/) restrict website copying to personal, noncommercial use, even while its [FAQ](https://musopen.org/faq/) describes uploader declarations of public-domain rights. Neither repository's general reputation is sufficient to authorize website scraping, commercial mirroring, or use of a particular third-party master.

## Steps for each authorized delivery

1. Obtain an explicit provider/site-access authorization or separately delivered original from the rights holder, including permission for commercial downloading/redistribution. Keep a dated, source-specific evidence URL and the granting party.
2. Assemble a JSON manifest with schemaVersion 1 and recordings array, up to 300 per batch. Each entry needs: provider (fma or musopen), sourcePageUrl (individual HTTPS /music/ track), id, title, composer, performer, attributionText, licenseCode (CC0/CC-BY/CC-BY-SA) and licenseUrl, territories [US], unresolved [], masterRedistributionConfirmed true, compositionRightsConfirmed true.
3. Add providerAccessGrant with grantingParty, scope mentioning commercial download, and evidenceUrl. Add rightsEvidence containing composition, arrangement, lyrics, performance and master; each has a basis of at least 40 characters and an evidenceUrls array. Store the actual evidence, not unsupported claims.
4. Add local-file original's basename (file), MIME (audio/mpeg or audio/ogg), exact SHA-1 and SHA-256, byte count (at most 25 MiB), period, instruments, moods, energy 0–1, hasVocals. Preserve original artist/source/license attribution and modification notices.
5. Run the validator against an *operator-provided local directory*, not against the provider's website:

    python scripts/soundtracks/external-source-intake.py --manifest /secure/intake.json --audio-dir /secure/recordings --output /secure/receipts.json

6. Inspect all rejected rows and QA receipts. The full-file FFmpeg pass verifies decoding, loudness, true peak, silence and clipping. The optional --rights-only switch verifies hashes and metadata but **does not** claim acoustic QA.

## Critical release boundary

Every successful record is labeled qa_verified_staged, with publishable=false. Cove's existing Worker and R2 release path support Wikimedia Commons originals, not these sources. No fake Commons identity may be written. Before FMA/Musopen recordings are publishable, implement a source-aware, authorized registration/review endpoint, separate source evidence snapshots, a safe media transfer mechanism, per-recording source checks, checksum-verified R2 importer, revocation, user-facing source credits and a documented provider agreement. The validators create none of these side effects.

A first-party provider/artist supply contract is preferable to bulk scraping. Provider terms and source-track licenses are separate rights gates. No site-wide license blanket approval overrides them.

## Coverage and automation

Production as inspected October 15/16, 2026: 17 ready and 733 pending; another 133–283 verified, stored and publicly playable records are needed to reach 150–300. Intake metadata, approval votes and staging receipts **do not count**.

The Commons curator is scheduled four times daily and remains gated by an active, narrowly scoped GitHub Actions secret COVE_SOUNDTRACK_REVIEW_TOKEN. Its push-trigger smoke run is read-only. The rights-backed source delivery pathway cannot be automatically enabled until site access agreements and an authenticated provider-release integration exist.
