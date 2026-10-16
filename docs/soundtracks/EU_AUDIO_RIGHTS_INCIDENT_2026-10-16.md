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
