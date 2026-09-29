# Commercial notifications, secure EPUB delivery, and versioned ownership

This layer separates three concerns that should never be conflated in a commercial bookstore: an event that occurred, a customer's durable ownership terms, and a short-lived right to retrieve bytes.

## Notifications

`notification_events` is the immutable business-event record for customer-facing notification facts. `notification_inbox` is the in-app projection; email, Web Push, and future mobile push are delivered by `notification_delivery_jobs` and immutable attempt records. A unique `(user_id, dedupe_key)` makes producers safe to retry. Workers lease jobs, recover expired leases, use exponential retry, and dead-letter after six attempts. Missing outbound providers suppress the channel rather than pretending it was sent.

Supported event classes are purchase receipts, preorder releases, followed-author releases, wishlist price drops, subscription billing, failed payments, publisher approval/rejection, royalty statements, payouts, review moderation, and account/security alerts. Topic/channel preferences are per user. Security always remains present in the in-app inbox and current security producers also force email when an address exists.

The provider boundary is intentionally external: `FORE_EMAIL_API_URL`, `FORE_WEB_PUSH_API_URL`, and `FORE_MOBILE_PUSH_API_URL` accept normalized jobs. This keeps SMTP/provider SDK credentials out of the application model and allows SES/Postmark/SendGrid, standards-compliant Web Push, and later APNs/FCM to be swapped independently. `FORE_WEB_PUSH_PUBLIC_KEY` is exposed only to authenticated clients for subscription registration; private push credentials remain server-side.

## Entitlement-aware EPUB delivery

Commercial EPUB metadata never contains a permanent signed delivery URL. A request resolves:

`customer -> active entitlement -> immutable ownership snapshot -> resolved publication version -> distribution/recall control -> publisher delivery policy -> registered device/limits -> short-lived grant -> Cove-controlled R2 object`

The grant stores only a SHA-256 hash of a 256-bit opaque bearer token. It expires in 30-3600 seconds by policy, has a bounded use count, can be device-bound, is revocable, and is consumed atomically so concurrent requests cannot exceed `max_uses`. Download starts/denials/grant issuance are audited. Browser/file delivery returns `private, no-store`; redirects use `Referrer-Policy: no-referrer`.

Publisher/license policy can require registered devices, cap **entitlement-scoped** active devices and lifetime downloads per entitlement, disable raw file downloads while retaining browser reading, and select a license-marker watermark. Device activations are tracked per entitlement (rather than incorrectly counting every device on the customer account), and download quota claims use an atomic counter at token use so issuing many grants cannot bypass a publisher limit. The marker is injected into the EPUB as `META-INF/fore-license.json` and deliberately contains no email or payment data. `external_wrapped_key` is modeled but direct delivery fails closed until a real DRM/key-wrapping provider is configured; the application never fakes encryption.

Public-domain Gutenberg and user-upload assets keep the simpler existing delivery path. Commercial catalog EPUBs use grants.

## Versioned ownership rules

Every commercial purchase gets an `entitlement_ownership_records` acquisition snapshot at fulfillment/release. It records the work, exact edition, publication version present at acquisition, update policy, redownload/removal/rights-expiry behavior, annotation behavior, and Biosync behavior. Acquisition snapshots are immutable.

Cove currently sells an **exact edition** entitlement. Publication revisions within that edition are resolved separately:

- `auto_update`: an owner receives the current publication version unless an explicit version pin exists.
- `manual_opt_in`: the purchased/pinned version remains until the owner opts into a newer publication version.
- `preserve_purchased_version`: the entitlement stays pinned to the acquired version.

A publisher changing future update policy does not rewrite acquisition history. Existing explicit pins remain conservative promises to those owners.

Removal and rights expiry distinguish permanent ownership (`purchase`, `gift`, publisher grant) from temporary access (`subscription`/loan). Permanent owners may redownload a removed title under the frozen ownership policy; temporary access is blocked when the storefront edition is no longer available. Temporary access also re-resolves territorial commercial rights both when a grant is issued and when its bearer token is consumed, while permanent ownership deliberately does not become dependent on a later storefront-rights lookup. Staff can set each publication version to `distributable`, `owner_only`, `blocked`, or `recalled`, independently choosing whether existing owners retain delivery. Blocking/recalling without an owner exception revokes outstanding grants.

## Annotations and CFI migration

Annotations remain in the user's library independent of the live storefront version. `annotation_version_anchors` binds a CFI and quote hash to the publication and asset version on which it was created. When a later version is served, Cove auto-migrates only if the old and new EPUB asset SHA-256 are identical; that is an exact CFI migration with 100% confidence. When bytes differ, Cove writes `manual_required` and preserves the source-version anchor rather than guessing and silently moving a highlight to the wrong passage. The schema is ready for a later quote/context matching migration worker.

## Biosync

Commercial Biosync verification is already asset-version-bound. Ownership status now reports whether a verified Biosync link exists for the **resolved ebook asset version**. A publisher EPUB update therefore cannot accidentally reuse a timing map verified against different bytes; a new/verified timing map is required for the new asset version.

## Operations

Apply migration `0032_notifications_secure_delivery_versioned_ownership.sql`. Configure the notification provider bridges and Web Push public key in the deployment environment. Schedule the authenticated publishing worker endpoint `/api/fore/publishing-worker/notifications/deliver` at the same operational cadence as other outbox workers. Staff distribution controls and delivery policy changes are protected by staff publishing permissions. New delivery policies affect new grants; already issued grants carry an immutable policy snapshot until they expire or are revoked.
