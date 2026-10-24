# Per-job literary quota refunds and AI-provider usage

**Status: opt-in code, not an enabled production migration or a billing system.**

## Ledger ownership and invariants

The existing primary and isolated literary budget ledgers already use a
transactional `literary_output_settlement_receipts` table keyed by an R2
cache key. That table remains for backward compatibility. The new isolated
inference lane uses a **different, CONTENT_DB-only** table keyed by the
immutable 64-character literary **inference job ID**.

Apply `infra/content-budget/0009_job_settlements_and_ai_usage.sql` to the
independent CONTENT_DB after the 0001 ledger and 0006 inference-job schemas.
Never apply it to canonical primary D1, copy rights into CONTENT_DB, or
change a production feature flag as part of a schema installation.

For the isolated worker with
`FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT=1`, a newly generated, validated
inference output must win its **create-if-absent R2 PUT** before settlement.
The immutable job ID, exact R2 object key and SHA-256, current secondary
lease token, live independent domain identity and activated UTC budget day
are checked at receipt insertion. The table has a primary key on job ID
and a unique R2 key. A SQLite AFTER INSERT trigger deducts the unused
character-work units from the independent daily reservation **in the same
SQL statement**. A duplicate INSERT creates no credit; an unfunded or
closed-day credit ABORTs and cannot leave a credited receipt. Failed
settlement retains the pessimistic reservation and does not block inference.

Previously published/cache-hit R2 results and R2-write-race losers are
not given new credits. No credit can increase the existing configured
daily cap. The legacy aggregate helper is also hardened against a
larger-than-funded refund (no `MAX(0, reserved_units-refund)` truncation).

## Real usage metrics are separate

With `FORE_LITERARY_AI_USAGE_TELEMETRY_ENABLED=1`, each **actual** Workers AI
`run` response is separately recorded in CONTENT_DB's
`literary_ai_invocation_usage`, with a distinct invocation UUID even when
the inference job is retried. Store only model, job ID, time and reported
metrics; never store prompts, chapters, protected EPUB bytes, or output text.

`input_tokens`, `output_tokens`, `billed_neurons` and
`provider_cost_usd` are populated **only** when returned as valid
nonnegative values by the AI provider. Missing metrics are stored as NULL
and are **not** guessed from characters or model output size. A telemetry
write failure cannot block the inference; its warning must be monitored.
Use [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
and the Cloudflare AI dashboard / AI Gateway usage analytics to reconcile
actual charges and neurons. The character-work budget is *not* monetary
billing or a reliable proxy for real model token counts.

## Validation and activation hold

Run `node scripts/check-literary-job-settlement.mjs`, the legacy
settlement suite, isolated-inference/rights tests, TypeScript, and
prettier/eslint before considering any rollout. The test exercises
concurrent replay, duplicate job IDs, the R2 job-key identity,
unfunded/closed-day refusal, stale lease refusal, provider-reported
vs unknown metrics, and two physically separate SQLite databases.
In real staging, confirm Cloudflare D1 executes the migration/trigger and
capture actual model usage metadata or the absence thereof before
setting either opt-in flag. Do not claim geographic or 100-RPS release
acceptance from local SQLite fixtures.
