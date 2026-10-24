-- Physically separate from cove-production, commerce, literary and presentation D1.
-- No customer session, rights-grants, subscription or order tables belong here.
CREATE TABLE IF NOT EXISTS music_contracts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
  licensed_origin TEXT NOT NULL,
  allowed_territories_json TEXT NOT NULL CHECK(json_valid(allowed_territories_json)),
  expires_at TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  rights_json TEXT NOT NULL CHECK(json_valid(rights_json)),
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_contract_due
  ON music_contracts(status,expires_at,id);
CREATE TABLE IF NOT EXISTS music_masters (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES music_contracts(id),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('quarantined','staged','quality_passed','revoked')),
  bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=26214400),
  mime TEXT NOT NULL CHECK(mime IN ('audio/ogg','audio/mpeg')),
  storage_key TEXT,
  quality_key TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_masters_qualifying
  ON music_masters(status,contract_id,id);
CREATE TABLE IF NOT EXISTS music_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  master_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_events_contract
  ON music_events(contract_id,created_at,id);
CREATE TABLE IF NOT EXISTS music_publication_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  master_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('master_qualified','master_revoked','contract_revoked')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_publication_outbox_cursor
  ON music_publication_outbox(created_at,id);
