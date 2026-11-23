# Private publishing helpers and regional EPUB repair

Stacked on draft #504, baseline 9ac741c287c202f110089578118e5bfbe24943a9.
Owner-required source findings decrease from 84 to 70: ten publishing helper
sites and four regional EPUB repair sites. The scanner, canonical table list,
frozen exception baseline and production release gate are unchanged.

The remaining shared publishing SQL was duplicated in the already-private
publishing editor. Materialization and activation now use that unexported
implementation directly. Unused shared transition and inline-validation
writers are removed. The shared ensurePublishingLifecycle export remains a
read-only lookup, preserving rollback's lookup of an existing lifecycle;
only the verified private publishing workflow can create a missing lifecycle.
No new remote helper executor, generic SQL route or activation bypass exists.

The private helpers are also hardened: lifecycle plus initial history commit
atomically; transitions compare the prior state and update time inside D1,
and commit matching history and state updates together only when those
predicates still hold. Terminal suppression,
takedown and retirement cannot be undone through the helper's migration or
moderation parameter. Activation-history IDs derive from the complete event
so lost responses cannot create duplicate records. Publisher, rights-party,
finance-party and account links commit together, with stable account-derived
identities and transaction-current canonical compliance/pointer predicates.
The helper rechecks the canonical publisher instead of trusting supplied
account fields. A revoked compliance decision during an awaited read stops
all new party writes. Private parent commands continue to verify immutable
submission evidence, reviewer authority, rights epochs and R2 assets.

The complete regional repair algorithm runs behind a fixed private command
whose only inputs are a cursor and a bounded batch limit. Its owner-bound R2
is never supplied by a caller. It reads source/canonical grant evidence,
hashes the actual stored EPUB bytes, rechecks live territory-specific deny
precedence on every write, atomically links asset/version pointers and uses
pending/completed receipts for recovery after a lost final acknowledgement.
The existing operator feature flag and primary D1 admission remain in front
of the caller. No upstream content download, rights grant or paid-rights
substitution is added. Only the existing isolated QA primaries and expiring
private owner lease can execute it.

Original shared SQL site IDs/functions/fingerprints are retained in the new
retired-publication-helpers-owner-lineage.json. The earlier editor's source
hash remains immutable; the new lineage explicitly binds that previous hash
to the exact current source, rather than rewriting historical evidence.
Unchanged inline validation and all regional repair SQL retain byte-exact
private counterparts. Changed lifecycle/party/activation SQL has dedicated
real-SQLite atomicity, lost-response, replay, foreign-key and race tests.
Existing regional repair tests now use the actual public facade and actual
private owner, including corrupt bytes, revoked grants, deny precedence,
cursor validation and receipt recovery.

These are executable isolated-QA source retirements, not deployed production
ownership. releaseApproval remains false. Production privileges, positive
legal/provider/customer-access certification, performance acceptance and
protected rollback remain open. No live secrets, customer objects, bindings
or public routing are changed. Keep private command/repair receipts and
terminal denials during recovery; do not restore shared D1 writers as a
rollback. Stop isolated callers/leases and resume a corrected owner.

Validation on this branch: 118 exact source sites reconcile as 70
owner-required, 24 unchanged non-authorizing, 23 private QA and one fixture.
All 57 node commands from the owner-audit workflow pass, including inline
run steps. The initial runner omitted those inline steps; the committed
runner includes them. The retired publishing-presence assertion verifies
exact retirement lineage and its private replacement. The actual private
publishing helper test covers every lifecycle/party batch interruption, lost
responses, repeated calls, concurrent state/compliance changes, terminal
state denial, other-account isolation and activation-history deduplication;
its complete migrated SQLite schema has foreign keys enabled. Existing
regional EPUB repair, operator safety, public forwarding, 60-boundary paid
settlement, account/sharing erasure, customer-support and notification suites
pass. TypeScript passes. The lint baseline has no new error groups after
formatting the updated fixture.

The predecessor hosted security failure was traced to a reader-recovery
fixture trying the retired direct device writer. It now seeds its canonical
user and invokes the real HTTP device-registration handler through the real
private owner, while retaining the original offline-license and restoration
assertions. No production fallback or credential bypass is restored. Hosted
CI and complete production release certification remain separate gates.

Hosted CI exposed two legacy source-presence assertions: the inventory
still demanded a shared publishing writer, and commercial-media checks
looked for erasure legal holds in the former shared module. The inventory now verifies
immutable retirement evidence and the private replacement; the commercial
check verifies legal holds in the private account owner and passes locally. The local
workflow runner is committed as check-owner-workflow-locally.mjs so inline
run steps cannot be omitted in subsequent validation.
