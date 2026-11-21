# Cove positive legal-owner publication — isolated source evidence only

**NO-GO. This is not the production owner-activation or catalog-authorization PR.**

This ports the previously reviewed, unmerged source-revision CAS research from
PRs #695, #696 and #700 onto *current main* for independently enforced CI.
Earlier stacked branches had stale bases, unmerged workflows and synthetic
fixtures. This is not a cutover.

The draft implementation in
`src/features/fore/owner-positive-retail.stage.ts` invokes Cove's actual
`resolveProductRights`, requiring active retail rights, contract/version,
language, territory and DRM decisions, valid current offers and known expiry
boundaries. A single SQLite `INSERT ... SELECT` rechecks owner, source,
territory, market and fallback revisions, canonical legal VIEW membership,
the offer and primary-D1 date skew. Stage fixture triggers invalidate
positives transactionally on covered source mutations.

The credential-free pull-request workflow
`cove-isolated-owner-positive-proof` now exercises:
- SQL source-family invalidation and rollback/regrant races,
- a source-revision CAS against competing grants, offers and withdrawals,
- the **real TypeScript rights resolver** against isolated contracts,
  language, DRM, territorial, explicit-denial and expiry cases,
- primary D1-clock skew and short-lived offer/rights leases,
- current source dependency inventory and isolated point-read checks,
- strict TypeScript compilation.

**The stage writer is not deployed and is not imported by customer routes.**
The synthetic positive view is not an independent owner authorization.
It MUST NOT clear the dirty negative-only publication fence merged in PR
#806. There is NO proof the test fixture represents all rights in the
82,247-book production catalog. It also cannot prevent a withdrawal
acknowledged by the separate legal-owner Durable Object while D1 remains
unreconciled: the reader MUST independently query the current owner and
deny a stale primary generation. Positive publication will require an
owner-signed/equivalent authorizing receipt, catalog checksum/lineage,
full-catalog parity, all legal mutation families and a same-transaction
primary owner CAS before any servicing or cache use.

Production release blockers remain exclusive physical D1 and API-token
write principals, legally current full-catalog positive publication,
real storefront 503 elimination, Stripe LIVE settlement/refund/revocation,
strict ORD/LAX/IAD/DFW and 100-RPS p95/p99/max capacity acceptance,
and protected rollback. **Do not enable production rights owner or
activate any traffic based on a green synthetic proof.**
