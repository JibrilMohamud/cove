# Atomic payment settlement behind the private owner

This implementation covers **new orders enrolled in isolated QA**. Production
owner enablement stays zero. It closes **none of the 426 historical production
owner-required SQL findings**. Publishing materialization and other scheduled
writers remain separate migration work. Existing production payment paths stay
available until their replacement is independently certified and deployed.

## Transaction and authority

`commerce.settle-order` accepts only the canonical order ID through the private,
authenticated, expiring owner. The owner independently retrieves the linked
Stripe PaymentIntent with its own TEST key and verifies succeeded status,
mode, exact amount/currency, order metadata, customer identity when present,
charge refund/dispute status, and the balance transaction. Unsupported currency
conversion or unavailable fee evidence fails before tender consumption.
Internal-only tender has no fabricated Stripe success receipt.

The owner checks the exact acquired grant, edition, territory, retail channel,
contract and version against its current strong rights proof. A durable pending
order record prevents all alternate buyer-publication paths and access proofs
while settlement is incomplete. Order/market withdrawals remain terminal.

One D1 batch commits all of the following, or none:

- Conditional read-set assertions, including current order status, purchased
  scope, complete line inventory, reservations, balances and buyer holds.
- Gift-card and store-credit consumption and their tender journals, promotion
  counters and reservation transitions.
- Every immediate-purchase entitlement, version pin and ownership snapshot;
  preorder reservation/events/outbox without granting downloadable access.
- Provider processor-fee allocation, sale/tax/tender journal, every royalty
  calculation, payee allocation/event and its balanced journal, line financial
  metadata and the paid order marker.
- A unique settlement receipt that is also the durable recovery obligation.

CHECK assertions abort the entire batch if preflight reads became stale.
Strict unique identities reject competing postings. Lost acknowledgements read
back the same committed receipt; they do not repeat any financial mutation.
Royalty planning also fixes the prior calculation-marker-before-allocations
crash window for ordinary royalty accrual.

Retail attribution, customer tax transaction and purchase notification effects
are retried under the same private owner, using their existing dedupe/provider
idempotency keys. Only after these finish can the owner atomically publish all
immediate buyer proofs. A crash between effects completion, owner publication
and its acknowledgement remains discoverable through `owner_published_at`.

`commerce.recover-settlements` discovers at most 25 pending commands itself,
from both the durable owner journal and canonical D1 receipts. Alternating
keyset cursors prevent blocked commands from starving later work;
callers cannot supply SQL, buyers, tender amounts or a list of orders. Enrolled
scheduled Stripe reconciliation invokes it, including internal-only orders that
a Stripe-only scan would miss. Already-paid historical orders without a new
receipt retain the prior read-only certification path. The owner does not
invent atomic receipts for potentially partial historical settlements.

A withdrawal racing the remote D1 commit can leave a paid, denied order that
requires financial reconciliation/refund. It cannot publish buyer access.
This implementation does not claim a distributed atomic transaction between
D1, Stripe and Durable Object storage.

## Evidence and limits

`check-owner-paid-settlement.mjs` uses the full migrated schema and the actual
Worker/DO handlers. It injects failure at every statement in the mixed-tender,
multi-line batch; tests lost commit acknowledgements, stale cancellation,
balances and rights snapshots, replay, preorder reservations, provider forgery,
concurrent commands, restart, pending-proof exclusion, scheduled recovery and
the original API finalizer with its raw legal writes locked.

The deployed QA campaign provisions only the fixed separate QA database and
expiring per-run Workers. A D1 trigger deliberately interrupts the owner after
the atomic financial commit, then is removed for exact signed-webhook recovery.
Its Stripe TEST key is provisioned privately on the ephemeral owner. No
production owner mode, customer data, live payment or public route is enabled.
Local tests are not a deployed campaign result.

The conservative scanner now inventories 482 SQL sites. All 460 historical
sites retain their dispositions: 426 owner-required, 33 nonauthorizing and one
fixture. The 22 new executor sites are separately **QA-only**, with exact SQL
fingerprints and checked runtime import containment. They are neither hidden
from the scanner nor claimed as production migrations. The release gate still
rejects production activation.
