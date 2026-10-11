-- Record accepted Cove legal text versions for email-created accounts.
-- External OAuth flows are subject to the Terms of Service presented at sign-in;
-- no forged or inferred acceptance record is created for those flows.
CREATE TABLE IF NOT EXISTS account_legal_consents (
  user_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('email-signup','account-acceptance')),
  PRIMARY KEY(user_id,terms_version,privacy_version)
);
CREATE INDEX IF NOT EXISTS account_legal_consents_time_idx
  ON account_legal_consents(accepted_at DESC);
