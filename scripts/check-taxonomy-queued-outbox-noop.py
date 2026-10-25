#!/usr/bin/env python3
"""Proof that unchanged taxonomy preserves pending index events and retries still repair."""
from pathlib import Path
import re
import sqlite3

source = Path("src/features/fore/taxonomy.server.ts").read_text()
part = source.split("export async function syncEditionTaxonomy(", 1)[1].split(
    "export async function syncTaxonomyBatch(", 1
)[0]
sql = re.findall(r"`([\s\S]*?)`", part)
assert len(sql) == 6, "Keep six auditable edition-taxonomy statements"
outbox = sql[5]
assert "WHERE ?=0" in outbox
assert "ON CONFLICT(product_id) DO UPDATE" in outbox
assert "sourceUnchanged && changedRows === 0" in part
assert 'meta?: { changes?: number }' in part
api = Path("src/features/fore/api.server.ts").read_text()
assert "unchangedIds.has(String(book.id))" in api

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT);
CREATE TABLE search_index_outbox(
 product_id TEXT PRIMARY KEY, operation TEXT,
 queued_at TEXT, attempts INTEGER,last_error TEXT,
 change_token TEXT DEFAULT 'original'
);
CREATE TABLE triggers(action TEXT);
CREATE TRIGGER audit_update AFTER UPDATE ON search_index_outbox BEGIN
  INSERT INTO triggers VALUES('update');
END;
CREATE TRIGGER audit_insert AFTER INSERT ON search_index_outbox BEGIN
  INSERT INTO triggers VALUES('insert');
END;
INSERT INTO products VALUES('p1','e1','gutenberg');
""")
# Interrupted publication recovery: missing event must be inserted even if
# source and taxonomy are unchanged.
assert db.execute(outbox, ("first", "e1", 1, 0)).rowcount == 1
assert db.execute("SELECT COUNT(*) FROM triggers").fetchone()[0] == 1
db.execute("UPDATE search_index_outbox SET attempts=3,last_error='retrying',change_token='newer' WHERE product_id='p1'")
db.execute("DELETE FROM triggers")
# Same input and no search text changes: don't reset timestamp/attempts/token.
assert db.execute(outbox, ("later", "e1", 1, 0)).rowcount == 0
assert db.execute("SELECT COUNT(*) FROM triggers").fetchone()[0] == 0
assert db.execute(
  "SELECT queued_at,attempts,last_error,change_token FROM search_index_outbox"
).fetchone() == ("first", 3, "retrying", "newer")
# Changed normalized source OR changed category still triggers original
# conditional update and fresh index delivery.
assert db.execute(outbox, ("changed", "e1", 0, 0)).rowcount == 1
assert db.execute("SELECT COUNT(*) FROM triggers").fetchone()[0] == 1
assert db.execute(
  "SELECT queued_at,attempts,last_error FROM search_index_outbox"
).fetchone() == ("changed", 0, "")
# A previously queued legal denial/revocation must never be overwritten by
# an unchanged source-heartbeat. Forced change retains existing behavior.
db.execute("UPDATE search_index_outbox SET operation='delete' WHERE product_id='p1'")
db.execute("DELETE FROM triggers")
db.execute(outbox, ("heartbeat", "e1", 1, 0))
assert db.execute(
  "SELECT operation,queued_at FROM search_index_outbox"
).fetchone() == ("delete", "changed")
# Download-count-only observations can refresh an existing UPSERT but
# cannot cancel a legal-denial tombstone queued by another authority.
db.execute("DELETE FROM triggers")
db.execute(outbox, ("popularity", "e1", 0, 1))
assert db.execute("SELECT operation,queued_at FROM search_index_outbox").fetchone() == ("delete", "changed")
assert db.execute("SELECT COUNT(*) FROM triggers").fetchone()[0] == 0
db.execute("UPDATE search_index_outbox SET operation='upsert' WHERE product_id='p1'")
db.execute("DELETE FROM triggers")
db.execute(outbox, ("popularity", "e1", 0, 1))
assert db.execute("SELECT operation,queued_at FROM search_index_outbox").fetchone() == ("upsert", "popularity")
assert db.execute("SELECT COUNT(*) FROM triggers").fetchone()[0] == 1
print("PASS: unchanged heartbeats cause 0 outbox writes; missing publication repaired; new events, revocations and replay safe")
