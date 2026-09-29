# Commercial audio, account security, and customer support

## Commercial audiobooks

Commercial audiobooks are separate from Cove's Project Gutenberg/public-domain ingestion. A commercial audiobook is a publishing edition with an immutable publication snapshot containing its commercial audio manifest, rights evidence, narrator agreements, QC evidence, territory, price/offer state, and active policy version.

### Rights and credits

A release requires an audio publisher, phonorecord/copyright notice, identifier, credits, a performance-rights basis, and staff-verified rights evidence for the same edition. The audio performance-rights territory must match the edition's distribution territory. Narrators are modeled explicitly as human, synthetic, or mixed. Synthetic/mixed narration requires a customer-facing voice label.

Narration agreements are immutable evidence. They record signed date, optional expiry, territories, permitted commercial uses, agreement type, and verified evidence. Termination or supersession is a separate append-only record; Cove never edits the signed agreement in place. Readiness evaluates the *effective* agreement set per narrator, territory, and enabled distribution use.

### Audio QC

`commercial_audio_policy_versions` is versioned and immutable. The initial Cove policy requires chapter/section files, consistent channels, 44.1 kHz audio, MP3 at >=192 kbps CBR, RMS from -23 to -18 dB, peak <= -3 dB, noise floor <= -60 dB, and a 30-300 second preview.

Publisher-uploaded media and declared technical metadata are not trusted. Files enter quarantine. A leased audio worker reads the stored object, performs malware/content checks and audio measurement, and returns the SHA-256 of the exact bytes it scanned plus measured duration/encoding/loudness. Cove compares that hash with the upload manifest before marking the object clean. Failed scans remain rejected. QC runs are immutable.

### Playback, offline use, and royalties

Commercial track media is authorized at the media endpoint. A storefront listing alone does not grant audio access. Sale/subscription access uses Cove entitlements and territory checks. Offline licenses require a purchase entitlement, an active registered device, the edition's offline permission, and the entitlement device ceiling. Offline licenses are device-bound, expiring, refreshable, and revoked with the device or entitlement.

Audiobook retail sales use Cove's versioned royalty-contract engine; the format/channel can select different contractual rules. Subscription/library usage events can be accounted through the same finance usage/royalty infrastructure rather than a hard-coded audiobook percentage.

### Biosync

Commercial Biosync is available only for an active ebook+audiobook pair with verified timing evidence. Cove freezes the active ebook manuscript asset version and the active commercial-audio manifest hash into the link. The timing object is checksum-verified and schema-validated; cues must reference valid audio chapters, stay within measured durations, use EPUB CFI locations, remain monotonic/non-overlapping, and meet coverage requirements.

Customer handoff requires active **purchase entitlements for both formats**. Reading/listening position uses optimistic versioning so two devices cannot silently overwrite newer progress.

## Customer account management

`/account/management` is the commercial account surface; the older `/account` context endpoint remains compatibility-safe.

Cove owns preference, audit, session-observation, device and deletion state. Sensitive authentication/payment material stays provider-backed:

- email/password changes are performed through Supabase Auth;
- TOTP MFA uses provider enrollment/challenge/verification;
- passkeys use Supabase's WebAuthn endpoints and are marked experimental/additive rather than the only recovery factor;
- Cove never stores raw MFA secrets, card numbers, payment tokens, or reusable auth tokens;
- billing methods store only provider references and masked display fields;
- Stripe Billing Portal is used for provider-backed payment-method management when configured.

Account management includes active observed sessions, sign-out-other-sessions, explicit devices/revocation, billing methods, addresses, order/refund history, subscriptions, gift/store-credit balances, storefront country, privacy/marketing/notification preferences, downloadable data export, and cooling-off account deletion.

Deletion is fail-closed when legal/operational obligations remain (for example an open chargeback, active subscription, active staff identity, or publisher owner/admin authority). Execution removes reader/profile/preferences data and pseudonymizes retained commerce/audit records rather than deleting accounting evidence required for legitimate business/legal purposes.

Staff and high-risk publisher/legal operations require AAL2/MFA.

## Customer support operations

Customer support is an identity-bound staff application, not an operator bearer-token endpoint. Every action must attach to a support case and is written to immutable case-event/action ledgers with staff identity, target, reason code, rationale, before/after state, idempotency key, and provider reference where relevant.

Search supports users, orders, payments, refunds, products, publishers, entitlements, devices, and offline licenses. Permissioned case actions include:

- resend receipt through the durable notification/outbox path;
- refund through the same idempotent commerce refund function used by normal operations;
- restore/revoke entitlement only when trust/payment state permits;
- read-only download diagnostics for device, entitlement, license expiry and product availability;
- revoke device/requeue an offline license rather than bypassing license checks;
- inspect payment attempts/status with a separate payment-read permission;
- reset a genuinely stuck non-live publication without overriding suppression/takedown/retirement;
- escalate account recovery through an audited recovery event.

Support-console access itself requires AAL2. Support cannot restore a copyright-suppressed title, defeat a chargeback/refund boundary, mint an entitlement without an auditable case action, or bypass commercial-media authorization.

## Workers and operational schedules

Production deployments should run authenticated workers for:

- commercial audio QC lease/measurement completion;
- account deletion queue processing;
- notification/outbox delivery;
- finance usage/royalty and payout reconciliation already documented elsewhere.

Worker credentials must remain separate from customer/staff sessions and should be rotated/secret-managed by the deployment platform.
