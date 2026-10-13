-- Member shares grant access only to an authenticated named recipient.
CREATE TABLE reading_journey_recipients (
  journey_id TEXT NOT NULL REFERENCES reading_journeys(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(journey_id,recipient_user_id)
);
CREATE INDEX idx_journey_recipient ON reading_journey_recipients(recipient_user_id,revoked_at,updated_at);
