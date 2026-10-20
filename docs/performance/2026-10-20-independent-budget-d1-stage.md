# First physical content datastore split — hosted proof

Date: October 20, 2026. Purpose: move literary inference **quota
reservation accounting** to an independent D1 rather than continuing
to contend on the primary rights/catalog/commerce D1.

This is an intentionally limited scope: EPUB ingestion, literary job
leases and literary profile writes **still use primary D1**. Do not
describe this as whole-service separation or proof of 100-RPS readiness.

## Staging resources only

- Separate synthetic catalog/rights fixture DB:
  `cove-content-repair-stage-20261020`
  (`dbcc0d95-8ca2-4036-ad78-49dbc0ee4b38`).
- Dedicated independent literary budget D1:
  `cove-literary-budget-stage-20261020`
  (`7a26c27d-966c-468a-a3ad-d06cfff68010`), created on this date.
- Separate minimal ledger schema:
  `infra/content-budget/0001_ledger.sql`. Staging had two independent
  bindings `DB` and `CONTENT_DB`. Neither binding referenced the real
  Cove production D1 or production R2.
- Ephemeral protected Worker `cove-literary-budget-domain-smoke-20261020`
  deployed temporarily and **deleted after verification**, with no cron
  trigger, customer data or production secrets apart from a short-lived
  test token in its own namespace.
- Actual Actions result:
  https://github.com/JibrilMohamud/cove/actions/runs/39477962902

## Exact result

Stage primary ledger was seeded at `170 reserved_units, 2 calls`.
The primary's `cove_runtime_config.literary_budget_domain` fence was set
to `isolated` in the **synthetic staging primary only**, and the distinct
content DB was seeded with the same amount and an explicit `active`
cutover row for `2026-10-20`. Maximum staged daily budget was 400 units.

The real Worker:
1. Attempted one legacy primary budget reservation after the primary
   fence: **rejected**.
2. Selected the physically distinct `CONTENT_DB` only after both the
   Worker role/enable flags and primary cutover fence were present.
3. Made five 60-unit requests against the 400-unit seeded secondary
   ledger: **three accepted and two rejected**.
4. Verified the independent ledger ended at **350 reserved units,
   5 calls**, while the primary remained **170 units, 2 calls**.
5. Closed the day in `literary_budget_cutover`; a subsequent reserve
   failed as required.

Actual Worker result:
`{"success":true,"accepted":3,"content":{"reserved_units":350,"calls":5},"primary":{"reserved_units":170,"calls":2}}`.

Separate **post-run direct Cloudflare D1 audit** confirmed exactly those
ledger balances, independent day status `closed`, and no lingering
test Worker.

## Production cutover gate (NOT approved)

- Fully migrate remaining literary claim/preparation/profile-publishing
  writes or prove strict primary-D1 headroom while they execute.
- Verify publisher and rights authorization never read stale cached
  grants and that per-book fingerprints are recomputed on the primary.
- Assert every inference invocation path uses the new primary fencing
  guards; check maintenance, manual/admin endpoints and retries.
- Confirm a safe UTC-day rollover policy and per-day reconciled seed.
- Independently benchmark 60min mixed storefront, rights, checkout,
  EPUB reader and 1,000 listeners at 1/4/8/16/32 concurrent arrivals and
  sustained 25/50/100RPS, with measured cold/TTFB/p95/p99/max and
  mobile p75 LCP. These results are not established by the quota test.
- Human-approve actual composition/master/performer music rights and
  focus suitability before declaring quiet library growth.

New ledger mode remains disabled by default. Cove production D1/runtime
flags, backfill, music approvals, storefront routing and production Worker
deployments were **not changed**.

## Identity-fenced repeat run

After the first hosted proof, the independent schema gained
`literary_budget_domain_identity` with a required
`cove-isolated-literary-budget` domain and schema version 1. Before
authorizing any isolated work, code now asserts the domain identifier and
rejects a bound database containing rights, product or payment-authority
tables, even if someone accidentally copied ledger tables into it.
The actual atomic debit SQL repeats these binding-identity and
no-authority-tables predicates. A regression deliberately contaminates
the secondary database with `rights_grants` and proves both the
preflight and atomic reservation fail closed.

A **second actual Cloudflare Worker** run passed using the updated code
and two physically distinct hosted staging D1 bindings:
https://github.com/JibrilMohamud/cove/actions/runs/39478998958

Result:
`{"success":true,"accepted":3,"content":{"reserved_units":350,"calls":5},"primary":{"reserved_units":170,"calls":2}}`.

The independent staged budget was re-seeded to the same synthetic
opening balance **for this explicitly repeatable test only**. Never reset
a live/production budget to an earlier balance during a real cutover.
The secondary day's control was closed by the test, and the Worker was
deleted. The temporary smoke Worker/workflow were removed from the PR.
