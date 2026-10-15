# Recording-level source reliance

Policy adopted at the project owner's request on 15 October 2026: use a reputable
repository's explicit recording-level public-domain or commercial-use license
declaration as the normal import basis. Routine imports do not require a separate
human or legal clearance opinion. Record `reviewMethod: source_license`, not
`human`, and preserve the exact source declaration. This is acceptance of the
published permission, not a guarantee about the licensor's title.

## Accepted declarations

| Declaration on the individual recording            | Import policy                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Public-domain recording declaration                | Accept on source reliance for the US initially; retain the recording-specific evidence.                                            |
| CC0 1.0                                            | Accept the dedication, preserving its exact link and creator credit.                                                               |
| CC BY, supported version                           | Accept commercial use subject to credit, license link and change notice.                                                           |
| CC BY-SA, supported version                        | Accept unmodified commercial redistribution with the applicable attribution, ShareAlike and no-additional-restrictions conditions. |
| NC, ND, unknown, conflicting or missing permission | Keep outside this import path.                                                                                                     |

CC BY and CC BY-SA recordings remain labeled with their actual license. They are
not relabeled public domain. Public-domain status of an old score is not itself
a declaration covering a modern recording.

## Repository handling

- **Musopen:** rely on the individual recording's license/declaration, including
  explicit collection grants whose membership identifies the exact recording.
  Its [FAQ](https://musopen.org/faq/) says it does not review user uploads for
  public-domain status. The site name alone is not a blanket recording grant.
- **Free Music Archive:** rely on the individual track's license. Its
  [FAQ](https://freemusicarchive.org/faq/) and
  [license guide](https://freemusicarchive.org/License_Guide) describe multiple
  licenses with different permissions. Free access alone is not commercial permission.
- **Wikimedia Commons:** the existing adapter supports explicit PD, CC0, CC BY
  and CC BY-SA declarations on an exact file. Keep the file revision and original
  license, including any linked Musopen or creator provenance.

The current production discovery/import adapter is Commons-specific. This policy
does not claim direct Musopen or FMA adapters have been implemented.

## Controls retained

`sourceReliance` binds the decision to the recording page, source SHA-1, license
code and license URL. Approval re-fetches the live source and snapshots its exact
revision in R2. A plain public-domain declaration no longer requires a second
principal when this mode is used. Complex provenance still does. Existing known
conflicts, unresolved dossier questions, withdrawals and failed audio measurements
are not erased by selecting this mode.

Audio QA, exact-file hashes, corrected composer/performer credits, musical tags,
territory checks, license conditions and verified R2 storage still apply. These
are delivery and catalog work, not demands for a second independent rights opinion.
No source-only queue entry counts as a stored or playable recording.

## Batch operation

The versioned submission tool accepts arbitrary dossier and measured-QA folders.
Use `--source-reliance` to accept source declarations for a batch without inventing
a human attestation:

```sh
python scripts/soundtracks/submit-pilot.py \
  --origin https://cove-puce-theta.vercel.app \
  --token-file /secure/path/review-token \
  --dossiers /path/to/dossiers --quality-dir /path/to/quality \
  --source-reliance --approve-eligible --run-imports \
  --output /path/to/receipts.json
```

The server remains authoritative. The batch retains saved unresolved questions
and complex-provenance flags, skips withdrawn/rejected records, and requires each
recording's actual metadata and measured file report. It does not create dossiers,
download media for measurement, or pretend missing QA has passed.

The library goal remains 150–300 unique ready recordings. This policy change is
not evidence that the target has been imported or that human listening occurred.
