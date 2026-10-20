# Hosted isolated literary preparation milestone (October 20, 2026)

## Proof of physical separation, not storefront-load certification

New opt-in `literary-prepare` role in the content Worker and independent
`CONTENT_DB` job queue `literary_prepare_jobs`, with one atomic lease per
minute, bounded retries and private R2 evidence, were exercised in
two-D1 hosted staging against a **synthetic AU-only Gutenberg EPUB**.

Actual Cloudflare Actions executions:
- Initial real EPUB + primary/secondary D1 + R2 smoke:
  https://github.com/JibrilMohamud/cove/actions/runs/39482056990
- Repeated smoke with **explicit active AU deny precedence**, followed
  by an independent grant revocation check:
  https://github.com/JibrilMohamud/cove/actions/runs/39483222142

The latter Worker reported:
`{"pass":true,"prepared":true,"sections":1,"revokedRejected":true}`.
This was a real EPUB ZIP/OPF/spine extraction using private R2 and actual
separate D1 bindings. Private output was metadata/evidence only and was
**never a customer-served profile**. An active retail allow grant was
required before and after source extraction. A source-matched deny
overrode an allow; later revocation prevented new preparation. The
local real-SQL regression also forced revocation DURING an R2 read and
proved no prepared evidence was then published.

Resources (all nonproduction):
- Fixture source/rights D1 `cove-content-repair-stage-20261020`.
- Distinct queue/ledger D1 `cove-literary-budget-stage-20261020`.
- Private R2 `cove-content-repair-stage-20261020`.
- Protected ephemeral Worker
  `cove-literary-preparation-smoke-20261020`.

Temporary Workers were deleted after both runs. Synthetic source, product,
edition and grant fixtures, R2 EPUB/evidence objects and secondary queue
entries were removed by the stage Worker. A post-run direct audit verified
no lingering source fixture, queue rows or temporary Worker. The
temporary smoke source and workflow were deleted from the release PR
after the tests passed.

Independent regression covers:
- Disabled-by-default role and off-switch.
- Double enqueue/idempotency of pinned content versions.
- Atomic independent claim, retry limit, expiry and terminal failure.
- Actual byte-level SHA and EPUB structure.
- No primary D1 writes from enqueue or extraction.
- Explicit live rights denial and revocation during private-R2 reading.
- Reject CONTENT_DB with any rights/catalog/commerce authority tables.

## Missing commercial-release evidence

Do **not** conflate this with full migration of literary inference.
The legacy literary job queue, R2 evidence flow, existing chapter
publication and catalog-writing EPUB ingester still run on primary D1.
This new private preparation result is not yet imported into
`literary_profile_jobs` or publicly served, and there is no
production-approved secondary queue seeder/outbox.

Before enabling production:
1. Durable primary-to-secondary handoff; identify stale/duplicate
   fingerprints and backpressure without a cross-DB transaction.
2. Final primary-D1 publisher with current rights, explicit denial
   precedence, current content fingerprint and immutable R2 result
   validation before any customer-visible state.
3. Real multi-region authenticated retailer/reader/checkout/offline
   and music rights/revocation journeys.
4. Sustained mixed 25/50/100 RPS traffic and independent 1/4/8/16/32
   bursts, cold deployments, mobile p75 LCP, 1,000 concurrent
   listeners and D1 overloaded/503 absence, with ingestion running.
5. Explicit music master/performer/composition approvals and focus
   suitability review; automated quiet screens are not legal approval.

Release state: DRAFT/UNMERGED. No production database mutation, new
customer authorization, background activation or routing change.
