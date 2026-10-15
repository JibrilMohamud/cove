# Cove commercial services: production go-live gates

**Current catalog:** Gutenberg books only. A public-domain book such as *Pride and Prejudice* (Gutenberg 1342) is a useful accessibility/offline control, not evidence of paid entitlement, Stripe checkout, or licensed EPUB delivery. Do not mark paid commerce operational on the basis of this fixture.

## Release checks
- `npm run typecheck`, `npm run lint`, `npm run test:currency-minor-units`, the existing security and reader/offline regression tests, and the six-device Playwright matrix must pass.
- Verify the production D1 migrations and Cloudflare Worker bundle correspond to the exact Vercel release SHA. Check healthy queues and dead-letter/retry counts after promotion.
- The production account endpoint loads the first bounded page; subsequent library, highlight, and definition pages are fetched on demand. Verify direct reading of a book with more than 100 annotations and large collections under latency and screen-reader testing.
- Validate translations for each public locale with native review and automated completeness checks. An untranslated fallback is not a complete translation; no locale should be advertised as fully supported without review.
- Test keyboard reading navigation, focus restoration, marker activation, live regions, and screen-reader announcements on NVDA/JAWS/VoiceOver/TalkBack. Axe and automated Playwright tests are necessary but not sufficient.

## Stripe (not yet production enabled)
Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, and an explicit `STRIPE_LIVEMODE` (matching publishable and secret key modes) on the *authoritative Cloudflare persistence Worker*. Configure the Stripe webhook to Cove's verified endpoint; never insert real keys into Git or test fixtures. Set the optional `STRIPE_TAX_ENABLED` and related tax settings only after legal/tax review. Start with Stripe test mode, then validate idempotent checkout, webhooks, cancellation, refunds, reconciliation, subscriptions, taxes, and failed payment recovery. Preserve the production checkout fail-closed path until valid credentials and a **licensed, rights-approved paid product** exist. Do not run a real charge merely to test Gutenberg content.

## Email and push (not yet production enabled)
Provide authenticated bridges and secrets for `FORE_EMAIL_API_URL` + `FORE_EMAIL_API_KEY`, `FORE_WEB_PUSH_API_URL` + `FORE_PUSH_API_KEY`, `FORE_WEB_PUSH_PUBLIC_KEY`; optional mobile push uses `FORE_MOBILE_PUSH_API_URL` + `FORE_PUSH_API_KEY`. Configure sending-domain SPF/DKIM/DMARC, opt-out, provider retries/idempotency, endpoint revocation, and sandbox messages before allowing live fanout. Supabase authentication email is separate. Unconfigured providers must retain queued notifications for later retry rather than permanently suppressing them. Reader-presence leases and quiet hours always override outbound delivery, including security alerts.

## Scheduled jobs
The production Cloudflare Worker uses the schedules in `wrangler.backend.production.toml` and `.github/workflows/deploy-persistence-backend.yml`: 5-minute ingestion, 10-minute delivery, hourly author/partner fanout and account-erasure, and daily maintenance/preorder processing. Do not replace or disable those production triggers when deploying.
- Each new queue runner is bounded and continues independently of catalog ingestion; failures are logged and leases handled by queue processors.
- Refund processing remains disabled without a configured Stripe secret. Confirm an on-call owner for stalled or dead-letter jobs, audit trails and service-alert routing before launch.
- Run each queue in a staging environment with duplicate deliveries, temporary provider downtime, and concurrent runner tests.

## Seven-day offline EPUB
The private `FORE_OFFLINE_AUDIO_SIGNING_JWK` belongs only in the production signer configuration. Pin the **public** P-256 verification key in the client after independently retrieving it from the production HTTPS verifier endpoint. Never accept public keys from a downloaded receipt or user-modifiable records as a new trust anchor. Validate seven-day issuance, expiration, online entitlement recheck, renewal, revoked account/device behavior, rollback/tampering, encryption-at-rest, and atomic replacement. A Gutenberg title is not a commercial-rights test; use a synthetic licensed fixture in CI, followed by an approved non-Gutenberg title only after rights clearance.

## Remaining human/provider approvals
Publisher contracts and territory rights, payment processor account/key approval, outbound messaging accounts and domains, native-language translation review, screen-reader QA, tax and refund policy signoff, incident on-call and customer-support playbook. These cannot be replaced by passing source-code tests.
