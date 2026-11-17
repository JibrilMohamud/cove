# Cove SEO sitemap count projection — unshipped safety contract

Status: **draft source-only candidate; production behavior intentionally unchanged**.

## Incident and scope

Read-only Cloudflare analytics for 2026-11-17 identified the live `src/features/fore/seo.server.ts` distinct-work sitemap count as a multi-second primary-D1 scan (one 4,920ms execution at 22:09 UTC; three executions totaling 11,583ms at 22:37 UTC). This is not proof that the query caused every storefront 503. A simple COUNT(DISTINCT) → EXISTS rewrite (closed PR #779) preserved parity but regressed in an 82,247-work local fixture; do not revive it without real evidence.

Sitemap counts **do not authorize** books, sales, downloads, or reader access. Nevertheless, a sitemap that advertises a withdrawn title or a stale page must not be treated as safe. The current public SEO document gateway can CDN-cache XML for 900 seconds, so simply inserting a TTL cache over full-catalog counts is insufficient.

## Version-fenced contract

`src/features/fore/seo-count-projection.ts` provides **pure validation only**; it neither reads D1 nor writes a projection. Its opt-in caller must fetch a projection and a **fresh, consistent primary-D1 owner fence on every sitemap request**. A projection is accepted only when:

- **All six generations match**: immutable serving owner version; catalog mutation revision; canonical rights revision; withdrawal revision; taxonomy revision; contributor revision.
- The primary evidence explicitly attests `ownerEnabled=true`, `exclusiveWriter=true`, `primaryD1=true`, `dirty=false`, `pendingWithdrawals=0`, and `pendingWrites=0`.
- The entire five-field count record is present, integer and non-negative; schema and structure are exact; and the projection was published within a maximum 60-second validity interval.
- The response opts out of origin/CDN caching: `Cache-Control: no-store`, with CDN-specific cache headers stripped.
- Any malformed/missing/read-unavailable/stale/dirty version state yields a **503 no-store**, never a fallback to the heavy full-catalog aggregation. The static robots.txt and pages.xml can remain independent.

The existing SEO route accepts an optional `SeoCountEvidenceLoader` for test/staging. **No production caller supplies it.** Therefore both existing XML counts and the current gateway remain unchanged in main and in current deployments. This is not yet a release fix.

## Producer-side source contract (not connected to production)

`src/features/fore/seo-count-projection-producer.ts` also provides an explicit, source-only `buildSeoCountProjection` contract. It rejects an unsafe initial primary-fence witness **before** any expensive COUNT, reads five authoritative counts sequentially outside the customer request path, re-reads the primary fence, and refuses to publish if the generation changed during counting. It then calls a separately supplied `compareAndPublish` callback.

**That callback does not exist in production yet** and is safety critical: the only acceptable implementation is a single atomic owner-authorized D1 compare-and-publish transaction, including a check against older snapshot timestamps or displaced producer leases. A second fence read without an atomic compare-and-publish is vulnerable to withdrawals racing between the read and write. A false/throwing callback fails without marking success. The synthetic test simulates both a withdrawal during counting and another after the second read but before publication, asserting both are rejected.

## Essential production prerequisites — not implemented here

1. Certify exactly one canonical D1 writer and an enabled, lawful legal owner. This contract must NOT be used as a substitute for that certification.
2. Establish owner-maintained revisions in primary D1, atomically invalidated **with every write** that can affect sitemap membership or counts. This includes product activation/withdrawal, edition availability, canonical work status, contributor links, taxonomy visibility, rights grants/expiry, and emergency takedown/dirty states. The sole canonical writer must increment the relevant generation and commit mutation+generation together; a write path that can omit the revision invalidates this design.
3. Publish count snapshots only from a consistent, verified authority generation. A producer must compare its starting and ending fence under an atomic publication protocol and refuse to publish if the state changed while expensive counts were built. Refreshes, crashes, retries, or out-of-order completions must never publish an older version over a newer one.
4. Implement a read-only bounded primary-D1 evidence loader. **No Worker-global Promise**, CDN cache, R2 replica, read-replica session, or client-supplied header may be the authority for that fence. Avoid leaking raw SQL, IDs, tokens, request URLs, or private account data into logs.
5. Ensure current entry and page SQL still excludes unavailable/withdrawn products. The count projection is **not** a rights recheck for the returned page URLs. Existing page OFFSET and 20,000-row output costs remain independent performance concerns.
6. Run a protected staging experiment against representative real-catalog cardinalities, including exact equality to the current five SQL counts, mutation and withdrawal races, a projected 503 on unavailable evidence, absence of cache headers end-to-end through Vercel, and full concurrent geographic/100-RPS acceptance.
7. Until the above have passed, keep the optional loader unconnected and leave production traffic, DB schema, legal authority, Stripe, and routing untouched.

## Offline evidence

`scripts/check-seo-count-projection.mjs` constructs synthetic version fences and exercises count version mismatches, withdrawal propagation, dirty/pending writes, incomplete evidence, expiry, invalid counts, the lack of a live COUNT when attested, no-store responses, and unchanged legacy behavior. The dedicated workflow `cove-seo-fenced-count-projection-offline` runs it in CI alongside the existing public SEO gateway regression and typecheck, including snapshot-build publication races. These tests prove **local source behavior only**, not primary-D1 writer atomicity or deployed performance.

**Release decision: NO-GO until every independent Cove release gate is certified.**
