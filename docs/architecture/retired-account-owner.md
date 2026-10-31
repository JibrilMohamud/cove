# Private account and device owner migration

Stacked on draft #503 (28db6c8bfeb82a254317a3baa7255c96a449ce3f).
The source audit decreases from 92 to 84 owner-required findings: three
device mutations and five account-erasure mutations leave the shared
runtime. One previously reviewed non-authorizing audio-playback erasure
statement moves with the same queue. No new exemption or table-registry
change is introduced. Original identities and SQL fingerprints remain in
retired-account-owner-lineage.json. releaseApproval remains false.

The customer HTTP functions retain their signatures. They forward a fixed
register-device or revoke-device command, using the application's verified
user ID; request cookies never cross the boundary. The owner checks the
user's canonical account exists and is not disabled or permanently denied.
Device revocation is scoped to the user/device pair and atomically revokes
the device, active audio licenses, active delivery grants and related
sessions. Retrying after a lost commit response is safe. Registration keeps
the original terminal revoked-key UPSERT and cannot revive a removed key.

Both scheduler and authenticated worker deletion ingress forward only a
bounded erasure tick, with no caller-selected user, job, SQL, R2 key or
provider credential. The existing independent D1 job lease, cooling-off
period and staff/publisher/payment/subscription/group legal holds select
eligible requests. Provider configuration is checked before irreversible
action. A durable owner account veto is committed before D1 disablement,
object deletion or external identity deletion. Every paid-access read and
fresh entitlement publication now honors this terminal veto, including
previously issued positive proof. No positive account-reinstatement command
is added. Cancellation is still permitted during the earlier cooling-off
period, before the owner begins execution.

The storage, database and provider identity phases retain their persisted
checkpoints, retry delays and canonical lease tokens. The existing provider
erasure adapter remains unchanged: it uses either the signed erasure bridge
or a server-only admin key, and independently verifies identity absence.
Deleting a provider identity alone does not establish immediate JWT
revocation; the application's disabled-account check and owner veto deny
subsequent server authorization. Fully offline licenses retain their existing
expiry/reconnect limitation.

Validation executes the actual private Worker against the complete migrated
SQLite schema. Tests cover wrong buyer/device, missing account, revoked-key
re-registration, every revocation batch boundary, lost commit responses,
owner restart, R2 failure, database rollback, provider failure and verified
absence, legal holds, terminal paid-access denial and blocked fresh grants.
Public facade tests use D1 handles that throw on every attempted mutation,
validate exact owner receipts, preserve Supabase app-ID syntax, and verify
that cookies are not forwarded. Exact SQL and immutable exception-lineage
reconciliation remain independently enforced.

This is a functional isolated-QA source replacement, not a production
cutover. No production binding, provider secret, route, customer account or
object is changed. Owner-side R2 and identity configuration, signed bridge
production proof, all remaining writers, exclusive live D1 privileges,
customer access, performance acceptance and protected rollback remain
release requirements. Do not merge or activate the stacked drafts on this
evidence. During QA recovery, keep owner vetoes and job checkpoints intact;
stop the caller/lease and resume the corrected owner rather than restoring
shared canonical writers.

Local validation: TypeScript and the lint baseline pass with no new error
groups. All 49 owner-audit workflow commands pass across the initial and
remaining-command runs, including exact frozen exception lineage and
private finance recovery. Paid settlement still passes 60 injected failure
boundaries. The customer-support/commercial-experience suite and complete
sharing/erasure suite now execute the real private owner through the real
public forwarding API; both pass. The latter retains signed Supabase bridge
proof, provider absence verification, storage retry checkpoints and
concurrent queue coverage. A dedicated private-upload erasure fixture also
passes with SQLite foreign keys enabled and no foreign-key violations.

Earlier partner-feed and notification source assertions expected code still
in shared files after predecessor drafts had already moved it. The checks
now inspect the exact private owner counterpart and original retirement
lineage instead; no production gate or financial exception is relaxed.
The separate broader publishing source regression still requires the
predecessor publishing-editor assertions to be migrated. Hosted CI and
production activation are separate from these local results.
