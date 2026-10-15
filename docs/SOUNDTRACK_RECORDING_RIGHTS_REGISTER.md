# Cove Soundtracks — Individual Recording Evidence Register

**Snapshot: October 15, 2026.** [SOUNDTRACK_RECORDING_RIGHTS_REGISTER.csv](SOUNDTRACK_RECORDING_RIGHTS_REGISTER.csv) contains **236 unique Commons recording candidates** sourced from Cove's authoritative production D1 registry. Each row preserves the exact Commons file page, SHA-1 of the source media, MIME/size, the source's license claim and license link, the attributed artist string, and preliminary period, instrumentation, vocal and mood metadata.

**Critical distinction: this is a provenance and review-worklist export, NOT 236 completed rights determinations.** Every row has `status=pending_review`; review dates and R2 storage dates are empty. Wikimedia's claim that material is CC0, CC BY, CC BY-SA, or public domain is a starting point, not independent legal proof. The composition, lyrics (if any), arrangement, performers, sound-recording producer, source of the permission, attribution requirements, and distribution territory must each be checked before promotion to `approved`.

## Distribution of candidates

| Claimed source license | Candidates |
| --- | ---: |
| CC0 | 7 |
| CC BY | 27 |
| CC BY-SA | 138 |
| Public domain (Commons claim) | 64 |
| **Total awaiting individual review** | **236** |

These totals were verified against the six source categories in production D1 on October 15, 2026. Heuristic tags are not verified acoustic features: a word like *allegro* may indicate energy, but identifying the full performance and actual instruments requires listening and checking the original source.

## Reviewer procedure

Follow [SOUNDTRACK_RIGHTS_INGESTION.md](SOUNDTRACK_RIGHTS_INGESTION.md), starting with the file page and primary grant. Record an evidence-linked decision on **each** ID using Cove's scoped review API. Never use raw D1 updates to simulate a human approval or to fabricate a reviewer identity. Preserve the evidence in `soundtrack_rights_decisions` and allow the scheduled importer to recheck the license and checksum before copying to R2. Every new R2 object must be verified before counting it as available.

### Research example

The Commons page for **Albéniz — Rondeña from Iberia** identifies composer Isaac Albéniz (1860–1909), a modern solo-piano performance by the uploading artist La Pianista, original upload history, and an explicit CC0 dedication of the artist's performance and recording. The source has a recorded Commons SHA-1 and source link. This makes it a strong candidate for independent clearance; it is intentionally **not yet marked approved** in production. Any territory permission should be tied to the actual documentation, not assumed worldwide from the composition's age alone.

## Release criterion

Do not announce a 150–300 recording rights-cleared library until D1 contains **150–300 distinct `ready` rows** with a reviewed rights decision, valid storage key, and independently verified objects in private R2. The published user-facing catalog intentionally returns an empty set until that condition starts being met.
