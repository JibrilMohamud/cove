# Correct serving-version evidence before certifying Cove

Status: **NO-GO**. Source remediation and read-only observations on November 17,
2026 do not establish release certification.

## Defect and corrective behavior

The physical D1 audit previously read `/workers/scripts/{name}/settings`.
Cloudflare settings describe the latest uploaded revision, which may be unserved.
An uploaded revision without D1 could hide an older or 1%-traffic native writer.

The audit now reads `/deployments`, every immutable `/versions/{id}`, and the
allocation again. All percentages must be positive and sum to 100%; version IDs,
bindings and allocation identity must be complete and consistent. All serving
versions contribute bindings. A mixed-version legal owner fails certification.
An observed deployment change fails closed. The existing whole-inventory Worker
revision check remains. These reads are not an atomic provider snapshot.

When the metadata credential lacks immutable-version access, install an independent
`COVE_CF_WORKERS_CONTENT_READ_TOKEN` in the protected
`cove-production-release-audit` environment, with Workers **Content Read-Only**
for all inventoried Workers. Metadata Read-Only cannot retrieve immutable script
versions. If the metadata credential already has Content Read, it can satisfy
that read without a redundant token. Never substitute the mutation-capable stage
deploy token. The workflow retains three required credentials, optional independent
Content Read, manual main-SHA approval and the
exclusive audit lock, and permits 55 minutes for the additional reads. The shared
transport still starts at most two requests per second, caps 429 waits at three
minutes, allows only exact GET metadata paths, and stops after 3,000 requests.

## Principal coverage without a manual bypass

The all-principal result was previously hardcoded false. It can now become true
only for an independently verified single-member account: complete unfiltered
account membership, exactly one accepted member, issuing `/user` ID matching that
member, and identical membership on a second read. Zero, multiple, pending,
partial, mismatched, unreadable or changed membership remains blocked. This is
separate from the current user's strict token-safety result; privileged tokens
still block certification even with matched principal coverage.

The account-token inventory credential requires **Account Settings Read** as well
as **Account API Tokens Read** to read membership. The user-token inventory
credential requires **User Details Read** as well as **API Tokens Read** to prove
its issuing identity. All are read permissions. Missing permissions produce fixed
reason codes, never success or an operator-set coverage flag. No identities or
credentials are emitted. Multi-member accounts still require additional design
and independent per-member evidence.

## Fresh observations, distinct from a full protected certificate

Provider readback of immutable serving versions confirmed:

- Production persistence version `401f2af2-6e69-4611-8110-1d127af6eecf` remains
  at 100% and retains a native production D1 binding.
- Production legal-owner version `3463ff93-f077-40bf-a4d5-fb7bfc143cd5` remains
  at 100%, with its production D1 binding and `COVE_RIGHTS_OWNER_ENABLED=0`.
- Both isolated phase Workers remain at their recorded parked versions, each
  at 100% with zero deployed bindings.
- `covereads.com` and `www.covereads.com` both point to
  `dpl_HrWWUHUhMkDQjbFmZ5TW8g8dHWBr`.
- GitHub's connected integration returned HTTP 403 for main branch protection.
  That establishes insufficient read access, not absence or presence of protection.
- Cloudflare's connected session proved one complete accepted member, matched
  the issuing user identity, and observed unchanged membership on a second read.
  The separately scoped protected credentials have not yet established that proof.
- Cove's connected Stripe LIVE account returned no successful PaymentIntents in
  its search and an empty refund list (`has_more:false`). This supplies no LIVE
  fulfillment/refund/revocation witness; no charge or refund was created.

A bounded connector-mediated transport diagnostic compared D1 `/query` and the
supported `/raw` API on parameterized constant SELECTs at 1/4/8/16/32 concurrent
requests. All returned correct primary-only results with zero rows written, but
`/raw` showed no consistent advantage. At 32 requests the connector-inclusive
maxima were 1,936 ms (`/query`) and 1,995 ms (`/raw`); SQL maxima were under 0.5 ms.
This includes connector overhead and is neither Worker phase attribution nor
storefront, geographic or 100-RPS certification. No serving transport was changed
on that evidence. Do not infer that these numbers identify a provider bottleneck.

Protected storefront phase run #96 remains a real failure: its 32-wave maximum
was 1,165 ms and p95 1,005 ms. Keep the original hard 800 ms gate. Current customer
503 elimination, complete legal authority, physical writer retirement, Stripe
LIVE fulfillment/refund/revocation, four-region/100-RPS, branch protection and
protected production rollback remain independently unpassed.

## Validation and promotion

Run the workflow's credential-free audit suite and self-test. Regression fixtures
cover hidden 1% writers, unserved upload distinction, deployment drift, malformed
immutable metadata and allocations, mixed owners, issuing identity mismatch,
multi/pending/incomplete members, missing scope and privacy-safe denial reasons.
PR CI does not dispatch a live audit or change production. A manual live audit
requires the exact reviewed main SHA plus the protected read credentials above.

Local validation: 81 release regression tests passed, the physical audit self-test
passed, the Vercel source guard's two tests passed, and formatting/diff checks passed.
