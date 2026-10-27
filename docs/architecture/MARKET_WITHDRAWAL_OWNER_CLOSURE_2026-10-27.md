# Strongly consistent territory withdrawal — staging proof

**State:** isolated QA certified on 2026-10-27. **Not production ownership
cutover, not hosted-capacity certification, not production routing.**

## What changed

The anonymous storefront rights dependency includes market activation,
currency, edition release, offer publication and catalog availability.
Even after every per-product grant/contract writer was fenced, an unowned
`storefront_markets` edit could cause live primary D1 and the independent
legal owner to disagree. The stage writer lock now blocks raw legacy market
mutations. This branch additionally defines the strong-owner *negative*
transition for an entire country.

- `market-authority-core.ts`: permanent owner-local SQLite tombstone keyed
  by exact uppercase ISO-style territory, with scoped idempotent operation
  receipt and collision rejection. There is deliberately **no allow/reset
  command**; reinstatement is a separately required owner-first fresh-primary
  market, policy, evidence and currency verification.
- `legal-authority.worker.ts`: private `/market/deny-next` executes the
  tombstone atomically and rejects all country-scoped free, commercial,
  paid-buyer and presentation-authority requests. For positive rights,
  price and entitlement publication, the market fence is checked **again
  after D1 verification inside the final strong-owner SQLite transaction**.
  Older positive work cannot win a withdrawal race. Contract and source
  denials remain available while a market is withdrawn.
- `legal-quarantine-qa.writer.ts`: expiring, secret-authenticated,
  synthetic-D1-only `/market/withdraw` obtains the strong denial receipt
  **before** setting the matching canonical market to
  `market_status='paused'` and disabling checkout. An unavailable D1
  leaves the owner denial effective; a repeated exact operation reconciles
  canonical D1 without resetting legal authority.
- Tests cover identity collisions, replay, cross-market isolation,
  owner-first ordering, owner outage, D1 outage, and eventual repair.

The serving **presentation-only warm-isolate cache from PR #355 remains
untrusted metadata** and cannot convey a market grant, a currency offer,
a customer entitlement or an offline license.

## Independent deployed proof

GitHub Actions [40481533638](https://github.com/JibrilMohamud/cove/actions/runs/40481533638)
passed the real private QA Worker/Durable Object/isolated-D1 campaign, including
a synthetic `QZ` market pause, verified owner read veto and exact replay.
The QA market table was created only in the synthetic canonical-publication
QA D1 and removed in `finally`; neither a production table nor the capacity
fixture was touched. The disabled private owner, no runtime QA secret and no
remaining temporary market table were independently verified after the run.

The [isolated-catalog-index CI](https://github.com/JibrilMohamud/cove/actions/runs/40481533632)
also passed the full local owner/right tests, compile and TypeScript check.

**Important limitations:** The new country tombstone is a denial-only slice,
not a full market activation/restore publisher. Legacy positive publication,
grant/contract issuance, author/source policy, Stripe tender/ledger settlement
and downstream offline/reader writers are not completely closed, and the
staged owner is not connected to anonymous production serving. This change
cannot remove the primary D1 latency tail until every authorizing writer is
migrated, and cannot eliminate independent edge delivery stalls.

## Release-blocking capacity evidence

The previous strict candidate
[40477191182](https://github.com/JibrilMohamud/cove/actions/runs/40477191182)
completed three cold rounds, all five concurrency bursts and the first
12,000/12,000-request 100-RPS phase, but failed the second phase at
**828.115 ms**. That failing response spent **643 ms in D1 service** despite
**3.9 ms actual SQL** and **0 ms presentation**, with another ~185 ms outside
Worker execution. Neither this feature nor caching can make a primary-D1
permission request deterministic. The existing `<800ms` absolute gate,
zero drops, two complete 12k phases, 3 cold rounds and
1/4/8/16/32 concurrency remain unchanged.

Do not enable production owner read, paid checkout/delivery migration or
customer routing until all canonical legal and commerce writers are
physically fenced and independently certified, including signed pending
payment -> entitlement -> protected real bytes -> refund/withdrawal,
rollbacks, region parity and a user-owned Cloudflare custom Worker domain.
Cloudflare account inspection on this date showed **zero zones and zero
custom Worker domains**. See provider issue #353.
