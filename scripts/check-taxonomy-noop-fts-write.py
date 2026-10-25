#!/usr/bin/env python3
"""Execute the actual taxonomy UPDATE against SQLite and count FTS-trigger writes."""
from pathlib import Path
import sqlite3

source = Path("src/features/fore/taxonomy.server.ts").read_text()
marker = "`UPDATE catalog_search_documents SET taxonomy_text="
start = source.index(marker) + 1
end = source.index("`", start)
sql = source[start:end]
assert "AND taxonomy_text IS NOT COALESCE" in sql
assert "WHERE product_id IN (SELECT id FROM products WHERE edition_id=?)" in sql
assert "JOIN edition_taxonomy_nodes" in sql

conn = sqlite3.connect(":memory:")
conn.executescript("""
CREATE TABLE products(id TEXT PRIMARY KEY, edition_id TEXT NOT NULL);
CREATE TABLE edition_taxonomy_nodes(edition_id TEXT, taxonomy_node_id TEXT);
CREATE TABLE storefront_taxonomy_nodes(id TEXT PRIMARY KEY,path TEXT);
CREATE TABLE catalog_search_documents(product_id TEXT PRIMARY KEY,taxonomy_text TEXT,updated_at TEXT);
CREATE TABLE fts_side_effects(product_id TEXT);
CREATE TRIGGER index_side_effect AFTER UPDATE ON catalog_search_documents BEGIN
  INSERT INTO fts_side_effects(product_id) VALUES(new.product_id);
END;
INSERT INTO products VALUES('p1','e1');
INSERT INTO storefront_taxonomy_nodes VALUES('n1','fiction/fantasy');
INSERT INTO edition_taxonomy_nodes VALUES('e1','n1');
INSERT INTO catalog_search_documents VALUES('p1','fiction/fantasy','prior-date');
""")

def run(expected_updates, expected_text):
    cursor = conn.execute(sql, ("e1",))
    assert cursor.rowcount == expected_updates, (cursor.rowcount, expected_updates)
    row = conn.execute("SELECT taxonomy_text,updated_at FROM catalog_search_documents").fetchone()
    assert row == (expected_text, "prior-date"), row

run(0, "fiction/fantasy")
assert conn.execute("SELECT COUNT(*) FROM fts_side_effects").fetchone()[0] == 0
conn.execute("UPDATE storefront_taxonomy_nodes SET path='fiction/classics' WHERE id='n1'")
run(1, "fiction/classics")
run(0, "fiction/classics")
conn.execute("DELETE FROM edition_taxonomy_nodes")
run(1, "")
run(0, "")
assert conn.execute("SELECT COUNT(*) FROM fts_side_effects").fetchone()[0] == 2
assert "DELETE FROM edition_taxonomy_nodes WHERE edition_id=?" in source
assert "INSERT INTO search_index_outbox" in source
print("PASS: unchanged taxonomy=zero FTS writes, reassignment and revocation persisted, retry and outbox preserved")
