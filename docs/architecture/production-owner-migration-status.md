# Production owner migration: reviewed work and remaining blockers

Source baseline: `e463c0e7903ff0b784901962d778b2dda2243b36`, October 28, 2026.
This record does not certify or activate Cloudflare public routing.

## Mutation inventory reconciliation

`canonical-writer-review.json` records every one of the existing 458 scanner
candidates with its file, line, named function, table, operation, exact SQL
digest, disposition, rationale and proposed command family. The identity also
binds the surrounding source file: changing the caller or its guards requires
fresh review even if its SQL and the total count are unchanged.

| Priority file | Candidates | Owner-command migration required | Non-authorizing |
| --- | ---: | ---: | ---: |
| `publishing.server.ts` | 88 | 88 | 0 |
| `commerce.server.ts` | 66 | 66 | 0 |
| `publishing-trust.server.ts` | 58 | 53 | 5 |
| `traditional-publishing.server.ts` | 58 | 47 | 11 |
| Other 21 files | 188 | 179 | 8 |
| Total | 458 | 433 | 24 |

The remaining one candidate is the temporary browser-QA database seed.
All 458 are SQL literals, so the fixture is an applicability false positive,
not a nonexistent SQL statement. The 24 ancillary writes are specific audit
records, legal-notification/partner-response delivery status, credential
`last_used_at`, and presentation-only ratings/rankings/taxonomy updates.
Classification does not grant an exemption to arbitrary writes in these
tables, and does not change the runtime write lock or release-denial scanner.
The 433 rows are conservative migration requirements, not proven defects.

**No production SQL site is claimed as owner-guarded.** Conditional D1
updates, terminal-state triggers and opt-in QA owner calls are useful controls
but do not establish complete production ownership. Dynamic SQL, deployed
older Workers, administrative tooling and direct operator access also require
independent review beyond this static inventory.

## Paid-owner handler corrections

The single-entitlement publication endpoint now independently counts the
canonical order's deliverable items. It refuses a multi-delivery cart, which
must use the single atomic order-publication transaction. This closes a path
that could publish a valid first book while another book fails certification.
The endpoint also checks the canonical purchase territory, channel and
non-preorder scope.

Both publication handlers reject future, expired and malformed entitlement
time windows. A multi-item owner lease is bounded by each entitlement's own
expiry as well as the legal proof's expiry and the five-minute owner lease.
The original offline EPUB signer now independently reloads the exact
grant-bound buyer entitlement and bounds its signed receipt by the shorter
of seven days and that entitlement's expiry. Invalid or revoked windows
cannot mint a new signed receipt.

`check-paid-owner-worker-handlers.mjs` bundles the actual Worker entrypoint
and Durable Object class, substitutes only the Cloudflare host adapter, and
uses separate primary and owner SQLite stores. It covers partial-cart bypass,
expired/future/malformed dates, lease bounding, exact buyer, replay, refund
against stale canonical rows, withdrawal during primary reads, and outage.
This is executable handler coverage, not a hosted production certificate.

## Original customer-media isolated QA coverage

The signed Stripe TEST full-schema campaign now additionally executes the
actual Cove `issueCommercialEpubGrant`, `serveCommercialEpubGrant`,
`issueOfflineEpubLicense`, and `handleCommercialAudio` handlers via
strictly scoped, expiring private QA ingress. The synthetic buyer has a
real original pending-payment -> signed webhook -> ledger -> private owner
entitlement path. Synthetic registered-device, EPUB asset-version, narrated
audio publication manifest, agreement/evidence and private R2 fixtures are
provisioned **only on the distinct QA D1**; nothing is routed to a customer.

The first deployed branch campaign (#40774928835) proved matching original
EPUB R2 SHA-256 bytes and audiobook HTTP 206 ranges, offline receipt issuance
and format-specific signature verification, owner outage fail-closed behavior,
and refund blocking old online EPUB grants, fresh EPUB/audio bytes and online
license issuance/verification. Offline receipts already on a disconnected
device remain usable until their signed expiration; they are not retroactively
revocable without reconnecting. The QA run also cleaned its ephemeral Workers.

This closes the previous **QA adapters only** limitation for the tested
original handlers. It does **not** certify the customer production deployment,
production owner writer closure, all combinations of publisher licenses,
offline disconnected revocation, or commercial routing. A production-equivalent
customer journey and release decision remain required.

## Publication activation command increment

The typed `/publication/activate-version` command runs the original canonical
multi-table activation implementation inside the private owner. A durable
product denial and pending-command journal precede every primary write.
Independent positive publication is blocked while that hold is pending.
Retiring prior grants or a publication-managed contract also receives a
durable subject-level withdrawal before any primary write. That withdrawal
immediately covers other products sharing the retired rights, including
legacy manifests whose grant list must be resolved from their contract.
Completion releases the hold only after checking the canonical activation
marker; legal and offer publication then independently re-read current
evidence and verify the owner epoch. A withdrawal during execution defeats
completion and cannot be undone by replaying the old command or changing
only its transport ID.

An interrupted partial primary activation remains denied and requires repair;
the owner never blindly repeats partial writes. Automatic recovery is limited
to the same immutable command whose canonical activation marker is complete.
The owner independently checks publisher compliance, staff permission for
staff/rollback commands, manifest identity and scheduled release time.

Enrolled scheduler activation and rollback callers dispatch this typed
command. Enrollment remains isolated-QA-only. Initial materialization,
preorder transitions, submission/moderation, trust, contract and other
commercial writers remain open migration work. This increment closes no
production SQL site in the 458-candidate inventory.

The production persistence deployment config now includes the separate
production `LEGAL_AUTHORITY` namespace. Authenticated pre-deploy checks
require production D1 `4bd657ac-8789-403e-a28c-93aba8d0a989`, namespace
`83d7eadf3957436389a7b072120a9829`, and owner enablement `0`. Post-deploy
checks require the persistence binding to resolve to that same namespace.
Binding the disabled owner does not enable production authorization. A random
256-bit private `COVE_RIGHTS_OWNER_SECRET` was provisioned on the production
owner and persistence Workers on October 28, 2026, and both secret-text
binding names were verified by the Cloudflare settings API. The key itself
was not returned or logged. Binding presence alone is not an authenticated runtime handshake.
A separate **disabled-state attestation implementation** now uses the
backend-token-authenticated persistence path
`POST /__cove/legal-owner/attest-disabled` to send an unpredictable
128-bit challenge to the exact privately bound production Durable Object.
The actual DO and Worker service accept that challenge only with the
production D1 identity, owner switch `0`, an absent QA lease and the private
owner secret. The backend rejects wrong nonce, owner state, implementation or
canonical primary identity. All protected legal, publication and payment
operations still return 503 in this mode. Unit coverage bundles the real DO
and proves replay, spoofing, wrong secret, QA-primary and protected-operation
denial. A real authenticated invocation against the deployed persistence
Worker is still necessary to certify the *live* handshake, independent
of the binding metadata audit.

This proves neither production owner-write fencing nor positive publication.
The 433 protected writer sites still require migration or verified closure
before any owner-only storefront or customer authorization is enabled.

`check-publication-owner-command.mjs` exercises the actual activation and
owner handlers against the fully migrated schema. It covers denial before
every write, competing publication, replay, restart recovery, primary and
owner outages, concurrent withdrawal, wrong staff, expired compliance and
premature scheduling. `test-production-owner-binding.mjs` rejects wrong and
QA resources as well as premature owner enablement.

## Required implementation and certification still open

1. Implement the recorded command families and fenced executors for all
   protected writers. Preserve API, webhook, cron, ingestion, moderation,
   preorder, financial and administrative behavior. A deny-all switch is not
   a replacement for these paths.
2. Give the separate production owner a production identity, authentication
   and operational fencing protocol; certify positive publishing and
   deny-first withdrawals. The currently deployed owner remains disabled.
   Persistence binding is now configured with exact live pre/post checks;
   owner enablement and production certification remain separate blockers.
3. Run the signed Stripe TEST customer journey against the production
   implementation with isolated production-equivalent state, including
   original EPUB/audio/offline paths, multi-item settlement, refund,
   chargeback, repurchase and owner outage. Local handler tests do not prove
   the real provider or customer media journey.
4. Deploy the exact fully configured nonpublic SSR candidate, test it through
   the protected owned canary, and pass all hard latency, two complete
   100-RPS phases, 32-concurrent and ORD/LAX/IAD/DFW repeatability gates.
   Current hosted results fail. Keep all failed samples in the evidence.
5. Rehearse Vercel rollback with live authorization and cache consistency.
   Only certified evidence can authorize attaching the public hostnames.

## Offline policy for the migration

Current EPUB receipts permit at most seven days (`OFFLINE_EPUB_MAX_MS`).
Current audio issuance and verification permit up to thirty days. A generic
"seven-day offline license" statement therefore does not describe both
formats. The migration preserves those existing format-specific limits:
**seven days for EPUB and thirty days for audio**, bounded by any shorter
applicable entitlement expiry. Do not silently invalidate existing signed
receipts or promise immediate disconnected revocation.

An isolated device cannot learn an online withdrawal before reconnecting;
already downloaded signed receipts can remain usable to their authenticated
expiry. Renewals, verification while online and new deliveries must deny
withdrawn access. Immediate disconnected revocation cannot be certified.
These durations and the reconnect requirement must be visible at the offline
download action before public routing is certified. Production enforcement of
the online owner remains part of the open migration above.

## Verification commands

Run `node scripts/reconcile-canonical-writers.mjs` and
`node scripts/test-canonical-writer-review.mjs` for exact review drift, along
with the original `test-canonical-writer-closure.mjs` release-denial tests.
Run `check-paid-owner-worker-handlers.mjs`, the paid entitlement/atomic order,
staged settlement, commercial owner, market closure, customer media ordering,
quarantine writer and terminal Stripe tests, then `npm run typecheck` and
`node scripts/build-storefront-strangler.mjs`.
Run `check-offline-epub-issuer-expiry.mjs` and the licensed-EPUB receipt/client
tests for the original signer and offline expiry/renewal behavior.

Infrastructure and current failing hosted evidence are recorded in
[`cloudflare-commercial-cutover-gate.md`](../performance/cloudflare-commercial-cutover-gate.md).
