# Cove rightsholder disputes and copyright operations

Cove treats copyright/rightsholder enforcement as an operational workflow, not as a complaint table. This document describes the v1 implementation and the production obligations around it.

> This architecture supports a notice-and-takedown program; it does not, by itself, create or guarantee any statutory safe harbor. Cove must separately maintain the legally required designated-agent registration/contact information, trained staff, response procedures, record retention, and jurisdiction-specific legal review.

## Publisher rights declaration

Every publishable revision signs an immutable `publishing_rights_declarations` record under `fore-rights-v1`. The declaration captures:

- rights basis (`owned`, `licensed`, or `public_domain`);
- authority type and named rights owner;
- source-work identifiers;
- territorial scope and optional rights term;
- authority, non-infringement, and evidence-completeness attestations;
- signer, account, edition revision, policy version, and signature time.

The signature is revision-specific. A publisher cannot silently rewrite a signed declaration; changing it requires a new publishing revision.

Licensed and public-domain claims require at least one clean, staff-verified supporting evidence record before submission; merely uploading a document is not enough. Evidence is stored privately, hash-addressed, malware/security scanned, and separately reviewed by authorized staff. Staff download is allowed only after a clean scan and uses no-store/nosniff/sandbox response headers. Evidence identity and uploaded bytes are immutable; review status may change as staff verifies, rejects, or marks evidence insufficient.

## Copyright notice intake

The public `/copyright` page posts to `POST /api/fore/rights/copyright-notice` (with compatibility at `/moderation/copyright-complaint`) and accepts a structured notice rather than a free-form complaint. Reported Cove URLs are resolved server-side to an actual publishing subject; unresolvable/non-Cove URLs are rejected rather than creating a detached dispute. For the U.S. DMCA path it records:

- claimant/contact information;
- represented party, if any;
- identification of copyrighted works;
- identification/location of challenged material;
- Cove URL or server-resolved publishing subject;
- asserted rights basis;
- good-faith, accuracy/perjury, and authority attestations;
- electronic signature.

A received notice opens both a moderation case and a `rights_disputes` workflow. Intake is rate-limited and the subject/publisher relationship is resolved server-side so a complainant cannot attach an arbitrary publisher account.

Receipt is **not** a legal finding. Staff with `rights.notice.validate` must classify it as:

1. `needs_info` — claimant is asked for missing information;
2. `noncompliant` — notice is closed without takedown, with reason/audit evidence; or
3. `compliant_takedown` — challenged storefront material is disabled and the dispute advances.

All transitions append `rights_dispute_events` and notification jobs.

## Takedown and royalty freeze

A validated takedown:

- moves the applicable Cove release into the enforcement `takedown` state;
- stores the previous lifecycle state for a possible lawful restoration;
- disables affected storefront products;
- creates product-scoped `royalty_holds`;
- moves accrued/payable affected royalty events to `held`;
- prevents pending held payout items from settlement;
- causes new royalties for the held product to accrue as `held`;
- leaves unrelated products and royalties untouched.

Overlapping claims are hold-aware: resolving one dispute does not release or reactivate a product that is still covered by another active hold. A copyright decision does **not** automatically transfer or forfeit the frozen money. No-infringement/claimant-withdrawal resolutions release it. Confirmed infringement defaults to continued quarantine until an authorized finance/legal disposition is recorded outside the copyright shortcut. This avoids conflating a content decision with ownership of money.

## Counter-notice and restoration window

For disputes marked `us_dmca`, an eligible publisher admin can submit a structured counter-notice after takedown. It records:

- subscriber name/address/phone;
- removed material and former location;
- mistake/misidentification statement under penalty of perjury;
- jurisdiction consent;
- service-of-process consent;
- signature and supporting statement.

Staff with `rights.counter_notice.validate` can request more information, reject the counter-notice, or validate/forward it to the claimant. A corrected submission after `needs_info` creates a new record and marks the old one closed rather than rewriting history.

The U.S. restoration timer is calculated from **receipt of the counter-notice**, not from the later staff-validation time. Cove computes 10- and 14-business-day boundaries, skipping weekends and observed U.S. federal holidays. A worker (`/publishing-worker/rights/deadlines`) restores eligible content at the not-before point if Cove has not recorded a qualifying court action.

## Court-action hold

Authorized staff can record a claimant/publisher/other court filing with court, case number, filing date, and evidence/docket reference. The immutable `copyright_court_actions` row is linked to the dispute and mirrored into the append-only dispute event log.

Recording a qualifying action:

- moves the dispute to `litigation_hold`;
- disables automatic counter-notice restoration;
- notifies both claimant and publisher;
- preserves the royalty hold until a later authorized resolution.

## Resolution and repeat-infringer policy

Staff resolution supports no infringement, claimant withdrawal, confirmed infringement, court order, settlement, and other documented outcomes. Confirmed infringement and court-order outcomes create immutable infringement incidents.

`fore-repeat-infringer-v1` currently uses cumulative active strike points:

- 0–2: normal;
- 3–5: warning;
- 6–8: publishing account restricted;
- 9+: termination review.

A confirmed infringement is 3 points; a court order is 5. Incidents can later be marked overturned without deleting their audit history. Expired/overturned incidents stop contributing active points.

Termination is deliberately **human gated**. Reaching 9 points does not automatically delete an account. A staff member with `rights.repeat_infringer.manage` must review the history and explicitly terminate publishing access. Termination closes publishing privileges, takes down all releases, disables storefront products, and appends lifecycle/audit evidence.

## Fingerprints, duplicate works, and similarity

Every qualifying publishing asset version receives immutable fingerprint evidence:

- exact SHA-256;
- normalized-text SHA-256;
- a 64-bit SimHash for approximate textual similarity;
- four indexed 16-bit SimHash bands for candidate retrieval.

The band indexes avoid an unbounded full-catalog scan. Candidate matches are scored and written to `publishing_similarity_matches`. High-confidence cross-publisher matches can block automated publication pending review; same-publisher near duplicates can contribute a low-value derivative/spam signal.

Fingerprint/similarity matches are **review signals, not copyright findings**. Authorized overlap, licensed editions, public-domain editions, quotations, translations, or legitimate revisions can be cleared by staff.

## Suspicious publisher clusters

Cove builds account-risk edges from multiple signals such as:

- shared non-public contact domains (weak);
- a shared owner/admin controller (stronger);
- shared finance party (strong);
- shared rights party (strong);
- repeated confirmed impersonation relationships.

A weak shared-email-domain signal by itself cannot create a fraud cluster. Pair scores are aggregated and clusters are surfaced only above the configured review threshold. Staff can clear, monitor, or confirm a cluster. Cluster membership is an investigation aid, not an automatic fraud finding.

## Impersonation

Publisher names and pen names are compared with existing publisher/contributor identities. High-similarity names create review records. Staff can mark them cleared/authorized or confirm impersonation. Confirmed cases open moderation work and can also add risk-graph evidence against repeated targeting patterns.

## Workers and notifications

Publishing workers authenticate with a scoped service-principal credential stored in the worker secret manager as `FORE_SERVICE_TOKEN` and run separate operational queues:

- `/publishing-worker/rights/evidence/lease`
- `/publishing-worker/rights/evidence/complete`
- `/publishing-worker/rights/notifications/lease`
- `/publishing-worker/rights/notifications/complete`
- `/publishing-worker/rights/deadlines`

Notification jobs are durable, leaseable, retry-bounded, and cover notice receipt, missing-information requests, noncompliance, takedown, counter-notice events, court action, restoration, and resolution. Production notification providers must persist provider message IDs and treat legal-notice delivery failures as an operations alert, not as a silently dropped email.

## Operational controls still required outside code

Before a production launch, Cove should have counsel/operations establish:

- designated copyright/DMCA agent registration where applicable, and configure `FORE_DMCA_AGENT_NAME`, `FORE_DMCA_AGENT_EMAIL`, `FORE_DMCA_AGENT_ADDRESS`, and optional phone so `/copyright` publishes matching contact information;
- monitored legal inbox and escalation/on-call ownership;
- identity/authenticity checks for suspicious notices and counter-notices;
- subpoena/litigation preservation procedures;
- repeat-infringer policy publication and consistent application;
- privacy/retention policy for claimant addresses, phone numbers, contracts, and evidence;
- accounting policy for long-lived disputed funds and legally ordered dispositions;
- jurisdiction-specific workflows outside the U.S. DMCA path;
- reviewer training, QA sampling, and appeal/error-rate metrics.
