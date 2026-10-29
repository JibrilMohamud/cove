# Owner-controlled publication materialization

This increment adds a complete typed materialization command for independently
approved **versioned distribution submissions enrolled in isolated QA**. It does
not enable production authority, retire a production database binding, or close
any of the 426 historical production owner-required SQL sites.

## Workflow

The original `materializePublishingSubmission` caller dispatches
`publication.materialize` when enrolled. The private legal owner independently
checks the immutable submission SHA-256 and canonical identities, current staff
permission and matching approval, or its own explicitly enabled automated-review
policy plus recorded passing review/risk/approval evidence. Current publisher,
tax/payout, assignment and contract-version compliance are required. Unversioned
legacy self-publishing contracts fail before writes; the command does not infer
or fabricate approved distribution versions.

The owner durably reserves the work, edition and commercial product identities
and records a product denial and typed recovery envelope before the first
canonical mutation. A submission lock and product lock exclude overlapping
executors. Retired prior grants receive terminal subject denials before writes,
including proofs for other products sharing those grants. A retained assigned
contract and an existing release being prepared for a future update are preserved.

The original materializer runs the entire catalog/asset/rights/offer/royalty/
version/lifecycle workflow on the owner's independently bound primary and private
bucket. Every asset's canonical edition, hash, size, type and clean validation
state are checked; bytes are hashed both before primary writes and again at the
actual private R2 copy. Its source object cannot change between inspection and
copy without failing closed. No SQL, terms, manifest or storage key is accepted
from the command caller.

Materialization previously omitted its catalog search document. The new owner
path derives that document from canonical records under the same denial hold,
so the existing legal evaluator and storefront publisher can independently
verify the result. Scheduled first releases prepare private records without
publishing positive access. A future revision can retain the current release's
independently verified storefront proof.

Only the final owner-scoped publishing audit marker certifies primary completion.
It follows all primary mutations, including the presentation projection and
preorder-plan attempt. Migration 0090 makes those exact completion markers
immutable. A publication row by itself cannot prove completion. Owner commit or
final proof acknowledgement failures can be reconciled by the scheduler without
repeating primary writes. Partial primary executions retain their durable denial
and require explicit repair; this is not an atomic D1 transaction or automatic
partial-write repair system. Replays cannot undo a later withdrawal or reactivate
an old version after a different version becomes current.

An owner-bound private R2 `BUCKET` is required for this command. Existing deployed
settlement QA does not provision a publishing fixture or this binding, and is
not hosted publishing certification. Production owner enablement remains zero.

## Tests and inventory

`check-publication-materialization-owner.mjs` bundles the actual Worker/DO and
original publishing functions against the fully migrated primary and separate
owner SQLite database. It covers all 48 primary-write failures, duplicate
concurrency, incomplete publication rows, lost primary-marker/owner/final-epoch
acknowledgements, real scheduled recovery, initial/scheduled/update preparation,
shared retired grants, retained contracts, automated approval, byte corruption
and copy races, current reviewer/compliance denials, and the original caller with
caller-side protected SQL locked.

The conservative scanner inventories 483 sites: the same 460 historical sites
(426 required, 33 nonauthorizing, one test fixture), 22 existing private settlement
executor sites and one new private-QA presentation statement. Exact source/import
containment prevents reclassifying historical production sites as the new executor.
All production release-denial gates remain closed.

## Hosted payment QA bootstrap correction

The protected main run after PR 451, run 40860684423, failed before initial atomic
payment settlement. Its fixed synthetic database had no `royalty_holds` table:
the schema-only copier allowlist omitted this royalty-engine dependency. The
engine refused settlement and left tender/entitlements uncommitted, as intended.
The source table is now included and required before any test payment. The real
owner regression demonstrates denial with the missing table, unchanged money
and grants, and successful retry after schema-only restoration. A new hosted
signed Stripe TEST campaign is still required; local tests do not certify it.
