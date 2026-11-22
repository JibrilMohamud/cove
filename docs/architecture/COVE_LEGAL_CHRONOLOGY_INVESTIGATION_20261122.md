# Primary legal chronology investigation — 2026-11-22 UTC

Release remains **NO-GO**. None of these diagnostic findings supplies a legal
grant, complete external withdrawal history, or production owner epoch.

## Independently read primary facts

Fixed SELECT-only Cloudflare D1 queries returned `changed_db:false`, `changes:0`,
`rows_written:0`, and `served_by_primary:true`:

| Evidence | Observed result |
| --- | --- |
| Conflicting grant/timestamp groups | 116 |
| Groups changing `status` | 114 |
| Groups changing `sourceEvidenceId` | 109 |
| Other snapshot fields changing within those groups | 0 |
| Backdated events compared with prior physical event | 2, both changing status |
| Distinct grants in the union of those two problem cohorts | 116 |
| Current active/allow grants in that union | 112 |
| Current suspended grants in that union | 4 |
| Rights configuration audit / contract audit / scope snapshots | 0 / 0 / 0 |
| Disputes / dispute events / copyright notices / counter-notices | 0 / 0 / 0 / 0 |
| Legal contact requests | 0 |
| Rights decisions | 3,171 |

The empty histories cannot establish that no external withdrawal occurred.
The 3,171 evaluated decisions cannot establish a sequence for 87,742 grant
events: their schema has no grant-event reference or independent legal sequence.
The conflicting field counts overlap and must not be added together.

Current trigger SQL independently confirms that grant insert timestamps use
`COALESCE(NEW.updated_at,NEW.created_at)` and update timestamps use
`COALESCE(NEW.updated_at,datetime('now'))`. The audit uses random text IDs and
has no dedicated authoritative legal event sequence. Physical rowid and a
client-provided update timestamp must not be promoted into that authority.
All 87,742 observed timestamp encodings fit either millisecond ISO UTC
(87,405 events) or SQLite UTC seconds (337 events).

Current production settings independently show
`COVE_RIGHTS_OWNER_ENABLED=0` and no enrolled QA/current mutation journal
setting. The backend still has a competing native primary-D1 binding. An
owner namespace or binding is not a live verified denial epoch. Enrolling a
new zero epoch would not repair historical production withdrawals.

## Protected replay attempt and corrective implementation

[Protected run 44976630586](https://github.com/JibrilMohamud/cove/actions/runs/44976630586)
ran on reviewed main `4bc87daae82ffc9acdb1881e20a860f2ffa938bd`. Offline
checks passed; the real SELECT-only scan stopped on HTTP 429 at 02:35:29 UTC,
before finishing the event scan. The old implementation produced no artifact
on this early exception. **This was not a completed full replay.**

The corrective change:

- Pace fixed SELECTs at 2.5 seconds rather than 850 milliseconds. Permit at
  most two retried 429 responses in the entire scan, using the existing tested
  same-query throttle, honoring Retry-After within a six-minute total wait
  budget. Never retry authentication failures or transport/5xx errors.
- Use fixed 768-row keyset pages to halve API calls. An independent aggregate
  measured the maximum serialized event at 1,202 UTF-8 bytes (923,136 bytes
  for 768 worst-case observed rows, plus the small response envelope). Retain
  the hard 1-MiB response cap: future oversized rows fail closed. Pagination
  regression tests cross the new bound; no rows or fields are omitted.
- Preserve aggregate-only incomplete checkpoints from before the first read
  and after every page; a partial scan cannot appear complete. Never retain
  private grant IDs, snapshots, exception payloads or credentials.
- Normalize the two reviewed UTC encodings for conflict grouping. Reject
  invalid calendar dates, local timestamps and unreviewed precision instead
  of relying on Date.parse's permissive normalization.
- Count and fingerprint the distinct unresolved cohort, including how many
  current active/allow grants it contains. This is a diagnostic exclusion
  cohort; it neither changes production grants nor validates remaining grants.
- Refuse new audit events after the current-state comparison phase begins.
- Test the actual CLI under a network-denying fixture, including incomplete
  reports, redaction, bounded retry and provider mutation-metadata refusal.

The full scan is still a multi-request diagnostic, not an atomic snapshot.
Boundary counts cannot detect every same-count edit. Even complete current
snapshot parity leaves `historicalRightsReconciled`, `currentOwnerVerified`,
`authorizing`, `permitsPublication`, and `releaseCertified` false.

## Evidence still absent

[Protected replay 44979272523](https://github.com/JibrilMohamud/cove/actions/runs/44979272523)
completed after the primary/zero-write response attestations were enforced.
It replayed all 87,742 events and compared all 82,246 current grants with
zero missing, orphaned or mismatched grants and identical boundary counts.
There were 226 HTTP attempts, one HTTP 429 and a bounded 20-second retry wait.
The earlier complete diagnostic scan had identical event/current/cohort
fingerprints. This establishes repeatable physical state parity only.

The replay still reports 116 ambiguous timestamp groups, two backdated events,
and **114 suspended-to-active transitions without verified legal reinstatement
history**. These transitions must not be interpreted as authorized grants.
The unresolved union is still 116 grants, of which 112 are currently
active/allow. All authorization/publication/release flags remain false.

[Provenance inventory 44979337633](https://github.com/JibrilMohamud/cove/actions/runs/44979337633)
then stopped on HTTP 429; the previous eight-attempt/no-retry adapter emitted
no artifact. The corrective inventory adapter uses the same 2.5-second pacing,
at most two bounded 429 retries (ten total HTTP attempts for eight fixed
aggregate reads), and safe incomplete checkpoints. Authentication, 5xx,
transport failures, replica reads and write attestations still fail closed.
The inventory is not complete until a protected run emits `complete:true`.

Resolving the 116 grants requires authentic source/owner records identifying
the legally authoritative order and all withdrawals/reinstatements, including
territory, format, contract/version and effective-time scope. Current public
catalog state, a freshly fetched source page, staff-supplied booleans, new
hashes over legacy data, or sorting by rowid cannot recreate that history.
The result must then be reconciled against a fresh independently authenticated
production owner denial epoch before any positive publication.

Exclusive physical/native/token/source writers, LIVE payment through refund
and media revocation, production 503 elimination, regional EPUB repair,
production-compatible rollback and unchanged strict geographic/100-RPS
performance remain separate outstanding release gates.
