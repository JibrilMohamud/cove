# Authoritative serving and primary-write cutover — release-blocked

Status: **architecture contract only**. Not deployed, not used for customer
authorization, not proof of the <800 ms public HTTP SLA. PR #351 remains draft.

## Evidence, 2026-10-25 / GitHub Actions 40252409966

The third synthetic cold round succeeded, as did all cold rounds (594, 453,
616 ms). The 32-request burst later contained a **valid HTTP 200**, Ray
`a50594bfb9d03ad6-LAX`, in **968.31 ms**. Worker handler: **185 ms**;
primary-D1 service: **181 ms**, SQL: **4.9 ms**; approximately **783 ms** lay
outside the measured Worker handler. The full independent 100-RPS campaign
was not reached. There is no basis for declaring a release pass.

Two separate tail sources require independent solutions:
1. Primary-D1 service time under mixed rights/publication traffic, even when
   SQL is fast and presentations come from independent KV/R2.
2. Edge/HTTP delivery delay outside the Worker, which moving SQL or
   shortening a query cannot fix. Do not classify all external time as D1 time.

## Safe target ownership

Keep candidate ranking, taxonomy, normalized book metadata, FTS, audio work,
and publication preparation **physically outside the rights authority DB**.
Primary D1 retains source/legal evidence, grants, offers, entitlements, and
a minimal fenced publication receipt until a separately certified owner
migration. *Do not disable the legacy `commercialCatalogStatements` owner
until every legal/provenance/publication dependency has a replacement.*

A geographically appropriate strongly consistent authority service (a
Durable Object is one candidate, not yet selected) may eventually serve an
anonymous snapshot of the specifically authorized 24-card homepage. It MUST
NOT merely mirror primary-D1 grants asynchronously and call them current.
No independent D1 read replica, KV TTL, signed R2 document, or stale tombstone
can independently authorize a book.

## Mandatory write/authority protocol

- **Writer closure:** inventory and fence every mutation of source status,
  provenance, evidence, active grant, offer, edition release, market currency,
  and product suppression, including admin/backfill/cron/emergency SQL.
  Requests outside the fenced owner must fail, not fall back to legacy writes.
- **Withdrawal first:** durably record a denial and monotonic source/territory
  generation at the strongly consistent serving authority BEFORE committing
  the corresponding canonical withdrawal. If the second leg fails, keep the
  conservative denial and retry reconciliation. Never wait for an async
  changefeed to hide an exposed grant.
- **Positive grant last:** validate current canonical source, evidence,
  explicit jurisdiction and offer; commit the legal grant before attempting
  a version-fenced serving allowance. An older positive command cannot
  outrun a newer revocation. A missing/unknown generation means deny.
- **Read linearization:** the authorizer must read the current durable state
  from the owner (or a provably equivalent same-owner read), not an
  eventually consistent cross-region cache. Co-located in-memory projection
  is safe only if all writes serialize at that same owner and restart reload
  is fail-closed.
- **Checkout, reader and detail parity:** all customer-facing rights decisions
  must observe the same synchronous denial barrier. An alternate homepage
  authorizer is *not* sufficient while checkout or asset delivery can race it.
- **Rollback:** default to the existing fresh-primary check, or deny if that
  dependency is unavailable. Never switch on the alternate path when the
  source-writer fence is incomplete. Rollback must not resurrect grants from
  stale replicas or caches.

## Required adversarial acceptance (same immutable release SHA)

1. Withdraw a currently visible grant, territory, evidence and source while
   homepage, detail, checkout and delivery requests are in flight; after the
   denial linearization point, **zero** new successful authorizations.
2. Crash between deny-first and primary commit; repair by replay, retaining
   denial. Crash between positive canonical proof and new allowance; continue
   denying until valid replay.
3. Replay reordered, duplicated, missing and lower-revision allow/deny
   messages. Only explicit later legally verified grants may reinstate.
4. Drop DO/authority connection, drain/interrupt a publisher lease, evict an
   isolate, and change regions. All paths fail closed; no stale KV/R2 offer
   becomes available.
5. Prove writer closure under the **real mixed source-ingestion and royalty /
   commerce load**, not just synthetic unrelated D1 writes.
6. Separately test HTTP/2 and HTTP/3 edge delivery, service-handler time,
   Cloudflare Ray, region, and D1 SQL/service duration. Cloudflare-managed
   response tails must be demonstrably absent under the unchanged contract;
   do not hide them by warming or discarding slow sessions.
7. Require three cold rounds under 800 ms, every 1/4/8/16/32-concurrent
   request under 800 ms, and two complete 12,000/12,000-request 100-RPS
   phases with zero drops, p95 <600, p99 <750, max <800 ms. Repeat
   book-detail, commerce/entitlement, revoked-asset and mobile p75 LCP gates
   at the same release SHA.

## Immediate safe progress in this branch

- Fenced primary metadata publication now avoids UPDATE writes when the
  normalized work/edition fields are unchanged (including retries and
  territory-only source revisions).
- Taxonomy mapping and ancestor reconciliation now executes four dependent
  statements in one atomic D1 batch rather than four separate service calls.
- The hosted benchmark logs per-burst Cloudflare Ray, transport and service
  timings while retaining every slow sample and the original strict gate.

None of these targeted reductions removes the full legacy primary writer or
solves the independently observed Cloudflare delivery tails. Production
routing, primary migration, authority cutover and release certification
remain disabled pending the full adversarial evidence.

## Implemented on this branch (stage only, not production-routable)

- `legal-authority-core.ts` persists monotonic per-source/per-country
  deny/allow versions in strongly consistent SQLite-backed Durable Object
  storage. It checks source-wide denial on every territory read. Missing
  scopes fail closed; equal-version denial defeats allowance.
- `legal-authority.worker.ts` uses a private, secret-gated entrypoint
  that is physically pinned to the existing canonical-publication **QA**
  primary D1. Positive transitions require a fresh primary check for
  source/evidence/territory and a current retail offer. The default worker
  `fetch` is 404; no public route or customer binding has been created.
- `legal-authority-coordinator.ts` orders canonical mutations:
  durable owner denial acknowledged **before** any primary mutation;
  positive grants are committed on primary first and only later made
  visible by a separately checked owner allowance. Any timeout or stale
  acknowledgement aborts the relevant transition, preserving denial.
- SQLite adversarial tests cover duplicate/stale/equal revision replay,
  multi-territory and source-wide withdrawal, persistent restart, owner
  outage, source mutation crash and approval publication failure.
- Wrangler configuration is an intentionally **disabled example**, not
  evidence of an active online rights authority. The new Worker is not
  bound into homepage, detail, checkout or protected delivery.

**Why cutover is still blocked:** direct production legal writes remain
possible through existing processing/administrative paths. Until all
such writers are fenced, cached owner allowances could become stale.
We therefore retain live primary authorization and production routing
unchanged. The staged ledger does not itself improve hosted-capacity.

## Latest hosted run: 40254586807 (PR #351)

The isolated hosted run passed **3/3 cold rounds** and all **1/4/8/16/32**
concurrency bursts. Its first full 12,000-request 100-RPS phase passed
with **12,000/12,000 valid**, zero drops, p95 **173 ms**, p99 **272 ms**,
maximum **698 ms**. The second full phase stopped after request 8,593
when one valid 200 response took **1,295.8 ms**; Worker handler was
**59 ms**, SQL **4.4 ms**, and approximately **1,237 ms** was outside the
handler. Cloudflare Ray: `a505c22f9eb75e41-DFW`. No application
retries or ignored samples may classify this as passing.

Because the long HTTP/2 delivery delay is outside the Worker, it cannot
be deterministically cured by deleting additional D1 statements.
Until geographically diverse runs demonstrate elimination of the edge
tail—or Cloudflare infrastructure changes explain/correct it—the
**absolute every-request <800 ms** contractual release criterion remains
unmet. Do not substitute percentile-only claims, remove extreme values,
or change which traffic counts.

## Later stage-owner engineering and independently reproduced capacity blocker

The next PR #351 hosted campaign (`40259003512`, job
`121367394694`) **failed** despite three cold rounds and all five
1/4/8/16/32-concurrency bursts passing. It stopped the first strict
100-RPS phase after 1,390 valid samples (1,390/1,390, no drops) at a
reported 998.08ms response maximum. The slowest measured SQL was ~3.5ms
but the **primary D1 service request took 859ms**; Cloudflare Ray
`a5060c1a8ec5cd6e-SJC`. A cluster of responses had 778–859ms D1
service time with ~2.6–3.5ms SQL. This is distinct from the previous
1,295.8ms edge/transport-tail Ray observed with a 59ms handler.

To make independent legal serving implementable **without trusting old
rights snapshots**, this branch now adds:

- Revision-scoped, country/currency-specific, primary-verified free
  Gutenberg offer proofs stored *in the legal owner*. An offer is returned
  only if the effective legal version matches the exact proof version.
- One indexed SQLite owner read for up to 128 bounded homepage candidates
  (up to 25 results, same cap as the primary-authority query), rather than
  a D1 network call per candidate.
- Source-wide monotonic revision allocation inside the owner via
  `/deny-next`, with a canonical source-event idempotency key. It denies
  **before** its acknowledgement and before the primary writer callback.
  A stale withdrawal receipt is never acknowledged after a newer grant.
- A strict owner-backed homepage assembler with validation of identity,
  edition and zero-priced public-domain offer; unknown, withdrawn,
  cross-country or cross-currency results fail closed.
- **Staging-only** homepage integration:
  `COVE_LEGAL_OWNER_STAGE_READ_ENABLED=1` is accepted only with
  `COVE_SSR_STAGING=1`, explicit primary-acceptance mode, the expected
  database ID, an audited-writer-closure flag, a private DO binding and
  a secret. Customer routing never activates this branch.
- Local, destructive-only synthetic tests for restart, source-wide
  withdrawal, mismatched country/currency, delayed replay, identity
  tampering, owner outage, and denial-before-primary sequencing.

This is still **not** a complete production cutover. The existing
ingestion, regional rights/evidence, staff, offer, entitlement and asset
mutation surfaces are not yet all fenced by the owner; the staged
config is deliberately disabled and the required QA writer-closure
assertion is not certified. Book details, checkout and protected
delivery have NOT been switched. The original strict hosted-capacity
workflow still uses primary D1 and must remain a failing release gate
until the chosen release topology is actually deployed and validated.
No fake pass by changing the fixture, phase duration, thresholds or
percentile accounting is acceptable.
