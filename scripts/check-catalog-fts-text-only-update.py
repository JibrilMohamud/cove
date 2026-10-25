#!/usr/bin/env python3
"""Execute the live FTS migration against SQLite FTS5 and observe real token updates."""
import sqlite3
from pathlib import Path
sql=Path("drizzle/0083_catalog_fts_text_only_updates.sql").read_text()
assert "DROP TRIGGER "+chr(96)+"catalog_search_ad" not in sql
assert "DROP TRIGGER "+chr(96)+"catalog_search_ai" not in sql
assert "old.languages_text IS NOT new.languages_text" in sql
assert "old.suppressed IS NOT new.suppressed" in sql
assert "search_index_outbox.operation<>'delete'" in sql
db=sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE editions(id TEXT PRIMARY KEY,language TEXT);
CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);
CREATE TABLE catalog_search_documents(
 product_id TEXT PRIMARY KEY,external_book_id TEXT,title TEXT,subtitle TEXT,
 contributors_text TEXT,series_text TEXT,publisher_text TEXT,isbn13 TEXT,
 categories_text TEXT,keywords_text TEXT,description TEXT,
 languages_text TEXT,suppressed INTEGER,download_count INTEGER,
 price_minor INTEGER,updated_at TEXT,availability TEXT
);
CREATE VIRTUAL TABLE catalog_search_fts USING fts5(
 product_id UNINDEXED,external_book_id,title,subtitle,contributors_text,
 series_text,publisher_text,isbn13,categories_text,keywords_text,description
);
CREATE VIRTUAL TABLE catalog_search_fts_en USING fts5(
 product_id UNINDEXED,external_book_id,title,subtitle,contributors_text,
 series_text,publisher_text,isbn13,categories_text,keywords_text,description
);
CREATE TABLE search_index_outbox(
 product_id TEXT PRIMARY KEY,operation TEXT,queued_at TEXT,
 attempts INTEGER,last_error TEXT,change_token TEXT
);
CREATE TABLE witness(message TEXT);
CREATE TRIGGER witness_outbox AFTER UPDATE ON search_index_outbox
 BEGIN INSERT INTO witness VALUES('updated'); END;
CREATE TRIGGER catalog_search_au AFTER UPDATE ON catalog_search_documents BEGIN SELECT 1; END;
INSERT INTO editions VALUES('e1','en');
INSERT INTO products VALUES('p1','e1');
INSERT INTO catalog_search_documents VALUES(
 'p1','2701','Oldtitle','','Herman Melville','','','','Adventure','','A voyage',
 'en',0,10,0,'initial','available');
INSERT INTO catalog_search_fts VALUES(
 'p1','2701','Oldtitle','','Herman Melville','','','','Adventure','','A voyage');
INSERT INTO catalog_search_fts_en VALUES(
 'p1','2701','Oldtitle','','Herman Melville','','','','Adventure','','A voyage');
INSERT INTO search_index_outbox VALUES('p1','upsert','old',4,'older','token');
""")
for section in sql.split("--> statement-breakpoint"):
    sql_chunk="\n".join(line for line in section.splitlines()
      if not line.lstrip().startswith("--")).strip()
    if sql_chunk: db.executescript(sql_chunk)

def fts_id(table):
    x=db.execute("SELECT rowid FROM "+table+" WHERE product_id='p1'").fetchone()
    return x[0] if x else None
initial=(fts_id("catalog_search_fts"),fts_id("catalog_search_fts_en"))
assert all(initial)
db.execute("DELETE FROM witness")
for count in (11,12,13):
    db.execute("UPDATE catalog_search_documents SET download_count=?,updated_at=? WHERE product_id='p1'",
      (count,"pop-"+str(count)))
    assert (fts_id("catalog_search_fts"),fts_id("catalog_search_fts_en"))==initial
assert db.execute("SELECT count(*) FROM witness").fetchone()[0]==3
db.execute("UPDATE catalog_search_documents SET price_minor=1 WHERE product_id='p1'")
assert (fts_id("catalog_search_fts"),fts_id("catalog_search_fts_en"))==initial
db.execute("UPDATE search_index_outbox SET operation='delete',queued_at='denial',change_token='denial-token'")
db.execute("DELETE FROM witness")
db.execute("UPDATE catalog_search_documents SET download_count=14 WHERE product_id='p1'")
assert db.execute("SELECT operation,queued_at,change_token FROM search_index_outbox").fetchone()==(
  "delete","denial","denial-token")
assert db.execute("SELECT count(*) FROM witness").fetchone()[0]==0
assert (fts_id("catalog_search_fts"),fts_id("catalog_search_fts_en"))==initial
# SQLite legitimately reuses an FTS5 rowid after deleting/reinserting the
# same product. Verify actual indexed search terms and FTS5 write effects
# instead of mistaking rowid reuse for a failed publication.
before_text_update=db.total_changes
db.execute("UPDATE catalog_search_documents SET title='Newvoyage' WHERE product_id='p1'")
assert db.total_changes-before_text_update>4, "Changing indexed text must rewrite FTS5 records"
assert db.execute("SELECT count(*) FROM catalog_search_fts WHERE title MATCH 'Newvoyage'").fetchone()[0]==1
assert db.execute("SELECT count(*) FROM catalog_search_fts WHERE title MATCH 'Oldtitle'").fetchone()[0]==0
db.execute("UPDATE editions SET language='fr' WHERE id='e1'")
db.execute("UPDATE catalog_search_documents SET languages_text='fr' WHERE product_id='p1'")
assert fts_id("catalog_search_fts_en") is None
assert fts_id("catalog_search_fts") is not None
db.execute("UPDATE catalog_search_documents SET suppressed=1,availability='unavailable' WHERE product_id='p1'")
assert fts_id("catalog_search_fts") is None
db.execute("UPDATE editions SET language='en' WHERE id='e1'")
db.execute("UPDATE catalog_search_documents SET suppressed=0,availability='available',languages_text='en' WHERE product_id='p1'")
assert fts_id("catalog_search_fts") is not None
assert fts_id("catalog_search_fts_en") is not None
assert db.execute("SELECT operation FROM search_index_outbox").fetchone()[0]=="upsert"
print("PASS: 0 FTS rewrites for popularity/price; legal tombstone, text, language, suppression correct")
