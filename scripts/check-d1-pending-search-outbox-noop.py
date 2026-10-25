#!/usr/bin/env python3
"""Execute the actual guarded D1 outbox trigger to test races and rights."""
import sqlite3
from pathlib import Path

migration = Path("drizzle/0084_d1_pending_search_outbox_noop.sql").read_text()
assert "sync_lease_token IS NOT NULL" in migration
assert "operation<>'delete'" in migration
assert "old.suppressed=1 AND new.suppressed=0" in migration
assert "COALESCE((SELECT backend FROM search_index_state WHERE id=1),'unknown')<>'d1'" in migration
assert "DROP TRIGGER `catalog_search_au`" not in migration

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY, backend TEXT, sync_lease_token TEXT, sync_lease_until TEXT
);
INSERT INTO search_index_state(id,backend,sync_lease_token) VALUES (1,'d1',NULL);
CREATE TABLE catalog_search_documents (
  product_id TEXT PRIMARY KEY, suppressed INTEGER, availability TEXT,
  download_count INTEGER, title TEXT, price_minor INTEGER
);
CREATE TABLE search_index_outbox (
  product_id TEXT PRIMARY KEY, operation TEXT, queued_at TEXT,
  attempts INTEGER, last_error TEXT, change_token TEXT NOT NULL DEFAULT ''
);
CREATE TABLE outbox_writes(phase TEXT,product_id TEXT);
CREATE TRIGGER count_outbox_insert AFTER INSERT ON search_index_outbox BEGIN
  INSERT INTO outbox_writes VALUES('insert',new.product_id);
END;
CREATE TRIGGER count_outbox_update AFTER UPDATE OF queued_at,operation ON search_index_outbox BEGIN
  INSERT INTO outbox_writes VALUES('update',new.product_id);
END;
CREATE TRIGGER trg_search_outbox_insert_token AFTER INSERT ON search_index_outbox BEGIN
  UPDATE search_index_outbox SET change_token=lower(hex(randomblob(16)))
    WHERE product_id=new.product_id;
END;
CREATE TRIGGER trg_search_outbox_update_token AFTER UPDATE OF operation,queued_at ON search_index_outbox BEGIN
  UPDATE search_index_outbox SET change_token=lower(hex(randomblob(16)))
    WHERE product_id=new.product_id;
END;
INSERT INTO catalog_search_documents VALUES('p1',0,'available',1,'Novel',0);
INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
  VALUES('p1','upsert','queued-original',0,'');
""")
for section in migration.split("--> statement-breakpoint"):
    sql = "\n".join(line for line in section.splitlines()
                    if not line.lstrip().startswith("--")).strip()
    if sql:
        db.executescript(sql)

def event():
    return db.execute("SELECT operation,queued_at,change_token FROM search_index_outbox WHERE product_id='p1'").fetchone()
def write_count():
    return db.execute("SELECT COUNT(*) FROM outbox_writes").fetchone()[0]
def edit(sql):
    db.execute(sql)
def reset():
    db.execute("DELETE FROM outbox_writes")

original = event()
reset()
for n in (2,3,4):
    edit(f"UPDATE catalog_search_documents SET download_count={n} WHERE product_id='p1'")
assert write_count() == 0, "Pending D1-only upsert should produce zero outbox writes"
assert event() == original, "Pending token must remain stable while no worker is processing"

# A new product without a pending event must always enqueue.
edit("INSERT INTO catalog_search_documents VALUES('p2',0,'available',1,'New',0)")
edit("UPDATE catalog_search_documents SET download_count=2 WHERE product_id='p2'")
assert db.execute("SELECT operation FROM search_index_outbox WHERE product_id='p2'").fetchone() == ("upsert",)

# Concurrent external Meilisearch task: lease causes forced requeue/token change
reset()
edit("UPDATE search_index_state SET sync_lease_token='active' WHERE id=1")
before = event()
edit("UPDATE catalog_search_documents SET download_count=5 WHERE product_id='p1'")
assert write_count() == 1
assert event()[2] != before[2], "New token must fence an in-flight external indexing ACK"
assert db.execute("DELETE FROM search_index_outbox WHERE product_id='p1' AND change_token=?", (before[2],)).rowcount == 0
assert event()[0] == "upsert"

# External index already active: events always advance, including popularity.
reset()
edit("UPDATE search_index_state SET sync_lease_token=NULL,backend='meilisearch' WHERE id=1")
before = event()
edit("UPDATE catalog_search_documents SET download_count=6 WHERE product_id='p1'")
assert write_count() == 1 and event()[2] != before[2]

# A delete tombstone is never reversed by unrelated non-legal changes.
reset()
edit("UPDATE search_index_outbox SET operation='delete',queued_at='tombstone' WHERE product_id='p1'")
tombstone = event()
reset()
edit("UPDATE catalog_search_documents SET download_count=7 WHERE product_id='p1'")
assert event() == tombstone and write_count() == 0

# Genuine legal restoration is the only permissible old-delete -> upsert path.
edit("UPDATE catalog_search_documents SET suppressed=1,availability='unavailable' WHERE product_id='p1'")
reset()
edit("UPDATE catalog_search_documents SET suppressed=0,availability='available' WHERE product_id='p1'")
assert event()[0] == "upsert" and event()[2] != tombstone[2]

# If search_index_state vanished, default to full safe token refresh.
reset()
edit("DELETE FROM search_index_state WHERE id=1")
before = event()
edit("UPDATE catalog_search_documents SET download_count=8 WHERE product_id='p1'")
assert write_count() == 1 and event()[2] != before[2]

# A pending record is enough for a future bootstrap: the indexer MUST read
# the latest canonical row, not stale data cached in the outbox.
assert db.execute("SELECT download_count FROM catalog_search_documents WHERE product_id='p1'").fetchone() == (8,)
assert "SELECT product_id,operation,change_token FROM search_index_outbox" not in migration
print("PASS: idle D1 no-op, enqueue first event, lease/token fencing, active index, tombstone, restoration, missing-state fail-safe")
