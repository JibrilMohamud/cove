# Fraud risk and tax compliance

Cove treats fraud and tax as separate platform domains rather than scattered checkout flags.
Migration `0034_fraud_risk_tax_compliance.sql` adds the durable records used by the controls below.

## Risk architecture

Risk inputs are normalized into append-only `risk_events` and `risk_provider_signals`. A versioned
`risk_policy_versions` policy converts signals into a 0–100 assessment and one of `allow`, `monitor`,
`challenge`, `hold`, or `block`. Assessments are immutable and supersede prior assessments; policy
changes therefore do not rewrite historical decisions.

The initial domains are:

- **buyer** — processor/Radar risk, payment failures, disputes, refund ratio, promotion velocity,
  gift-card concentration/reuse, confirmed linked accounts, publisher self-purchases, and account
  takeover signals;
- **publisher** — identity/tax/payout readiness, duplicate or infringing content, account/risk links,
  sanctions, and reused payout destinations;
- **community** — review/vote abuse and linked-account evidence without automatically deleting user
  speech;
- **usage** — subscription consumption velocity, impossible consumption, repeated-source and linked
  account behavior before royalty credit;
- **payout** — publisher risk, tax verification, payout verification, and unresolved royalty/rights
  holds before money can leave Cove.

High-risk decisions create explicit `risk_holds` and an investigator `risk_case`; they do not silently
mutate unrelated records. The staff publishing console exposes the case queue, current score/action,
case disposition, active holds, and release controls. Payout holds are re-assessed before release, so
a manual click cannot bypass an unresolved tax, rights, payout-verification, or fraud condition.

### Enforcement boundaries

- checkout may require 3-D Secure, switch Stripe to manual capture, or fail before fulfillment;
- active account/order fraud holds stop commercial EPUB delivery and commercial audiobook playback /
  offline-license issuance;
- publisher risk prevents low-risk auto-approval from bypassing investigation;
- suspicious subscription consumption is not credited to royalties;
- payout items remain held until the active risk policy allows them;
- community manipulation can be de-ranked/held for investigation independently of content moderation.

Risk scores are operational signals, not declarations that a person committed fraud. Staff decisions,
provider results and evidence should remain reviewable and appealable where applicable.

## Entity-link graph

`risk_entity_links` is the shared graph for device, network, payment, identity, payout destination,
content, household, behavioral and manually established relationships. Store hashes or provider
references for sensitive identifiers; do not put full card numbers, bank credentials, government IDs,
or raw identity documents in this graph.

## Customer transaction tax

Customer tax and publisher/payee tax are deliberately separate.

Cove's customer flow currently delegates calculation/transaction/reversal to **Stripe Tax** while Cove
keeps its own immutable evidence and accounting trail:

1. checkout records billing-country/subdivision and a limited postal prefix plus a storefront-country
   evidence hash;
2. Stripe calculates tax against the exact quoted line items;
3. `commerce_tax_records` snapshots calculation totals, jurisdiction/line-item output and hashes the
   provider payload;
4. payment finalization commits the provider tax transaction to the Cove order;
5. refunds create provider reversals and append `commerce_tax_reversals`;
6. `commerce_tax_reconciliation_runs` compares orders and tax records and can repair safe missing links;
7. `commerce_tax_registrations` records where Cove is registered and which external provider/system owns
   the registration/filing workflow.

Cove does **not** infer nexus or statutory registration obligations from sales volume in application
code. Registration, filing, remittance and jurisdictional advice belong in a tax provider/accounting
workflow plus legal/tax review. The registration table is an operational source of truth, not legal
advice.

## Publisher/payee tax

Publisher tax onboarding stores provider references and normalized status only. Cove does not retain
full TINs, SSNs/EINs, tax-form images, or raw provider identity payloads. `tin_last4` is display/audit
metadata only.

A provider adapter posts normalized verification events to `POST /api/fore/tax/provider/webhook` using:

- `x-fore-tax-timestamp`: Unix seconds;
- `x-fore-tax-signature`: `v1=<hex HMAC-SHA256>` over `${timestamp}.${raw_body}`;
- the server-only `FORE_TAX_WEBHOOK_SECRET`.

Timestamps older than five minutes or invalid signatures are rejected. `publisher_tax_verification_events`
are append-only and payloads are retained only as safe normalized JSON plus a hash.

A publisher's royalties are **held**, not fabricated as “100% withholding,” until a current verified tax
profile exists. Once verified, withholding uses versioned `publisher_tax_withholding_rules` selected by
payee residency, income type, form type, effective dates and treaty state. Cove ships no statutory rates;
finance/tax operations must load rates sourced from the selected specialist/tax adviser and create new
effective-dated rules when law or treaty treatment changes.

Every royalty allocation records the exact tax profile and withholding-rule IDs used. Annual/reporting
work is tracked in `publisher_tax_reporting_periods` with gross reportable and withheld totals,
review/ready/filed/corrected states and external filing references. Existing provider-delivered tax
statement files continue to use the immutable `creator_tax_documents` records.

## Operations and access

The risk/tax APIs are under `/api/fore/admin/risk/*` and `/api/fore/admin/tax/*` and require staff RBAC;
do not expose them behind a shared browser token in production. Useful permissions include
`risk.case.read`, `risk.case.manage`, `risk.hold.manage`, `risk.link.manage`, `risk.policy.manage`, and
`tax.compliance.manage`.

Recommended scheduled jobs:

- commerce/Stripe reconciliation: at least hourly;
- customer tax reconciliation: daily and after payment/provider incidents;
- publisher risk refresh: on onboarding changes, submissions, sanctions and payout changes, plus periodic
  re-evaluation for stale provider status;
- publisher tax reporting-period refresh: monthly and before year-end filing/document production;
- payout assessment: every batch build and again before a hold is released.

Provider adapters should be tested in sandbox/test mode. Production webhook secrets, provider API keys,
bank credentials, tax documents, raw TINs and identity documents are server-side secrets or provider-held
artifacts and must never be placed in browser `VITE_*` variables or normal application logs.
