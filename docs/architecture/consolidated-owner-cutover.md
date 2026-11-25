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

### Legacy credential dependency closure

The latest source audit (run 45413906230, job 138514788057) found 21 direct references across these 17 workflows. Do not equate a green diagnostic job with a passing retirement gate.

| Workflow(s) | Required replacement or retirement |
| --- | --- |
| biosync-canary | Owner-only hourly production schedule; direct D1 REST mutations removed. Protected activation 45512071882 proved real replay, the exact scoped credentials and zero-D1 ingress; live owner version ed1ffa2a-5a20-40af-8f3c-4906f41f7c50. No eligible queued short tracks at cutover. Fresh real publication and post-merge hourly execution remain independent witnesses. Do not revoke other workflows' still-used broad credential. |
| literary-isolated-utc-budget | Preserve frozen day and budget rollover under the authorized owner; no standing primary D1 write token. |
| isolated-commons-audio-technical-qa; isolated-commons-review-cases; isolated-open-license-discovery | Detach technical and discovery writes into isolated supply storage/account; retain read-only reporting through a proven read credential and canonical handoff through the checked application service. Discovery's apply mode is a write, despite its job name. |
| cove-commerce-private-qa-deploy; deployed-commerce-browser-acceptance | Rebind synthetic fixtures into the separate QA account; preserve buyer/outsider, sandbox payment and browser checks. |
| covereads-secure-ssr-gateway; fast-storefront-real-catalog-acceptance; strangler-hosted-capacity-evaluation | Separate read-only production snapshot from isolated QA deployment and seeding; preserve exact performance gates. Do not swap only the token while scripts still target production-account staging resources. |
| literary-private-binding-stage-canary; literary-remote-staging-e2e; publication-source-isolation-qa | Move synthetic remote resources to QA account and use its scoped credentials. |
| isolated-data-plane | Archived branch-only diagnostic; migrate or retire executable branch workflows and remove their legacy secret before revoking. Preserve evidence. |
| cove-sounds-private-rollout; literary-guarded-owner-drain; literary-progressive-canonical-publication | Manual protected production changes only: temporary maintenance identity and independent audit, never standing broad secret. |

There is no safe bulk text replacement: jobs with legitimate isolated D1/R2 mutations are currently targeting resources inside the production account. Rebinding the resources and their secrets must be coupled. Existing source retirement gate must ultimately report zero direct references; the independent physical audit must additionally verify actual provider privileges and complete user-token evidence. No source-only approval is sufficient.

## Phase 5: cutover

### Captured live baseline (NOT safe post-cutover rollback)

| Script | Active version (100%) | Primary bindings | Schedules |
| --- | --- | --- | --- |
| cove-legal-authority-production | 3463ff93-f077-40bf-a4d5-fb7bfc143cd5 | PRIMARY_DB | 0 |
| cove-persistence-backend | 401f2af2-6e69-4611-8110-1d127af6eecf | DB | 7 |

Both point to primary 4bd657ac-8789-403e-a28c-93aba8d0a989. Legal namespace 83d7eadf3957436389a7b072120a9829 must be preserved. The active owner also holds a separate LITERARY_CONTENT_DB binding (400c3af3-5d40-41fd-83cc-98228e40ddac). This is not a second primary writer, but the production owner configuration must preserve that separate database and keep it outside the canonical business-handle fence. The QA candidate intentionally rejects all extra D1 bindings; production resource-role separation must be proved independently. Neither old version is an acceptable post-cutover rollback pair because the legacy gateway is D1-bound and the owner is disabled. Capture fresh versions immediately before changes.

Require exact approved production candidate plus independent denial/withdrawal authority; do not activate positive grants from incomplete historical evidence. Capture active versions, storage/namespace IDs, backups, pending events and current denial/refund state. Quiesce legacy schedules and writers, drain in-flight work, durably hold incoming payment and withdrawal events. Activate the existing owner's new private business entrypoint and native schedule entry, switch the gateway to its unbound version, verify the sole binding, remove competing privileges, resume/replay queued events, run independent physical audit and functional acceptance. Preserve same D1 and legal DO state. Rollback uses only owner-bound code and D1-unbound gateway; never restore competing writer access. Abort before destructive steps if any proof is missing. Do not describe a successful isolated test as physical production certification.

Production owner enrollment, independent legal evidence, LIVE transaction proof, full hosted functional parity and rollback remain unresolved. No release authorization is granted by this document.

### Detached Commons credential cutover

The source Commons database and private object bucket are retained as an immutable evidence archive, not deleted. Existing candidate, discovery-run, cursor, technical-QA and unapproved review rows migrate to the physically separate QA account. The seven reviewed music migrations define the destination schema; licensed-master, contract, publication and other operational tables must be empty at migration. A shared non-cancelling job queue and protected main gate serialize all five affected jobs. Migration reads only the old detached database and content-addressed objects using the existing production-account read credential; all mutations use the already enrolled QA-account D1 and R2 credentials. The completion marker requires matching before/after source snapshots, exact destination snapshot, and SHA-256 verification of every referenced original/report. Every subsequent admission rechecks the archived source digest until the old principal is retired. No customer playback, licensing, quietness approval, or primary D1 authority is granted. Existing disabled shadow resources stay untouched; no retirement certification until a protected hosted receipt and subsequent jobs pass.
