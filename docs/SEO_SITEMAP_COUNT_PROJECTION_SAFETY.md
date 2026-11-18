# Cove SEO sitemap count projection — unshipped safety contract

Status: **draft source-only candidate; production behavior intentionally unchanged**.

## Incident and scope

Read-only Cloudflare analytics for 2026-11-17 identified the live `src/features/fore/seo.server.ts` distinct-work sitemap count as a multi-second primary-D1 scan (one 4,920ms execution at 22:09 UTC; three executions totaling 11,583ms at 22:37 UTC). This is not proof that the query caused every storefront 503. A simple COUNT(DISTINCT) → EXISTS rewrite (closed PR #779) preserved parity but regressed in an 82,247-work local fixture; do not revive it without real evidence.

Sitemap counts **do not authorize** books, sales, downloads, or reader access. Nevertheless, a sitemap that advertises a withdrawn title or a stale page must not be treated as safe. The current public SEO document gateway can CDN-cache XML for 900 seconds, so simply inserting a TTL cache over full-catalog counts is insufficient.

## Version-fenced contract

`src/features/fore/seo-count-projection.ts` provides **pure validation only**; it neither reads D1 nor writes a projection. Its opt-in caller must fetch a projection and a **fresh, consistent primary-D1 owner fence on every sitemap request**. A projection is accepted only when:

- **All seven generation/version fields match**: immutable serving owner version; independent Durable Object denial epoch reconciled into primary D1; catalog mutation revision; canonical rights revision; withdrawal revision; taxonomy revision; contributor revision.
- The primary evidence explicitly attests `ownerEnabled=true`, `exclusiveWriter=true`, `primaryD1=true`, `dirty=false`, `pendingWithdrawals=0`, and `pendingWrites=0`.
- The entire five-field count record is present, integer and non-negative; schema and structure are exact; and the projection was published within a maximum 60-second validity interval.
- The response opts out of origin/CDN caching: `Cache-Control: no-store`, with CDN-specific cache headers stripped.
- Any malformed/missing/read-unavailable/stale/dirty version state yields a **503 no-store**, never a fallback to the heavy full-catalog aggregation. The static robots.txt and pages.xml can remain independent.

The existing SEO route accepts an optional `SeoCountEvidenceLoader` for test/staging. **No production caller supplies it.** Therefore both existing XML counts and the current gateway remain unchanged in main and in current deployments. This is not yet a release fix.

## Producer-side source contract (not connected to production)

`src/features/fore/seo-count-projection-producer.ts` also provides an explicit, source-only `buildSeoCountProjection` contract. It rejects an unsafe initial primary-fence witness **before** any expensive COUNT, reads five authoritative counts sequentially outside the customer request path, re-reads the primary fence, and refuses to publish if the generation changed during counting. It then calls a separately supplied `compareAndPublish` callback.

**That callback does not exist in production yet** and is safety critical: the only acceptable implementation is a single atomic owner-authorized D1 compare-and-publish transaction, including a check against older snapshot timestamps or displaced producer leases. A second fence read without an atomic compare-and-publish is vulnerable to withdrawals racing between the read and write. A false/throwing callback fails without marking success. The synthetic test simulates both a withdrawal during counting and another after the second read but before publication, asserting both are rejected.

## Isolated primary-D1 SQL and compare-and-publish proof

The branch now includes a **staging-only SQL prototype** at `scripts/staging/seo-primary-count-fence.prototype.sql` and a first-primary D1 adapter in `src/storefront-strangler/seo-primary-d1-counts.server.ts`. The SQL is deliberately outside `drizzle/` so it cannot be picked up by an ordinary production migration; no environment applies it automatically.

The prototype creates one sealed primary-fence row (`dirty=1`, blank owner version), a one-row count snapshot, and 48 insert/update/delete generation triggers on 16 currently identified catalog/rights/taxonomy/contributor tables. SQLite executes each trigger in the **same transaction as the source mutation**. Existing non-owner writers cannot silently skip invalidation for those covered tables.

The adapter requires the specific Cove primary D1 ID and a *separately verified* private owner witness; a flag or API request header is not an owner certificate. It **requires** `withSession("first-primary")` and uses one joined primary read to obtain both the snapshot and the current fence. Snapshot publication is a single conditional `INSERT ... SELECT ... ON CONFLICT DO UPDATE ... RETURNING` statement that atomically compares every generation, owner version, dirty state and pending-write/withdrawal state, and blocks older publisher timestamps. There is no `BEGIN`/network-`await`/`COMMIT` race.

The fixture-based `scripts/check-seo-primary-d1-count-cas.mjs` uses Node SQLite to verify:
- All 48 triggers cover their declared INSERT, UPDATE and DELETE operations; rolled-back mutations also roll back their fence changes.
- The fixture is sealed by default and rejects apparent owner attestations until explicitly opened *within the local test*.
- The joined evidence read rejects a withdrawn/dirty/changed primary generation; a snapshot from before a rights withdrawal cannot be republished.
- A withdrawal between producer validation and the atomic publish statement causes CAS failure; older producer timestamps lose to newer snapshots.
- No read is allowed through the replica/unconstrained session path.

**Deny-first legal-owner gap (mandatory):** Cove's legal authority can durably acknowledge a withdrawal in its private owner **before** the corresponding primary-D1 mutation commits. Trigger-based D1 generations only change when the primary write occurs; during that interval, a D1-only snapshot may still appear current even though rights are already denied. Therefore the production evidence loader MUST additionally prove that the owner Durable Object's latest deny/withdrawal epoch is not ahead of the primary projection (or fail closed on any unconfirmed owner state), including across owner restart and retries. The staging SQL here does **not** close this cross-service gap. A local schema mutation trigger is not a replacement for Cove's independent deny-first legal authority. This must be exercised with a controlled withdrawal race before any production cutover.

**Remaining gap: this is NOT a deployable complete production migration.** The 16-table coverage list still requires a complete independently reviewed source-write inventory against the real full schema, including ownership-related and emergency revocation pathways. A private owner witness is assumed for the test but not issued by any live production authorizer. Legal effective-time expiry may invalidate access without a SQL mutation; production must additionally bound projection validity by expiry or refuse to publish where such an event is not covered. Sitemap result pages still require live primary-D1 eligibility checks; valid count snapshots do not authorize individual URLs. Initial CDN invalidation/purge at cutover must be proven. Trigger write amplification must be benchmarked against the strict latency target before a protected staging schema application. No production D1 changes or owner enablement are performed.

## Independent deny-first owner epoch: isolated protocol

The prototype now reserves `owner_denial_epoch` in the primary-D1 fence **and** its count snapshot. The opt-in sitemap handler calls `verifiedSeoCountsForServing` rather than the producer-only version comparator. Serving requires a fresh independently read proof from the canonical legal-owner Durable Object, and the **owner denial epoch must match both the D1 fence and the published snapshot**. If the owner acknowledges a denial while its D1 mutation is not yet committed, the owner's epoch advances and the response becomes **503 no-store** rather than serving old XML.

Two new stage-only source modules implement the protocol:

- `seo-owner-denial-epoch.ts` defines a monotonic, idempotent owner-wide denial journal to be advanced in the **same DO SQLite transaction** as each validated legal denial. A failed denial rolls back the epoch; a replay cannot advance it twice. Its private proof includes a nonce challenge.
- `seo-owner-denial-read.server.ts` uses a separately authenticated private service-binding POST with a fresh 128-bit random challenge, requires the exact owner/version/epoch schema, the challenge echo, strict no-store, and reads the owner **after** the single joined primary-D1 snapshot read. There is no fallback to a cached proof or replica.

`scripts/check-seo-owner-denial-epoch.mjs` uses two *independent* in-memory SQLite databases to reproduce the gap: owner denial committed before D1; D1-only comparison still looks valid, but serving rejects it; D1 later reconciles and invalidates the old snapshot; a newly built snapshot can pass only after epochs match. Tests also cover failed denial rollback, replay, unavailable owner, stale challenge and public cache headers.

**Important limitations:** These source modules are **not integrated into the existing 300KB production legal-owner Worker** and create no private production route. None of the current legal denials are instrumented to advance a shared owner-wide epoch yet. The actual owner has per-source revisions, not this global counter. A reviewed, complete inventory must include source, market, commercial product, paid entitlement, publication, emergency rights and other applicable denial paths, including crash recovery and replays. Any uncovered path can make a global epoch insufficient; keep all public sitemap projections disabled until completeness is independently certified.

The opt-in handler also re-reads the owner and primary-D1 generation fence **after each potentially slow sitemap page SELECT**, before returning XML. Any intervening deny or mutation returns 503 with no-store. This second read costs extra latency and requires protected four-region/100-RPS measurement before promotion.

The per-request owner read establishes a linearization point: denials acknowledged **before** that read must be observed. A denial acknowledged after the final owner read cannot retroactively withdraw already transmitted XML. URLs on individual pages must still be validated by current legal authorization; a global count is never an entitlement proof. The real owner route must remain disabled in production until legal ownership and physical D1 write exclusivity are proven. The independently protected rollout must verify that Vercel/Cloudflare cannot retain previously cached SEO XML.

## Essential production prerequisites — not implemented here

1. Certify exactly one canonical D1 writer and an enabled, lawful legal owner. This contract must NOT be used as a substitute for that certification.
2. Establish owner-maintained revisions in primary D1, atomically invalidated **with every write** that can affect sitemap membership or counts. This includes product activation/withdrawal, edition availability, canonical work status, contributor links, taxonomy visibility, rights grants/expiry, and emergency takedown/dirty states. The sole canonical writer must increment the relevant generation and commit mutation+generation together; a write path that can omit the revision invalidates this design.
3. Publish count snapshots only from a consistent, verified authority generation. A producer must compare its starting and ending fence under an atomic publication protocol and refuse to publish if the state changed while expensive counts were built. Refreshes, crashes, retries, or out-of-order completions must never publish an older version over a newer one.
4. Implement a read-only bounded primary-D1 evidence loader. **No Worker-global Promise**, CDN cache, R2 replica, read-replica session, or client-supplied header may be the authority for that fence. Avoid leaking raw SQL, IDs, tokens, request URLs, or private account data into logs.
5. Ensure current entry and page SQL still excludes unavailable/withdrawn products. The count projection is **not** a rights recheck for the returned page URLs. Existing page OFFSET and 20,000-row output costs remain independent performance concerns.
6. Run a protected staging experiment against representative real-catalog cardinalities, including exact equality to the current five SQL counts, mutation and withdrawal races, a projected 503 on unavailable evidence, absence of cache headers end-to-end through Vercel, and full concurrent geographic/100-RPS acceptance.
7. Until the above have passed, keep the optional loader unconnected and leave production traffic, DB schema, legal authority, Stripe, and routing untouched.

## Offline SQL fixture parity

The source-only test also executes the **five exact current SQL count templates** in an in-memory SQLite catalog with duplicate editions, upload exclusions, redirected works, unavailable editions, distinct authors and taxonomy visibility. The test asserts each SQL literal still exists in `seo.server.ts`, builds a snapshot from those counts, changes product publication status under a new catalog generation, verifies the old snapshot is rejected, and confirms the rebuilt counts exactly equal all five SQL results.

This catches SQL-source drift and category-specific cardinality mistakes, but is **not** a real 82,247-book D1 parity or performance result.

## Offline evidence

`scripts/check-seo-count-projection.mjs` constructs synthetic version fences and exercises count version mismatches, withdrawal propagation, dirty/pending writes, incomplete evidence, expiry, invalid counts, the lack of a live COUNT when attested, no-store responses, and unchanged legacy behavior. The dedicated workflow `cove-seo-fenced-count-projection-offline` runs it in CI alongside the existing public SEO gateway regression and typecheck, including snapshot-build publication races. These tests prove **local source behavior only**, not primary-D1 writer atomicity or deployed performance.

**Release decision: NO-GO until every independent Cove release gate is certified.**
