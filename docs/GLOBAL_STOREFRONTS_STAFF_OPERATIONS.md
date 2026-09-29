# Global storefronts and privileged access

## Storefront context

Cove resolves one server-side storefront context for every request. It contains the legal rights country, presentation market, locale, currency, text direction, tax-display convention, regional merchandising/recommendation region, checkout availability, payment-method registry, and the active UI translation bundle.

The legal `rightsCountry` is deliberately separate from a reader preference. `CF-IPCountry` (or the trusted deployment fallback) anchors territorial browsing/delivery. A locale/currency cookie may change presentation but cannot unlock another country's catalog. A saved country marked by a trusted billing/account adapter can be treated as verified storefront evidence, while checkout still recomputes rights and tax from the submitted billing country. Ordinary user preference writes cannot manufacture that trust state, and locale/currency-only edits preserve an existing trusted country source.

`storefront_markets`, `storefront_locales`, `storefront_market_locales`, `storefront_currency_options`, and `storefront_payment_methods` are the policy tables. Do not encode country behavior in React conditionals. A market can be paused or have checkout disabled without taking its localized catalog offline.

## Translation lifecycle

UI strings live in versioned `ui_translation_bundles` + `ui_translation_messages`. `en-US` is the source-key reference. Activation calculates source-key coverage and refuses a bundle below its required threshold. Locale records define `ltr`/`rtl`; the app sets `<html lang>` and `<html dir>` and uses logical/mirrored navigation behavior.

A normal release flow is: create draft bundle -> professional/local review -> automated key/placeholder QA -> activate a new version -> watch errors/conversion -> retire old version after rollback window. Do not overwrite a historical active version in place.

Taxonomy identity remains global while names/descriptions/SEO fields localize through `storefront_taxonomy_node_localizations`. Merchandising already targets territory/language/audience, and recommendation metrics are regional rather than treating global popularity as universal.

## Regional price and tax rules

Publisher-supplied regional list prices are first-class. Cove does not require an FX quote when an active regional price schedule exists. FX is required only when a price must be derived from another currency. Checkout performs a fresh rights + pricing decision and Stripe Tax uses the billing address; the storefront market's `tax_inclusive` setting controls presentation semantics rather than replacing tax calculation.

Only payment methods marked `available` are advertised in storefront context. Stripe PaymentIntents use automatic payment methods so Stripe can further filter by merchant configuration, currency, country, and eligibility. Methods in `planned` state are intentionally not presented as live.

## Human staff access

Human administration never uses a shared operator bearer token. `staff_principals` bind the authenticated account to optional SSO provider/subject and MFA policy. `staff_principal_roles` and `staff_role_permissions` grant narrowly scoped capabilities. Seeded operational roles include:

- `catalog_reviewer`
- `community_moderator`
- `publisher_support`
- `finance_operator`
- `fraud_investigator`
- `storefront_editor`
- `operations_engineer`
- `super_admin`

`super_admin` is a break-glass capability because `staff.manage` satisfies any staff permission. Keep membership extremely small, require MFA/SSO, and monitor all usage. Routine staff should receive the narrow role that matches their function.

`privileged_access_audit` records authorized/denied staff and service-principal access with request IDs, permission/scope, method/path and privacy-minimized client evidence. Domain-specific actions also keep their existing append-only audit histories.

## Machine identities

Workers are `service_principals` (service-principal machine identities), not fake staff accounts. Each principal owns explicit scopes and independently rotated credentials. Credential plaintext follows:

`fore_svc_<prefix>.<32-byte-base64url-secret>`

Only the prefix and SHA-256 digest are stored. The plaintext is returned once when an authorized staff member issues the credential. Store it in the workload secret manager as `FORE_SERVICE_TOKEN`. Never put it in client code, source control, D1, logs, or a human password manager shared across teams.

Recommended production separation:

- catalog pipeline: `catalog.ingest`, `search.reindex`, `pipeline.process`
- audio pipeline: `audio.ingest`, `audio.prepare`
- publishing worker: `publishing.worker`, `partner.feed.process`, `notifications.deliver`
- operations scheduler: `operations.check`, `operations.synthetic`, `operations.queue`, `operations.backup`, `operations.alert`

Rotate with overlap: issue new credential -> deploy worker -> confirm new `last_used_at` -> revoke old credential. Prefer <=90 day credentials. Separate production/staging principals and secret stores.

`FORE_STAFF_BOOTSTRAP_TOKEN` is not a routine operator credential. It exists only to provision/recover staff administration. Disable or rotate it after bootstrap and treat use as a security event.
