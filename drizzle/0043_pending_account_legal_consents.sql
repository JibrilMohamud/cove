-- Server-recorded legal consent captured at email sign-up and attached only
-- after Supabase confirms the exact identity and email. User-editable
-- Supabase user_metadata is never evidence of legal acceptance.
CREATE TABLE IF NOT EXISTS pending_account_legal_consents (
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider_id,email)
);
CREATE INDEX IF NOT EXISTS pending_account_legal_consents_expiry
  ON pending_account_legal_consents(expires_at);
