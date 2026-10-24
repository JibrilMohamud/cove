-- Off-by-default, non-playable music supply handoff into canonical D1.
-- No JOIN to customer soundtrack/audio/entitlement tables. No playback changes.
CREATE TABLE IF NOT EXISTS music_supply_handoff_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL UNIQUE CHECK(seq>0),
  contract_id TEXT NOT NULL,
  master_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('master_qualified','master_revoked','contract_revoked')),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS music_supply_handoff_contracts (
  contract_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  expires_at TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  last_seq INTEGER NOT NULL CHECK(last_seq>0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS music_supply_handoff_masters (
  master_id TEXT PRIMARY KEY NOT NULL,
  contract_id TEXT NOT NULL,
  master_sha256 TEXT CHECK(master_sha256 IS NULL OR length(master_sha256)=64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL CHECK(status IN ('pending_media','revoked')),
  last_seq INTEGER NOT NULL CHECK(last_seq>0),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS music_supply_handoff_pending
  ON music_supply_handoff_masters(status,contract_id,master_id);
