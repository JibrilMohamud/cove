# Cove staging legal-view differential — protected, incomplete by default

**Release decision: NO-GO. This tool cannot certify any production title.**

The older unmerged real-D1 differential (#696) could report PASS on 12–48
selected synthetic books even if no sampled product exercised contract
versions, contract languages or nontrivial DRM. That is not sufficient
evidence to activate the rights materializer.

This new **read-only synthetic D1** audit uses Cove's actual
`resolveProductRights` TypeScript resolver, at a single recorded UTC
instant, and compares it to the **actual staging D1**
`retail_product_availability_rows` view for US retail on at most 48
selected synthetic products. It discovers distinct contract-version,
contract-language, nontrivial-DRM, contract-bound, explicit-deny and
ranked cohorts. It fails if **any** required cohort is missing or if
any positive differs in either direction. It additionally requires
both allowed and denied decisions and exact sample accounting.

Read-only QA introspection, November 21/22, 2026 UTC, confirmed:
- Synthetic D1 identity `e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3` has
  products, grants, contracts, languages and the retail legal view.
- Synthetic products with the expected `perf-synth-` prefix exist.
- **No** sample from that prefix currently joins to a contract version,
  joins to a contract language, or has a nontrivial DRM requirement.

Accordingly the current staging dataset does NOT cover mandatory
rights-policy strata. A protected audit using these data must fail
closed; seeding missing synthetic cases requires independently reviewed,
isolated staging changes, not production permissions or fabricated
historical rights.

## Protected workflow

`cove-protected-stage-canonical-rights-differential`:
- On a PR, runs offline tests only; no credentials, network, Cloudflare
  queries or mutations. Tests prove required cohort coverage and
  read-only source lockouts, and run current contract-denial fixtures.
- For an explicitly reviewed **main** SHA, accepts only a manually
  initiated `workflow_dispatch` with `confirm=STAGE_RIGHTS_DIFF`
  and exact `reviewed_main_sha=github.sha`, through the existing
  protected `cove-production-release-audit` environment.
- Uses a **separate** `COVE_CF_STAGE_D1_READ_TOKEN` environment secret
  with D1 Read permissions only. Cloudflare account token policy resource wildcard `*` can include all D1 databases; **the code**, not the token resource policy, pins the isolated synthetic D1 ID. It refuses the broad deployment token
  and refuses production D1 identity. An active account token with this name and D1 Read was seen in read-only Cloudflare inventory; its presence as a GitHub Environment secret is not yet verified.
- All D1 SQL is bounded, paced at 75 ms between queries, limited to
  1,400 invocations, single-statement SELECT/WITH only, and refuses any
  unexpected write metadata. It logs only aggregate counts, generic
  policy cohorts and generic denial-reason classes.
- No D1 table creation, Worker deployment, routing, legal-owner toggle,
  scheduled job, credential mutation or Stripe API interaction occurs.

Even if the protected synthetic audit passes after representative
fixtures are added, it does NOT establish historical/full-catalog
parity, 82,247-book provenance, a production owner authorizing receipt,
independent current denial fences, exclusive writers, real 503
resolution, LIVE commerce, strict geographic/100RPS performance, or
rollback certification. `fullProductionRightsParityCertified` is
always false.

The next protected legal work is to certify the production legal owner
and immutable current dataset, compare *all* legal decisions/expiry
windows against canonical source and primary D1 under strict rate
control, prove atomic positive publication with owner current-epoch
and explicit withdrawal linearization, and only then retire competing
writers. No customer authorization relies on this tool.
