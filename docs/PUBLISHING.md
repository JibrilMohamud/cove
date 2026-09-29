# Cove Publishing architecture

Cove Publishing is a controlled supply chain in front of Cove's retail catalog. A creator upload is **not** a catalog asset, and saving a creator draft never makes content public.

## Publication lifecycle

Every publishing edition has a release lifecycle:

`draft → validation → submitted → automated_review → human_review (when required) → approved → scheduled/preorder → live → updated`

Staff enforcement can move a release to `suppressed`, `takedown`, or `retired`. A suppressed/taken-down release keeps its evidence and version history; it is not deleted.

The lifecycle is stored in `publishing_release_lifecycles`, and every transition is appended to `publishing_lifecycle_events`. Lifecycle history is append-only. Low-risk automated approval is opt-in through `FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK=true`; production can keep it disabled to require a human review of every submission.

## Immutable submission and publication history

Cove has two separate immutable layers:

1. **Submission snapshot.** Submission freezes publisher/compliance state, metadata, contributors, rights selections and exact uploaded asset hashes into `publishing_submission_snapshots`. Staff reviews this evidence, never a mutable draft.
2. **Publication version.** Each approved/materialized revision creates a `publishing_publication_versions` row with a stable manifest containing the catalog work/edition/product IDs, exact catalog asset-version IDs, metadata/relationships, rights/royalty/offer IDs and the source submission hash. Publication-version rows cannot be updated or deleted.

Assets are never overwritten in place. A new EPUB/cover becomes a new `asset_versions` record. Scheduled updates are staged as `pending_publication_version_id`; current customer-visible metadata, contributor/category/series relationships, price, and assets switch together only when the new version activates. The staged version's rights grants/contracts and royalty contract remain `draft`, and its offer remains inactive, until activation. Activation re-checks blocking rights conflicts against the then-current catalog, retires/revokes the superseded commercial terms, activates the new terms, and writes an append-only `publishing_publication_activations` record.

Rollback activates an older immutable manifest; it does not rewrite history. The rollback is appended to lifecycle/audit history and the activation ledger. Rollback is blocked while a release is `suppressed`, `takedown`, or `retired`; staff must explicitly restore the release through moderation before an older version can serve again.

## What existing owners receive

The default policy is **`auto_update`**: after an approved v7 activates, existing owners resolve the current catalog asset and receive v7 without repurchasing. This matches the expected normal bookstore behavior while keeping v1–v6 available for audit and rollback.

Publishers can instead select:

- **`manual_opt_in`** — purchase entitlements are pinned to the version owned at acquisition; an owner can explicitly opt into the current approved version through `/api/fore/library/publication-update`.
- **`preserve_purchased_version`** — purchase entitlements stay pinned to the acquired publication version.

Pins live in `publishing_entitlement_version_pins`; changes are recorded in append-only `publishing_owner_version_events`. Switching a live title from auto-update to a pinning policy backfills pins for current purchase entitlements at the then-current version so a later update does not silently move them.

## Security and creator boundaries

1. **Publisher organization** — person/company identity is distinct from public publisher/imprint/pen names. Organization roles separate owner/admin/editor/finance/analyst authority.
2. **Compliance providers** — identity, tax and payout integrations store provider references/status only. Cove must not store raw government-ID material, tax identifiers/forms, or bank credentials.
3. **Draft catalog** — metadata, rights, price, DRM and release settings remain in publishing tables until an approved version materializes/activates.
4. **Quarantine assets** — uploads are bounded and stored under `publishing/quarantine/...`; published revisions must be reopened before assets can be replaced.
5. **Validation queue** — jobs are idempotent, leased, retry-bounded and horizontally scalable.
6. **Fail closed** — required production validators (malware, EPUBCheck, render/device compatibility, etc.) must explicitly pass before readiness succeeds.

## Automated and human review

Submission runs `fore-trust-v2` automated review and stores immutable `publishing_automated_reviews` evidence. Current signals include duplicate/fraud holds, account restrictions, active sanctions/strike points, repeat-offender case patterns, immutable rights evidence, the versioned AI-content assessment, cross-publisher content similarity, publisher-risk clusters, identity/impersonation similarity, and repeat-infringer policy state. Outcomes are `pass`, `review`, or `block`. Similarity and AI signals route human review; they are not automatic copyright findings.

A `review`/`block` creates a moderation case and detector signals. A `pass` either advances to human review or, only when the deployment explicitly enables low-risk automatic approval, advances through approval/materialization.

## Staff identity, SSO, MFA and RBAC

Routine staff APIs do **not** accept `FORE_PUBLISHING_ADMIN_TOKEN` or any equivalent shared publishing credential.

Staff identities are provisioned in `staff_principals` and can be bound to an SSO provider + provider subject. `mfa_required=1` requires an AAL2 authenticated session. Roles are many-to-many and permissions are explicit (`publishing.review`, `publishing.rollback`, `moderation.takedown`, `moderation.emergency_suppress`, `moderation.appeal.decide`, etc.).

`FORE_STAFF_BOOTSTRAP_TOKEN` exists only for the narrowly scoped `/api/fore/admin/staff/bootstrap` provisioning/break-glass endpoint. It should be isolated and rotated; it is not accepted by normal publishing/moderation routes.

`/staff/publishing` uses the signed-in staff identity and shows publishing review, release versions/rollback, moderation queues, appeals, copyright notices, sanctions, duplicate/fraud review, validator state, and—when the staff member has `staff.manage`—staff identities/access state. Staff provisioning, role changes, suspension, reactivation and disablement are recorded in append-only `staff_audit_events`.

## Moderation case system

`moderation_cases` is the shared workflow for review/title/author/publisher/copyright/fraud/impersonation/publishing queues. It supports priority, SLA due time, assignment, status, risk score and source deduplication.

Evidence and operations include:

- append-only user reports and automated detector signals;
- append-only moderator notes;
- explicit moderation actions and rationale;
- publisher warnings/restrictions/suspensions with strike points;
- emergency suppression, takedown, retirement and restoration;
- copyright complaints and copyright-specific takedown/restore actions;
- scam/duplicate/repeat-offender signals;
- impersonation reports and removal actions;
- appeals routed to a dedicated appeals queue, with publisher-side appeal submission limited to publisher-owned cases and reversible actions;
- server-resolved publisher ownership for reports/complaints so a client cannot attach an arbitrary publisher account to a subject;
- audit/lifecycle history for enforcement affecting a release.

Submission approval/rejection intentionally remains in the publishing-review workflow rather than being faked as a generic moderation action; this preserves immutable submission-review evidence and idempotent materialization guarantees.

## Worker contract

Workers authenticate with `FORE_SERVICE_TOKEN`.

- `POST /api/fore/publishing-worker/jobs/lease` leases validation jobs.
- `POST /api/fore/publishing-worker/jobs/complete` records validator/version/status/issues and optional report evidence.
- `POST /api/fore/publishing-worker/releases/tick` activates due scheduled/preorder publication versions.
- `POST /api/fore/publishing-worker/rights/deadlines` advances eligible counter-notice restoration windows.
- `POST /api/fore/publishing-worker/rights/evidence/lease|complete` runs private rights-evidence security scanning.
- `POST /api/fore/publishing-worker/rights/notifications/lease|complete` delivers durable legal/rightsholder notifications with retries.

Quarantine objects remain private to worker/object-storage credentials. Required checks must reach `passed`; unavailable required validators never become implicit approvals.

## Rights, copyright disputes, and AI-content policy

Publisher revisions must sign versioned immutable rights and AI-content declarations before submission. Licensed/public-domain claims require evidence; generated/mixed narration requires a customer-facing synthetic-voice label. Approved publication versions freeze their AI disclosure and public badges in `publishing_publication_disclosures`. Active policy metadata is exposed through `GET /api/fore/publishing/policies`.

Copyright operations include structured notice intake, staff validation, takedown, scoped royalty freezes, counter-notices, 10–14 business-day U.S. restoration windows, immutable court-action evidence/litigation holds, durable notifications, human-gated repeat-infringer termination, content fingerprints/near-duplicate review, suspicious publisher clusters, and impersonation review.

See `docs/RIGHTSHOLDER_DISPUTES.md` for the operational/legal workflow and `docs/AI_CONTENT_POLICY.md` for Cove's explicit v1 AI policy.

## Provider adapters

Do not put identity documents, tax numbers/forms or bank credentials in Cove API payloads. Production adapters should tokenize/redirect sensitive fields, verify provider callbacks, then pass only reference IDs, outcome/status, withholding/requirements, payout currency/method and masked display metadata into Cove.

## Deliberately fail-closed

Cove does not pretend KYC/tax/bank verification or third-party production validation occurred when no provider/worker is connected. Those gates remain pending/blocked. This is intentional: creator content cannot become sellable by bypassing unavailable compliance or validation infrastructure.
