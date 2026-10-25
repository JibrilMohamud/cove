-- Only metadata publication receipts on rights-authoritative primary D1.
-- No derived FTS or taxonomy mirror is written here.
CREATE TABLE IF NOT EXISTS catalog_canonical_publication_receipts (
 source_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 title TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
