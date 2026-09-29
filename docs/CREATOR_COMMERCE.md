# Cove creator commerce: royalties, reporting, preorders, and promotions

Cove treats creator commerce as accounting and contract infrastructure, not as a percentage constant attached to a book. The implementation introduced in migrations `0024` through `0027` is designed so a historical sale, usage event, preorder, statement, or promotion can be reconstructed from immutable evidence even after commercial terms change.

## 1. Versioned contractual royalty engine

A royalty agreement has a stable `finance_royalty_contracts` identity and one or more immutable `finance_royalty_contract_versions`. Changing economics creates a new version with a new effective window, `rules_version_hash`, supersession link, reason, splits, and ordered rules. Existing versions, rules, and splits cannot be updated or deleted by database trigger.

Contract selection is effective-date based and chooses the most specific applicable contract in this order: product, edition, publisher, then broader/default terms; territory, format, and sales-channel scope further narrow the match. Inside the selected contract version, rules are evaluated by priority. Rule conditions can match territory/exclusions, publisher, product, format, sales channel, rights basis, promotion type, promotion funding source, distributor, subscription plan, and list/customer-price bands.

Rule actions can choose a calculation basis (`list_price`, `customer_price`, `net_receipts`, or `gross_value`) and override royalty rate, Cove commission, flat per-unit royalty, reserve, payment terms, tax treatment, processor/distributor-fee treatment, and Cove/publisher discount-funding treatment. Beneficiary splits must allocate exactly 10,000 basis points.

For every economic event, `finance_royalty_calculations` freezes the exact contract/version/hash, selected rule, territory, format, channel, prices, tax, processor/distributor fees, promotion funding, net receipts, commission, royalty pool, input snapshot, and rule trace. `finance_royalty_allocations` then freezes each party's share, reserve, withholding, payable amount, currency, and availability date. Corrections are reversals/new calculations or new contract versions; prior economics are never rewritten.

A simple contract can therefore reproduce an example such as a $9.99 customer price less $0.80 tax, $0.35 processor fee, and $2.50 Cove commission, producing $6.34 of publisher royalty pool. The same engine can instead apply a different effective rule for a particular territory, title, format, promotion, subscription plan, distributor, wholesale channel, or public-domain rights basis.

Processor fees are allocated to order lines before royalty accrual. If required fee economics are not yet available, royalty accrual is deferred for reconciliation rather than calculated from incomplete inputs. Publisher-, Cove-, and shared-funded discounts are recorded separately so a campaign cannot silently alter the wrong party's royalty basis.

Subscription, audiobook, library, wholesale, and agency economics enter through idempotent `finance_usage_events`. Processed usage is immutable. Usage pools can model pool-funded programs, with pool terms frozen after locking; the royalty engine then evaluates the resulting economic value under the applicable contract version.

Copyright/rightsholder holds operate on the canonical royalty allocations as well as legacy compatibility records. Held allocations cannot settle until the applicable dispute releases them.

## 2. Creator reporting and definitive statements

`GET /api/fore/publishing/dashboard` is the operational creator dashboard. It exposes selected-period and current-UTC-day sales, units, gross revenue, discounts, refunds, estimated royalties, title/territory breakdowns, preorder state, subscription pages/units, audiobook listening, library usage, wishlist activity/conversion proxies, promotion performance, payout status, statements, and tax-document metadata.

Operational dashboard numbers are estimates/current state. Definitive monthly accounting is represented by `finance_statements` plus append-only `finance_statement_revisions`. Final/corrected revisions freeze a statement snapshot and SHA-256 hash. The definitive CSV endpoint:

`GET /api/fore/publishing/statements/:statementId.csv?accountId=...`

uses the revision's calculation cutoff and immutable royalty calculations/allocations so regenerating an old statement cannot pull in a later-posted transaction. The response includes both the statement snapshot hash and export hash. Sales and royalty CSV exports remain available for operational analysis over arbitrary date ranges.

Tax documents are represented as provider-generated creator records and are downloadable only when their status and object reference indicate a real available document. Cove does not synthesize tax forms from dashboard estimates.

## 3. Preorder lifecycle

A future approved publication can materialize a `preorder_release_plan` with an opening time, release time, manuscript deadline, payment timing, lowest-price policy, cancellation policy, and failure policy. The worker endpoint `POST /api/fore/publishing-worker/preorders/tick` advances scheduled plans through open, locked, released, or failed states.

Cove currently supports charge-now preorders. A paid preorder creates a reservation and order/royalty evidence, but **does not grant a reading entitlement before release**. Charge-at-release is intentionally fail-closed until a production payment-method vault/mandate implementation is configured.

Checkout revalidates preorder eligibility immediately before payment. Application checks plus database triggers prevent more than one active preorder for the same customer/product. Customer-facing product state distinguishes not-yet-open, available, and already-preordered states.

The lowest-price guarantee tracks each reservation's guaranteed price. Qualifying post-purchase price drops create immutable price-adjustment records and refund jobs. `POST /api/fore/publishing-worker/preorders/refunds` executes those jobs through Cove's idempotent refund path. Customers may cancel eligible preorders before release; publisher cancellations generate refunds and compliance incidents.

Release-date changes affecting existing reservations are recorded in an append-only change ledger and produce notification-outbox events. At release time, the worker verifies that the publication artifact is actually publication-ready before granting entitlements. Failure produces a publisher incident, marks affected reservations as failed, and queues automatic refunds. Incident severity scales with affected preorder volume and is available to publishing operations for penalties/restrictions.

## 4. Promotion and deal lifecycle

Promotion campaigns support scheduled price drops, daily deals, genre sales, publisher sales, coupons, free promotions, first-in-series offers, bundles, launch pricing, seasonal campaigns, and countdown deals. Campaigns are version-bound to an active Cove promotion-policy record.

A campaign begins as a publisher-editable draft. Product ownership, territorial retail rights, and contractual promotion restrictions are checked before save/submission. Submitted terms and product sets are locked; a staff member with `promotions.review` must approve or reject the campaign. Approved campaigns become scheduled/live according to their dates and are materialized by `POST /api/fore/publishing-worker/promotions/tick`. The `/staff/publishing` console exposes the permission-gated merchandising review queue.

Funding is explicit: publisher, Cove, or shared. Per-campaign/per-product funding basis points flow into checkout and then into royalty calculation snapshots. Budgets and redemption ceilings are enforced. Coupon campaigns generate codes only through an explicit publisher action; Cove does not create guessable codes automatically.

Campaign attribution records impressions, clicks, wishlist adds, cart adds, orders, refunds, revenue, and funding. Storefront events use dedupe keys, campaign/product validation, and active-window checks. Creator reporting therefore exposes a measurable campaign funnel rather than only attributed purchases.

Price changes are connected to preorder lowest-price guarantees and to Cove's notification outbox, allowing downstream price-drop alerts and limited-time/countdown presentation without bypassing accounting.

## 5. Operational/auth boundaries

Creator endpoints require membership in the publishing account. Finance contract/statement operations require staff permissions. Promotion approvals use individual staff identities and `promotions.review`; promotion-operations reads use `promotions.operations.read`. Publishing workers remain separately authenticated from browser staff sessions.

The commerce ledger, royalty calculation evidence, statement revisions, preorder events/price adjustments, promotion campaign events, and promotion attribution are append-only where their historical meaning requires it. Workflow status fields may advance, but historical economics and evidence are not edited in place.

Production scheduling should regularly run:

- `/api/fore/publishing-worker/preorders/tick`
- `/api/fore/publishing-worker/preorders/refunds`
- `/api/fore/publishing-worker/promotions/tick`
- the existing publishing release/validation, rights-deadline, notification, reconciliation, and payout jobs

## 6. Deliberate future boundaries

The architecture is ready for additional contractual rules without replacing the accounting model. Production expansion can add FX settlement contracts, distributor statements/imports, richer subscription/library pool allocation, country-specific withholding/tax providers, reserve-release schedules, payment-vaulted charge-at-release preorders, bundle entitlement orchestration, publisher-facing campaign applications/merchandising inventory, and externally generated tax-document delivery.

Those are provider/operational extensions. They should feed new immutable events or contract versions rather than introduce hidden constants into checkout or overwrite prior royalty results.
