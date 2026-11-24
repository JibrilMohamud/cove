# Canonical persistence consolidation — release decision

Status: candidate only. No production changes or authority claims.

## Phase 1: freeze the competing migration

Use this integration branch as the physical-cutover lane. Preserve the merged native schedule, BioSync and paid-owner evidence. PR #892 remains separate: its observed operational row assertions are reused, not its five new remote write protocols. Do not merge a second competing execution architecture simply because it exists.

## Phase 2: physical boundary

Keep the exact existing CoveLegalAuthority class and object namespace in the existing production script at eventual cutover. The candidate exports a private named business entrypoint and the same legal default entrypoint, with one PRIMARY_DB. The gateway carries only an authenticated service binding, no D1, no legal object handle, no Stripe or R2 secret. The original backend handlers execute locally within owner-side legal and commerce fences. The owner owns all seven cron schedules and reuses their existing claim journal. No raw SQL over a service boundary. No production flags/config changes in this candidate.

## Phase 3: acceptance

Run one native workerd campaign with all migrations, actual gateway/owner service binding, original handlers, operational row persistence and native scheduled events. Check every active legal, account, commerce, publishing, delivery and BioSync operation on protected hosted fixtures before promotion; prior isolated TEST proof is not proof of this exact integration. Preserve withdrawal/refund races, replay, denial epochs, browser and accessibility checks. Confirm both caller and owner fail closed under wrong credentials, a second primary, missing lease and production enrollment. Run full 100-RPS and geographic gates separately. An uncovered business mutation must be repaired or explicitly denied, never swallowed.

## Phase 4: credential closure

Inventory active immutable Worker versions plus every account/user token. Last known privileged account credentials: COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN, Cove GitHub Deployments, Cove Protected Worker Version Upload. Verify dependencies; replace staging access with separate QA-account authority, rotate/restrict production deployment privileges to the protected maintenance procedure, then revoke superseded standing credentials. Investigate or replace unclassified user permission groups through the actual token inventory, not guessed aliases. Keep read-only audit credentials and independently verify all user principals. Do not revoke an active dependency before replacement and rollback are proved. No credential changes in this candidate.

### Provider-observed baseline (2026-11-24, read only)

The protected live audit inspected 465 active versions, exactly two primary-bound scripts, and verified single-member principal coverage. It failed the enabled-owner, nonowner binding, account-token and user-token gates. Audit run 45415002370, live job 138518804989. Do not re-run that full inventory solely to rediscover the same state.

Production account token list was complete (14/14). All three named privileges remain active:
- Stage Workers Deploy: account-wide Workers Scripts Write on production account. Existing QA-account COVE_CF_QA_WORKERS_DEPLOY_TOKEN is correctly isolated, but migrate remaining legacy staging dependencies before retirement.
- Cove GitHub Deployments: account-wide D1 Write, Workers Scripts Write, Account API Tokens Write and additional broad capabilities. Replace any remaining external dependencies; verify legacy source reference audit and deployment logs before retirement.
- Protected Worker Version Upload: Individual Workers Editor on a single script. Protected zero-traffic workflow uses COVE_CF_WORKERS_VERSION_UPLOAD_TOKEN; transition to an expiring maintenance-only credential and revoke after the window. Do not confuse script-scoped editor with read-only.

The separate QA account has precisely three account tokens, all scoped to that account: D1 Write, R2 Storage Write and Workers Scripts Write. Reuse these for hosted consolidation QA. The connected user-token endpoint is not authorized; the protected user-token audit remains negative. A dashboard/protected audit review must resolve the unclassified user permission without publishing token identifiers or widening allowlists.

## Phase 5: cutover

### Captured live baseline (NOT safe post-cutover rollback)

| Script | Active version (100%) | Primary bindings | Schedules |
| --- | --- | --- | --- |
| cove-legal-authority-production | 3463ff93-f077-40bf-a4d5-fb7bfc143cd5 | PRIMARY_DB | 0 |
| cove-persistence-backend | 401f2af2-6e69-4611-8110-1d127af6eecf | DB | 7 |

Both point to primary 4bd657ac-8789-403e-a28c-93aba8d0a989. Legal namespace 83d7eadf3957436389a7b072120a9829 must be preserved. The active owner also holds a separate LITERARY_CONTENT_DB binding (400c3af3-5d40-41fd-83cc-98228e40ddac). This is not a second primary writer, but the production owner configuration must preserve that separate database and keep it outside the canonical business-handle fence. The QA candidate intentionally rejects all extra D1 bindings; production resource-role separation must be proved independently. Neither old version is an acceptable post-cutover rollback pair because the legacy gateway is D1-bound and the owner is disabled. Capture fresh versions immediately before changes.

Require exact approved production candidate plus independent denial/withdrawal authority; do not activate positive grants from incomplete historical evidence. Capture active versions, storage/namespace IDs, backups, pending events and current denial/refund state. Quiesce legacy schedules and writers, drain in-flight work, durably hold incoming payment and withdrawal events. Activate the existing owner's new private business entrypoint and native schedule entry, switch the gateway to its unbound version, verify the sole binding, remove competing privileges, resume/replay queued events, run independent physical audit and functional acceptance. Preserve same D1 and legal DO state. Rollback uses only owner-bound code and D1-unbound gateway; never restore competing writer access. Abort before destructive steps if any proof is missing. Do not describe a successful isolated test as physical production certification.

Production owner enrollment, independent legal evidence, LIVE transaction proof, full hosted functional parity and rollback remain unresolved. No release authorization is granted by this document.
