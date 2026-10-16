# US recording-rights safeguard — 2026-10-16

## Production correction

Six newly published, historical Pablo Casals performances of J. S. Bach's Cello Suite No. 1 (BWV 1007), original recording IDs `cm_11720468`, `cm_11737982`, `cm_11738065`, `cm_11738130`, `cm_11738155`, and `cm_11738187`, were accepted automatically as US-rights-cleared from a bare Wikimedia Commons `PD` metadata declaration.

Their exact original file pages instead say **public domain in the European Union**, identify **Pablo Casals** as performer, and date the recordings to **1929–1939**, with historical CD restoration. The `Artist` metadata said **Bach, Johann-Sebastian**, the composer rather than the performer. This was not sufficient US commercial master/performance clearance; no claim of a final US legal determination is made.

Examples of retained public source evidence:
- https://commons.wikimedia.org/wiki/File:Bach_-_Cello_Suite_no._1_in_G_major,_BWV_1007_-_I._Pr%C3%A9lude.ogg
- https://commons.wikimedia.org/wiki/File:Bach_-_Cello_Suite_no._1_in_G_major,_BWV_1007_-_IV._Sarabande.ogg
- https://commons.wikimedia.org/wiki/File:Bach_-_Cello_Suite_no._1_in_G_major,_BWV_1007_-_VI._Gigue.ogg

On **2026-10-16 UTC**, production D1 atomically withdrew these six exactly identified, source-license-automated records by setting `status='revoked'`, clearing their playback territory and R2 object references, incrementing review versions, and recording the reason `eu_only_audio_rights_requires_us_review`. Six append-only review events, six rights decisions, and six durable R2 cleanup queue entries were inserted. The six identities and cleanup entries were independently verified in D1 after the transaction. The remaining ready count was **190** at verification. The R2 object cleanup itself is asynchronous and its completion is **not** asserted here.

This release adds independent preventive safeguards:
1. Source-license approval fails when original Commons wikitext contains an EU-only audio PD template or equivalent explicit territorial limitation; a Commons `Public domain` badge never overrides that limitation.
2. Composer-as-performer credits are rejected even when punctuation or name order differs.
3. New quiet-discovery categories only supply **candidates**. Every original still requires record-specific commercial license, master, territory, performer, QA and storage checks.

Reinstatement requires an entirely fresh, supported rights determination for the **recording** and territory, distinct from the public-domain status of Bach's underlying musical composition. Commercial Creative Commons grants with valid attribution/SA are a safer automated route than unqualified historical-recording PD claims.

## Ongoing checks

Audit remaining US-ready `PD` recordings individually for recording-age, source legal territory, sound-recording publication history, and performer identity; no automated license label is a substitute for a territory-specific determination. Track verified rights-clearance exceptions and documented staff approval where the original file declaration is ambiguous.

## Recording-level follow-up and automated-policy hardening

The same 2026-10-16 production audit identified six more automatically approved
`PD` recordings whose true master/performance permissions were either presented
under a distinct license or not traceable to the person labelled as performer:

- `cm_12402239`: Satie Gnossienne No. 1, recorded by La Pianista. The Commons source provides CC BY-SA 3.0 for **the performance** separately from public-domain composition terms. The stored `PD` classification omitted that distinct licence.
- `cm_3432550`: Satie Gymnopédie No. 1, credited to Robin Alciatore. The original master was obtained from Musopen; Cove's source-reliance path requires additional original-delivery verification for such recordings.
- `cm_61547`: Beethoven Symphony 5 performance. Commons lists the EFF Open Audio License for the sound, not a blanket recording-level public-domain release. The backend identified an uploader as performer rather than the named orchestra and conductor.
- `cm_14976800`, `cm_14976913`, `cm_14976923`: Schumann Kreisleriana tracks whose file pages name pianist Giorgi Latsabidze, but the catalog performer was a separate uploader, Taraplid. The uploader asserts a PD dedication of an own-work recording, but the pianist/recording permission relationship remains unclear. These require an individual review rather than an automatically assumed performer identity.

All six exact records were withdrawn in production with playback rights cleared,
versioned records, six append-only events, six rights decisions and six durable R2
cleanup tickets. This is a conservative rights hold and **not** a determination
that the original rightsholders lack permission. Properly evidenced recordings
may be re-reviewed and republished with the **correct recording-level** license,
attribution, and performance rights.

The automated source curator now **never** approves a `PD`-badged audio master
from aggregated metadata alone. Such candidates remain available to staff. At
the API layer, an individual source-reliance `PD` approval must match an original
Commons `PD-self` **sound-recording declaration**; an EU-only phonogram claim
remains forbidden for US release. More complex provenance requires the
independent staff-review route. Commercial CC0, CC BY and CC BY-SA originals
continue through the existing fail-closed source and audio-quality checks.

Sources:
- https://commons.wikimedia.org/wiki/File:Satie_-_Gnossienne_1.ogg
- https://commons.wikimedia.org/wiki/File:Erik_Satie_-_gymnopedies_-_la_1_ere._lent_et_douloureux.ogg
- https://commons.wikimedia.org/wiki/File:Ludwig_van_Beethoven_-_Symphonie_5_c-moll_-_1._Allegro_con_brio.ogg
- https://commons.wikimedia.org/wiki/File:Robert_Schumann_Kreisleriana_Op._16_N1_Giorgi_Latsabidze.ogg

The music-profile queue and published-playback index must always exclude withdrawn
recordings, and an error assessing one candidate cannot prevent independent
approved originals from progressing to storage.
