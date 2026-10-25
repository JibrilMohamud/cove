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

Private publisher is deliberately **pinned to the synthetic QA primary ID**
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
