# Independently prepared canonical metadata + fenced primary publication

Deployment state: **stage-only and disabled**. This is a narrow but genuine
canonical-title/description publication lane, *not yet full graph ownership transfer*.

The independent D1 now derives a bounded prepared title/description alongside its
FTS projection, in the SAME isolated transaction. The primary rights database
receives only three guarded, transactional statements per accepted candidate:
a monotonic receipt, a pre-existing work update, and a pre-existing edition
update. There is no primary FTS, taxonomy, author graph, global catalog write,
rights-grant, entitlement, checkout or customer table update in this path.
It does not create new product/offer/rights records and cannot make a book
available. Withdrawals are synchronously blocked by the primary legal trigger.

Private publisher is deliberately **pinned to the separately provisioned canonical-publication QA primary ID**
and requires an explicit `COVE_CATALOG_NORMALIZATION_PUBLISH_ENABLED=1`.
No public routes, cron, or production credentials are configured.

Safety: exact source title/summary, current primary legal status, matching
changefeed sequence and absence of any newer event are checked in one primary
D1 transaction with the receipt and both metadata updates. Replayed/stale
preparations cannot replace newer published metadata. Disappeared books,
missing grants, withdrawn territories, or missing preparations fail closed.

Remaining full cutover: migrate source ownership to the independent processing
domain, replace every legacy canonical graph statement with a bounded
verified publication contract (including authors/assets/offer/legal evidence),
fully reroute text search away from primary FTS, and pass real mixed-workload
and all hosted cold/100-RPS/mobile LCP acceptance. Do not disable legacy
canonical writes, merge, or route production until these hold.


QA primary database: `cove-canonical-publication-qa-20261025` (5e3a6b69-6f3d-4b19-b837-01f7aa56ce87).
Independent index database: `cove-catalog-index-stage-20261025`
(`8f15cdbe-8f9e-4b52-9fb6-c64f5053b59b`). These are
**not production or benchmark D1**; no hosted capacity experiment should
write to either while benchmarking. The publisher must not be bound to
Cove production or the 40k-row performance candidate.

Publisher independently re-runs deterministic source-text normalization
before constructing any primary mutation. An isolated D1 document with an
injected title/description is rejected even when its raw-source revision is
otherwise valid; this is separate from the primary SQL legal-state fence.
