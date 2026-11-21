# Current-owner withdrawal journal: handler integration

This change moves the SQL invalidation mechanism from the separate SEO
prototype into an explicitly opted-in **synthetic QA instance of the actual
CoveLegalAuthority class**. It is not a production legal-owner activation or a
serving attestation. The new receipt always contains `authorizing:false` and
has a distinct `cove.qa.current-owner-sql-journal.v1` schema.

The existing owner lease must be live, the primary must be one of the two
already approved synthetic QA IDs, and `COVE_QA_OWNER_JOURNAL_VERSION` must be
an explicit 64-character lowercase hex identifier. The identifier binds the
journal enrollment; it is not independently verified deployment provenance.
No checked-in Wrangler configuration sets this variable. The production
primary, disabled owner and expired lease cannot enroll or read this journal.

The class initializes its eight existing schema factories, then enrolls all
24 SQL tables in a single real transaction. Seventy-two row triggers advance
the counter in the same SQLite statement as every INSERT, UPDATE or DELETE,
including positive transitions and bookkeeping. Six metadata guards reject
counter replacement, reset, deletion and manifest mutation. Exhaustion aborts
the originating write. Existing authority/history cannot silently become
epoch zero. A restart validates existing enrollment rather than repairing it.

Before any enrolled handler runs, the class checks exact table DDL, the
complete table/view inventory, trigger targets/bodies, journal identifier and
counter under a transaction. Unknown schema or lost triggers fail closed. The
private POST `/qa/current-mutation-fence` also requires the ordinary owner
secret and an exact fresh caller challenge, and responds with `no-store`.
It reads current owner state independently of any later D1 reconciliation.

`check-current-owner-mutation-fence.mjs` bundles the real Worker entrypoint and
class. It verifies seven actual denial routes (source, market, product,
contract, grant, order and entitlement), replay, challenge binding, historical
bootstrap refusal, damaged-schema refusal, counter immutability/exhaustion,
and failed-batch rollback. An injected failure at the second source denial
rolls back both source state and journal epoch through the real batch handler.

A separate race holds the genuine order-revocation handler at its external
D1 batch, reads the already committed owner journal and verifies the order is
denied, then fails reconciliation. The counter and denial survive. The same
actual class/HTTP handlers run in pinned native workerd with genuine SQLite
Durable Object storage, an explicit D1-outage adapter and a full process
restart. These tests use synthetic data and no external account credentials.

Default serving behavior has no new SQL calls: enrollment and journal reads
require the explicit QA-only opt-in. The production owner remains disabled.
No public storefront handler consumes the QA receipt.

Production completion still requires reviewed historical-owner enrollment,
independent deployment identity and challenge verification, primary-D1
publication/CAS reconciliation, complete non-SQL and deny-route coverage,
time-based legal horizons, exclusive physical/token/source writers, and
full-catalog rights/offer/search/count/facet/pagination parity. Privileged
schema restoration needs external rollback controls; a local epoch cannot
prove protection from restoring an entire older database. This change does
not certify production 503 elimination, LIVE commerce, protected production
rollback, geographic latency or 100-RPS performance.
