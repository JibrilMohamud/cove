-- Short-lived, private reader heartbeat. No title or page contents are stored.
CREATE TABLE IF NOT EXISTS reader_notification_silence (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,client_id)
);
CREATE INDEX IF NOT EXISTS idx_reader_notification_silence_expiry
  ON reader_notification_silence(expires_at);
