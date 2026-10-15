# Real Stripe sandbox fulfillment validation

Passed at 2026-10-15T07:42:51Z in an isolated temporary Stripe sandbox with a $1.00 USD synthetic commercial fixture. All provider objects were `livemode=false`; no real charge or production catalog change occurred. The fixture contains original QA text in local private object storage and a synthetic licensed-rights record and royalty contract.

| Evidence | ID |
| --- | --- |
| PaymentIntent | `pi_3UQjJLEu0p9Mhs4O1Tmmyri7` |
| Cove order | `ord_e3fc6ba6-9062-4e42-94ab-363cae9377af` |
| Signed success event delivered by Stripe CLI | `evt_3UQjJLEu0p9Mhs4O1r6kcgiI` |
| Successful refund | `re_3UQjJLEu0p9Mhs4O17F0Vc7R` |

Verified: the real Cove quote and checkout functions create a PaymentIntent; repeated checkout setup reuses it; Stripe confirms a test payment and delivers a signed success event through its CLI; Cove records a paid order and one purchase entitlement; a protected grant serves the original fixture EPUB; replay does not duplicate fulfillment; another reader is denied; refund revokes new and previously issued delivery; the synthetic contract accrues royalties. No provider calls are mocked in this opt-in integration.

The exercise found and fixed an extra SQL placeholder in Radar risk-signal ingestion and a royalty query ordering by a nonexistent `publishing_publications.created_at` column (the schema uses `published_at`). The local adapter also needed D1's `meta.changes` so its atomic delivery checks model production correctly.

Reproduce with the official Stripe CLI on PATH and out-of-band `COVE_SANDBOX_SECRET_KEY` and `COVE_SANDBOX_PUBLISHABLE_KEY`, then run `node scripts/check-stripe-sandbox-fulfillment.mjs`. The script rejects live keys, isolates all database/object data, verifies real signed events, redacts credential patterns and terminates its listener. Optional `COVE_SANDBOX_REPORT` selects a sanitized JSON report path. It is opt-in and not a credential-bearing default CI job.

Boundary: Stripe Tax was disabled only in this isolated fixture; registrations and real tax collection were not certified. Browser Payment Element input/SCA, live payments, real publisher contracts and production webhook routing remain separate checks. Do not enable paid production Gutenberg products based on this result.
