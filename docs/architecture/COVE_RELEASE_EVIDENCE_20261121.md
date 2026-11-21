# Cove release evidence: November 21, 2026

Release decision: **NO-GO**. Source tests and inventory collection are not
production certification. Performance acceptance remains unchanged and was
deferred behind legal, correctness, commerce and rollback work.

## Verified protected source progress

- PR #782 merged at `aa7c049f22feb4e92f514875471895bf91e6c612` after
  security, unchanged dependency audit/supply-chain, CodeQL, six browser
  checks and NVDA passed. Its permission-ID alias proof was not sufficient
  to clear the subsequent live user-token inventory; see the exact result
  below. No passing user-token assertion is inferred from source CI.
- PR #795 merged at `41c3419b42cc4eeeb3ffa473b4eb5ad8236eafe7` after
  refreshing main and repeating all applicable/required checks. The actual
  QA owner now has opt-in, transactional SQL mutation evidence over all 24
  SQL tables. Genuine handlers and pinned workerd test seven denial paths,
  failed-batch rollback, durable denial before failed D1 reconciliation,
  damaged-history refusal and restart persistence. Receipts always say
  `authorizing:false`; historical production enrollment, version-bound
  serving proof, time horizons and D1 publication/CAS remain incomplete.
- PR #704 was updated without rewriting published history, retaining the
  real canonical resolver and bounding commercial proofs by upcoming legal,
  contract/version/language/offer/release transitions. Its 17-case local
  canonical suite and the new journal suite pass together. Exact final-head
  CI and a separate promotion decision are required; this document does not
  claim it is deployed or production-certified.

## Physical writer audit: protected run 66

[Run 44939966262](https://github.com/JibrilMohamud/cove/actions/runs/44939966262)
completed inventory and failed certification on exact source
`aa7c049f22feb4e92f514875471895bf91e6c612`. It inspected **460 current
immutable serving versions**, made **1,390 metadata GETs**, and reported
**zero rate-limited calls**. It made no D1 SQL requests or mutations.

The primary D1 has exactly two detected native Worker bindings: the disabled
`cove-legal-authority-production` and competing `cove-persistence-backend`.
Single-member/issuing-user identity coverage passed. User token permissions
still failed with `active_user_token_permission_unreviewed`; this does not
establish that they are writable or safe.

Account mutation-capable names in the report are
`COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN`, `Cove GitHub Deployments`, and
`Cove Protected Worker Version Upload`. A purpose label or protected CI job
is not proof of provider-enforced resource isolation. Unreviewed account
permission metadata also remains blocked. Legitimate scheduled consumers
and other projects must be migrated/scoped before privileged credentials
can safely be retired. No credential was changed or revoked.

The catalog-alias failure is too coarse to identify whether the provider
refused a catalog read, returned a different name/scope/page, or returned an
unmatched ID. A separate protected **user-token-only diagnostic** now reports
only fixed categories and never certifies release or principal coverage.
It avoids another 1,390-request Worker inventory to inspect that one issue.
All catalog shape, exact name, stable ID, scope and page checks are retained;
unknown/mutation permissions still block.

## Production incident and commerce

Protected [incident run 19](https://github.com/JibrilMohamud/cove/actions/runs/44939295344)
verified the serving backend version and found **3 handled HTTP 503 among
11 fetches** in `2026-11-21T16:15:00Z`–`16:25:00Z`, with no uncaught
invocation errors in that particular cohort. The collector used four
metadata/analytics requests, no production SQL and no customer probes.
This repeats the known incident; aggregate D1 activity is not per-request
causal evidence. Source mitigations have not been deployed to the backend.

Read-only Stripe LIVE checks found one enabled production webhook,
**zero PaymentIntents**, and no matching payment/refund/dispute events in
Stripe's retrievable event window. No payment/refund, webhook configuration
or customer entitlement was changed. LIVE fulfillment/refund/revocation
therefore remains unproved.

Both customer aliases were independently verified still pinned to Vercel
`dpl_HrWWUHUhMkDQjbFmZ5TW8g8dHWBr`. Production owner is disabled and
customer backend deployment remains pinned. The new QA journal adds no SQL
to default customer serving. No performance thresholds were weakened or
production load tests run.

## Mandatory outstanding proofs

Exclusive legal/native/token/source writers; current independently version-
bound production owner denial and publication fencing; legally current
full-catalog rights/search/count/facet/pagination parity; deployed and
verified 503/500 elimination; LIVE settlement through protected media and
refund/revocation; an actual production-compatible protected rollback; then
unchanged strict ORD/LAX/IAD/DFW cold/warm/concurrency and two 20-second
100-RPS phases. Historical toy rollback or skipped protected workflows do
not count as these proofs.
