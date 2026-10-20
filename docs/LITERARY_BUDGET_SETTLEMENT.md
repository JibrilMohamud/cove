# Opt-in literary generation budget settlement

Production literary inference reserves prompt characters plus a pessimistic
12,000-character output allowance against daily_units (typically 2,000,000).
Most successful literary profiles are smaller than the reserved allowance.

This candidate allows unused OUTPUT work units to be credited back after a
validated profile is successfully published to the immutable private R2
inference cache. The raw response and validated normalized profile lengths
are conservatively compared. Actual provider token usage and monetary costs
are **not** measured by this model: this is character-work accounting only.

Controlled opt-in: FORE_LITERARY_ACTUAL_UNIT_SETTLEMENT=1 on the runtime
performing literary inference. Disabled by default in every existing
production/staging configuration. The daily_units ceiling is unchanged.

Safety: failed inference, validation failure, interrupted cache upload and
cached inference all receive no settlement. On retry after a successful cache
upload, the cache hit suppresses any repeat settlement. A failed settlement
is logged but cannot make an already completed inference fail.

Risks: throughput rises if the ceiling was the primary cap. This can increase
AI calls, R2 writes, D1 writes and shared-primary load. Before enabling,
run a sustained production-shaped staging campaign, verify actual external
model cost and the daily units ledger, and ensure no degradation to live rights,
reader delivery, checkout, storefront TTFB and music playback. Ideally enable
only after independent Worker scheduling and data-plane admission budgets
are verified. Do not infer commercial readiness solely from lower reservations.
