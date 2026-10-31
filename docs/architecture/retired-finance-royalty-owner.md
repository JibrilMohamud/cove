# Private finance and royalty source migration

This change removes 21 shared-runtime owner-required SQL sites (finance 10;
royalty engine 11), taking the stacked draft source audit from 113 to 92.
This is source retirement with an executable isolated QA replacement. It is
not deployed production ownership. `releaseApproval` remains false.

The exact original site IDs, functions, tables, operations and SQL digests
are retained in `retired-finance-royalty-owner-lineage.json`. The canonical
scanner, protected-table registry and exception classification baseline are
unchanged. Existing API SQL keeps its original disposition and SQL identity;
its surrounding source is explicitly reattested for authenticated finance
actor propagation only.

Public finance and royalty modules contain typed facades and read-only
reporting. Only the private legal Worker can install the original financial
algorithms for its independently bound raw PRIMARY_DB. Importer and bundle
checks reject alternate installers and shared-runtime SQL fallbacks. Internal
settlement and refund transactions retain their original call contracts and
run the private implementations after lease/secret checks. No remote command
accepts a royalty context, statement batch, calculated amount or SQL program.

The fixed financial action protocol supports party/contract/version creation,
usage ingestion and processing, usage pool creation/allocation, and payout
batch creation/approval/QA settlement. The owner rechecks active staff and the
specific permission against its own primary. API routes supply the verified
staff identity, and contract attribution is overwritten by the owner.
Commands bind an immutable input digest to an operation ID. The caller uses
Idempotency-Key when supplied, otherwise a stable digest of the action,
verified actor and input; explicit keys allow a new intentionally identical
operation. Pending commands survive owner restart. Creation IDs are derived
from the journal identity; completed commands return their durable receipt.
Reusing a key with different arguments fails. Permissions and the QA lease
are rechecked even for completed command replay.

Contract version, splits and rules commit in a single D1 batch. Payout batch,
items, links and totals commit in one batch; risk assessments are recoverable
before acknowledgement. Approval commits its batch/event/allocation states
atomically. Each payout item commits its paid marker, allocation/event
states and both ledger sides together. New batches exclude allocations
already linked to a non-canceled batch. Usage pools freeze the complete
allocation vector and lock atomically; interrupted processing resumes only
the remaining assigned events without redistributing the pool. Risk-held
usage remains locked and its command stays retryable.

Validation uses the actual owner and complete migrated SQLite schema, with
financial fixtures that isolate transaction behavior. It injects write
failures, lost commit responses, actor substitution and owner restarts.
Existing paid settlement and thirteen-boundary refund reversal tests execute
the moved private algorithms rather than restoring a shared-D1 bypass.
These tests do not certify production foreign-key fixtures, Stripe LIVE,
real payout-provider settlement, legal evidence, customer access or D1
transport. The owner remains restricted to existing isolated QA primary IDs
and expiring leases. All production gates remain unchanged.

Do not merge this stacked draft or enable production ownership on this
evidence. Production still needs all writer families migrated, real legal
and provider proof, deployed exclusive D1 privileges, customer-access tests,
performance acceptance and protected rollback rehearsal. Rollback during QA
means stopping the isolated caller/lease and retrying pending commands after
the corrected owner is redeployed; do not reactivate retired shared writes
or erase the persistent command journal. Production routing and credentials
are not changed by this branch.

Validation on this branch: exact 141-site reconciliation (92 owner-required,
25 unchanged non-authorizing, 23 unchanged private QA and one fixture),
TypeScript, the lint baseline with zero new error groups, private owner and
public forwarding tests, existing 60-boundary paid settlement and 13-boundary
refund reversal tests, finance/pricing, risk/tax and creator-commerce checks.
The existing publishing regression fails its quarantine-storage source
assertion, and notification regression fails its publisher-approval source
assertion; both identical failures reproduce on the unmodified base commit
354ae169e5d3876996e9edcdd1be955603c44a15. These broader checks remain red and
are not represented as production acceptance.
All 45 local commands from the canonical-writer owner-audit workflow pass,
including the updated private-only refund and settlement test harnesses.
