-- Durable contact inbox for privacy-rights requests and legal notices.
-- Authentication is not required: deletion/access requests must remain
-- possible even when a person cannot sign into an account.
CREATE TABLE IF NOT EXISTS legal_contact_requests (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('privacy-access','privacy-delete','privacy-correction','privacy-choice','privacy-other','terms','other')),
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','in-review','resolved','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS legal_contact_state_time_idx ON legal_contact_requests(state,created_at DESC);
