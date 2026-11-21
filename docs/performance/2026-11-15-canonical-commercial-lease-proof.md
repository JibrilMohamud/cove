# Canonical commercial owner: future legal-transition lease and D1 plan evidence

**November 15, 2026 — Draft PR #704. Not a production release certificate.**

## Security issue being closed

Cove already has an owner-private `/commercial/publish-verified` route that runs
the *actual* `resolveProductRights` against primary D1, then publishes a
commercial subject/epoch proof in strongly consistent Durable Object SQLite.
The existing lease was bounded only by the selected grant's `endsAt`, policy
`effectiveTo`, and 30 minutes. A separately scheduled DENY, contract-version
or language-policy transition, competing retail offer, or release boundary
could become effective first. The *current* canonical ALLOW did not prove a
30-minute **future** ALLOW.

The fix in `canonical-commercial-lease.ts` queries **all** dated positive
and negative legal sources for the single product *only at publication*:
grant starts/ends, all related contract and contract-version effective dates,
contract language restriction starts/ends, offer starts/ends, and edition
release/preorder dates. Bad source dates, missing product, missing D1 result,
stale/future Worker clock, and imminent changes fail closed. A positive expires
at least 2.5 seconds before the earliest future boundary, and the owner
still requires an unchanged epoch, unretired evidence and no subject denial
in the final SQLite commit.

A subtle TOCTOU fence is essential: the date comparison uses the **start of
canonical verification**, not D1's time when the later schedule query begins.
A future denial that takes effect during awaited IO must not disappear from
the list of transitions.

## Real production D1 query compatibility and cost

The full 12-term `UNION ALL` approach passed local SQLite but failed to
compile on actual Cloudflare production D1 with
`too many terms in compound SELECT`. It was replaced with two independent
bounded queries, using four and two `UNION ALL` terms and two date columns
unpivoted with `json_each(json_array(start,end))`.

Read-only `EXPLAIN QUERY PLAN` and `SELECT` of both revised queries against
the actual production primary D1 **succeeded**. No changes were made to the
database. The missing paid-product proof correctly produced
`product_count=0` and cannot mint a positive.

The first legal query initially scanned entire global rights-grant and
language indexes despite filtering one product. A read-only `EXPLAIN`
comparison on a single existing **public-domain** product established that
the new target-first `CROSS JOIN` order preserved the same boundary result
while avoiding those global scans:

| Query shape | Rows read | D1 SQL duration | Legal timeline result |
|---|---:|---:|---|
| Unforced grants/contract/languages JOIN | 164,502 | 31.104 ms | Same |
| One-book target-first CROSS JOIN | **15** | **1.334 ms** | Same |

The second offer/release query on that sample read 15 rows in 1.205 ms.
These are **single read-only samples**, not hosted tail-latency or
geographically repeatable performance acceptance. No paid product was used
as a production sample.

An independent, read-only production catalog distribution check counted
**81,909 active + 338 inactive Gutenberg products and 0 active paid
(non-Gutenberg) products**. Real paid-offer legal certification must use a
separately isolated full-schema paid QA data plane; a nonexistent live paid
book cannot certify the positive writer.

## Isolated end-to-end correctness

The standalone, no-network `scripts/staging/check-owner-actual-canonical-lease.mjs`
test loads the real `resolveProductRights` code against an in-memory SQLite
fixture and uses production `publishFreshCommercialProof`,
`publishCommercialStorefront`, `readCommercialStorefront` and
`denyCommercialSubject` against a separate real SQLite database.
It verifies 17 canonical cases: 12 denials, baseline ALLOW, three
near-future explicit-denial/contract-expiration/competing-offer transitions,
and malformed source date; it checks current exact paid price and legal
contract/version evidence, immediate owner contract tombstone, stale
regrant veto, clock skew and a transition that crosses the async
verification window.

[The initial 17-case proof passed](https://github.com/JibrilMohamud/cove/actions/runs/43747394171).
[The race-condition regression also passed](https://github.com/JibrilMohamud/cove/actions/runs/43748441948).
The latest target-first SQL changes must separately pass the current CI head
before any safety conclusion.

## Blocking release gates

- Prove real owner production writer exclusivity: deny-before-D1 for every
  rights/contract/format/language/DRM/offer/edition mutation, including
  scheduled changes and background jobs. Production owner remains disabled.
- Certify the **real full-schema paid QA owner** (positive source/offer and
  full withdrawal) and the actual owner private route under concurrency;
  local synthetic in-memory evidence is not enough.
- Complete the exact nine-field catalog API envelope, all book fields,
  search/filter/facet/count/pagination identities, fail-closed owner
  authorization and product detail parity. [Draft #680](https://github.com/JibrilMohamud/cove/pull/680)
  contains a reference contract; that is not itself a certified implementation.
- Eliminate real customer SSR/catalog 503s. Existing production D1 facets can
  still execute multi-million-row legal view scans. Do not replace exact
  rights-scoped counts with guesses, or present KV/R2 bytes as grants.
- Strict cold/warm <800ms 1/4/8/16/32, two 100-RPS ×20s phases with
  p95<600/p99<750/max<800/zero drops in ORD/LAX/IAD/DFW.
  [Isolated DO benchmark #702](https://github.com/JibrilMohamud/cove/pull/702)
  does not certify real catalog/SSR.
- Stripe LIVE settlement -> entitlement -> protected EPUB/audio -> refund ->
  synchronous revocation, followed by protected traffic rollback rehearsal.

**No production Worker routing, owner flag, D1 rows, D1 write permissions,
Stripe credentials, payments or user data were changed in this PR.**
