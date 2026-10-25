#!/usr/bin/env python3
"""Execute Cove's real edition taxonomy SQL and verify idempotent row writes.

Tests matching source data, manual survivability, interrupted-run repair,
mapping revocation and confidence changes, not merely string patterns.
"""
import re
import sqlite3
from pathlib import Path

source = Path("src/features/fore/taxonomy.server.ts").read_text()
part = source.split("export async function syncEditionTaxonomy(", 1)[1].split(
    "export async function syncTaxonomyBatch(", 1
)[0]
sql = re.findall(r"`([\s\S]*?)`", part)
assert len(sql) == 6, f"Taxonomy sync must have six auditable SQL statements, got {len(sql)}"
assert sql[0].lstrip().startswith("WITH source_values")
assert "source='mapping'" in sql[0]
assert sql[2].lstrip().startswith("WITH RECURSIVE ancestors")
assert "source='ancestor'" in sql[2]
assert "AND taxonomy_text IS NOT COALESCE" in sql[4]
assert "INSERT INTO search_index_outbox" in sql[5]

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE editions(id TEXT PRIMARY KEY);
CREATE TABLE categories(id TEXT PRIMARY KEY,scheme TEXT,name TEXT);
CREATE TABLE edition_categories(edition_id TEXT,category_id TEXT);
CREATE TABLE subjects(id TEXT PRIMARY KEY,scheme TEXT,name TEXT);
CREATE TABLE edition_subjects(edition_id TEXT,subject_id TEXT);
CREATE TABLE storefront_taxonomy_nodes(id TEXT PRIMARY KEY,path TEXT,parent_id TEXT);
CREATE TABLE storefront_taxonomy_mappings(
  id TEXT PRIMARY KEY,taxonomy_node_id TEXT,active INTEGER,
  source_scheme TEXT,match_mode TEXT,source_value TEXT
);
CREATE TABLE edition_taxonomy_nodes(
  edition_id TEXT, taxonomy_node_id TEXT, source TEXT,
  confidence REAL, is_primary INTEGER, created_at TEXT,
  PRIMARY KEY(edition_id,taxonomy_node_id)
);
CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT);
CREATE TABLE catalog_search_documents(product_id TEXT PRIMARY KEY,taxonomy_text TEXT,updated_at TEXT);
CREATE TABLE search_index_outbox(
  product_id TEXT PRIMARY KEY,operation TEXT,queued_at TEXT,
  attempts INTEGER,last_error TEXT
);
CREATE TABLE writes(operation TEXT,source TEXT,node_id TEXT);
CREATE TRIGGER track_taxonomy_insert AFTER INSERT ON edition_taxonomy_nodes
BEGIN INSERT INTO writes VALUES('insert',new.source,new.taxonomy_node_id); END;
CREATE TRIGGER track_taxonomy_delete AFTER DELETE ON edition_taxonomy_nodes
BEGIN INSERT INTO writes VALUES('delete',old.source,old.taxonomy_node_id); END;
INSERT INTO editions VALUES('e1');
INSERT INTO categories VALUES('c1','gutenberg','Fantasy');
INSERT INTO edition_categories VALUES('e1','c1');
INSERT INTO storefront_taxonomy_nodes VALUES('root','books',NULL);
INSERT INTO storefront_taxonomy_nodes VALUES('fantasy','books/fantasy','root');
INSERT INTO storefront_taxonomy_nodes VALUES('manual','special',NULL);
INSERT INTO storefront_taxonomy_mappings VALUES('m1','fantasy',1,'gutenberg','exact','Fantasy');
INSERT INTO products VALUES('p1','e1','gutenberg');
INSERT INTO catalog_search_documents VALUES('p1','','prior');
INSERT INTO edition_taxonomy_nodes VALUES('e1','manual','manual',1.0,0,'original');
DELETE FROM writes;
""")

def apply():
    db.execute(sql[0], ("e1", "e1", "e1"))
    db.execute(sql[1], ("now", "e1", "e1"))
    db.execute(sql[2], ("e1", "e1"))
    db.execute(sql[3], ("e1", "now"))
    db.execute(sql[4], ("e1",))
    db.execute(sql[5], ("now", "e1", 0, 0))

def writes():
    return db.execute("SELECT operation,source,node_id FROM writes ORDER BY rowid").fetchall()

def assignments():
    return db.execute(
        "SELECT taxonomy_node_id,source,confidence,created_at "
        "FROM edition_taxonomy_nodes WHERE edition_id='e1' ORDER BY taxonomy_node_id"
    ).fetchall()

apply()
initial = assignments()
assert any(a[0] == "manual" and a[1] == "manual" for a in initial)
assert any(a[0] == "fantasy" and a[1] == "mapping" for a in initial)
assert any(a[0] == "root" and a[1] == "ancestor" for a in initial)
assert db.execute("SELECT taxonomy_text FROM catalog_search_documents").fetchone()[0]
assert db.execute("SELECT COUNT(*) FROM search_index_outbox").fetchone()[0] == 1

db.execute("DELETE FROM writes")
apply()
assert writes() == [], "Same source/mapping MUST generate ZERO taxonomy row writes"
assert assignments() == initial, "No-op must preserve provenance and creation timestamps"

# Recover a partial previous attempt which lost the ancestor after mapping insert.
db.execute("DELETE FROM edition_taxonomy_nodes WHERE taxonomy_node_id='root'")
db.execute("DELETE FROM writes")
apply()
assert writes() == [("insert", "ancestor", "root")], writes()

# Rights-independent mapping source withdrawal must remove mapping and ancestor,
# but never delete a manually curated assignment.
db.execute("UPDATE storefront_taxonomy_mappings SET active=0 WHERE id='m1'")
db.execute("DELETE FROM writes")
apply()
assert ("delete", "mapping", "fantasy") in writes()
assert ("delete", "ancestor", "root") in writes()
assert any(a[0] == "manual" and a[1] == "manual" for a in assignments())
db.execute("DELETE FROM writes")
apply()
assert writes() == [], "Removed mapping must be stable without further writes"

# Re-enable mapping and change match mode/confidence. Retain confidence semantics.
db.execute("UPDATE storefront_taxonomy_mappings SET active=1 WHERE id='m1'")
apply()
db.execute("UPDATE storefront_taxonomy_mappings SET match_mode='prefix',source_value='Fant' WHERE id='m1'")
db.execute("DELETE FROM writes")
apply()
assert any(a[0] == "fantasy" and a[2] == 0.85 for a in assignments())
assert ("delete", "mapping", "fantasy") in writes()
assert ("insert", "mapping", "fantasy") in writes()
db.execute("DELETE FROM writes")
apply()
assert writes() == [], "Updated confidence must stabilize after exactly one refresh"

# Independent manual source remains valid after all derived mappings disappear.
db.execute("UPDATE storefront_taxonomy_mappings SET active=0 WHERE id='m1'")
apply()
assert any(a[0] == "manual" and a[1] == "manual" for a in assignments())
print("PASS: diff taxonomy SQL is idempotent; ancestor repair, confidence, source withdrawal and manual preservation")
