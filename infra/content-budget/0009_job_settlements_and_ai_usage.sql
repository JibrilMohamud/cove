-- CONTENT_DB ONLY. Install after independent ledger (0001) and inference jobs (0006).
-- Each immutable SHA-256 job identity receives at most one credit, regardless
-- of retries, lease replacement, or repeated settlement requests.
CREATE TABLE IF NOT EXISTS literary_job_output_settlements (
  job_id TEXT PRIMARY KEY NOT NULL CHECK(length(job_id)=64),
  day TEXT NOT NULL,
  result_key TEXT NOT NULL UNIQUE,
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64),
  prompt_characters INTEGER NOT NULL CHECK(prompt_characters>=0),
  output_characters INTEGER NOT NULL CHECK(output_characters>=0),
  reserved_output_characters INTEGER NOT NULL CHECK(reserved_output_characters>=0),
  refund_units INTEGER NOT NULL CHECK(refund_units>=0),
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS literary_job_settlement_day
  ON literary_job_output_settlements(day,applied);

-- Provider-observed metrics are separate from character-work allocations.
-- NULL means the provider did not report that exact metric. Do not estimate
-- model tokens, neurons or USD from the count of text characters.
CREATE TABLE IF NOT EXISTS literary_ai_invocation_usage (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL CHECK(length(job_id)=64),
  model_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  billed_neurons REAL CHECK(billed_neurons IS NULL OR billed_neurons>=0),
  provider_cost_usd REAL CHECK(provider_cost_usd IS NULL OR provider_cost_usd>=0)
);
CREATE INDEX IF NOT EXISTS literary_ai_usage_job
  ON literary_ai_invocation_usage(job_id,observed_at);

-- The credit and the immutable receipt are a single SQLite statement.
-- A duplicate job_id is ignored, so the trigger never fires a second time.
-- If the debit has insufficient reserved units or the day is fenced, RAISE
-- rolls back the INSERT; there can be no orphaned applied receipt.
CREATE TRIGGER IF NOT EXISTS literary_job_settlement_credit
AFTER INSERT ON literary_job_output_settlements
BEGIN
  UPDATE literary_profile_budget
  SET reserved_units=reserved_units-NEW.refund_units
  WHERE day=NEW.day AND reserved_units>=NEW.refund_units
    AND EXISTS (
      SELECT 1 FROM literary_budget_cutover
      WHERE day=NEW.day AND status='active'
    );
  SELECT CASE WHEN changes()<>1
    THEN RAISE(ABORT, 'literary_job_settlement_unfunded') END;
END;
