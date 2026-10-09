-- Runtime configuration stores non-secret fingerprints and deploy-time control metadata.
-- Secret plaintext values remain in their respective deployment secret managers.
CREATE TABLE cove_runtime_config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
