# Publication command recovery

The iPad Safari failure on PR 426 was a click race in the Sounds test.
The trace places the shelf click at 213,264–213,288 ms while the final
catalog response completed around 213,267 ms and replaced the book layout
above that button. No shelf-open event or request followed. Waiting for the
editions query's settled UI fixes the test without adding retries or weakening
the deferred-loading assertions. All six PR browser profiles then passed;
PR 426 merged at `d1e6b1bd70c09bed2dbcdc5a6f7f8ce2d9bbd0c4`.

## Recovery implementation

Canonical publication can finish before an owner SQLite commit or final
positive-epoch marker fails. The scheduler previously selected only scheduled
or preorder lifecycles, so a newly live item disappeared from its work list
while the owner's hold remained unresolved. A completed preorder also was
not retried until release time.

New commands persist a bounded typed recovery envelope in the same owner
transaction as their denial hold. Before selecting due releases, an enrolled
scheduler invokes the private recorded-command recovery endpoint. It scans
at most 25 commands per call and rotates its durable cursor so older blocked
commands do not starve later pages. It re-enters the original authenticated
handlers, which independently recheck immutable manifests, canonical completion
markers, staff authority, compliance, timing and withdrawal epochs.

Only complete canonical transitions are reconciled. Partial primary writes
remain denied and need explicit repair; the runner never replays them. Old
journals without an immutable recovery envelope remain denied. Commands whose
current timing, evidence or authority is no longer valid also stay blocked.
A forged receipt cannot make the scheduler skip the private owner.

The owner journal migration adds one nullable recovery column and a scan
cursor table. Restart coverage checks migration of the previous schema.
Production enablement and QA lease restrictions are unchanged. The recovery
route is unavailable when the owner is disabled.

## Validation and release limits

Real bundled owner/primary SQLite tests cover scheduler recovery after canonical
activation, preorder completion and final positive-marker failure; each asserts
zero additional primary writes. Tests also cover partial writes, withdrawal,
receipt substitution, strict payloads, legacy journals, bounded scans and cursor
wraparound. Existing commercial proofs, publishing and disabled-production
attestation tests pass. The 88 publication SQL literals are unchanged and retain
their required production migration disposition; all 435 requirements remain
open. This is recovery implementation evidence, not production certification.

The owned-domain workflow now also triggers on upstream SSR source changes,
including localization, the anonymous bootstrap and catalog reads. Previously
those changes could run the native campaign without refreshing owned-domain
capacity evidence. Thresholds, failed samples, exclusive test queue, customer
rate limits and public routing are unchanged.
