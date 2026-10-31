#!/usr/bin/env python3
"""Exercise exact popularity statements from the private canonical owner."""
import re
import sqlite3
from pathlib import Path

api=Path("src/features/fore/api.server.ts").read_text()
owner=Path("src/storefront-strangler/legal-authority.worker.ts").read_text()
assert 'if(route==="/catalog/observe-us")' in owner, "Expected private US observation route"
assert "UPDATE gutenberg_source_cache\\n            SET download_count=" not in api, "Shared source popularity UPDATE reintroduced"
assert "UPDATE catalog_search_documents\\n            SET download_count=" not in api, "Shared projection popularity UPDATE reintroduced"
def extract(table):
    tick=chr(96)
    pattern=r"db\s*\.\s*prepare\(\s*"+re.escape(tick)+r"(UPDATE "+table+r"\s+SET\s+download_count=\?[^`]*?)"+re.escape(tick)+r"\s*,?\s*\)"
    match=re.search(pattern,owner)
    assert match is not None, "Missing source SQL: "+table
    sql=match.group(1)
    assert "{" not in sql and ";" not in sql, "Unbounded or dynamic SQL"
    assert "rights_status='public-domain'" in sql
    assert "commercial_use_status='approved'" in sql
    assert "rights_territories_json='[\"US\"]'" in sql
    return sql
src=extract("gutenberg_source_cache")
doc=extract("catalog_search_documents")
assert "updated_at=?" in src
assert "EXISTS(SELECT 1 FROM gutenberg_source_cache" in doc
assert "c.updated_at=?" in doc
db=sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE gutenberg_source_cache(
 id TEXT PRIMARY KEY,updated_at TEXT,source_updated_at TEXT,
 last_seen_at TEXT,download_count INTEGER,ingest_status TEXT,
 rights_status TEXT,commercial_use_status TEXT,rights_territories_json TEXT
);
CREATE TABLE catalog_search_documents(
 product_id TEXT PRIMARY KEY,updated_at TEXT,download_count INTEGER
);
""")
old="2026-10-24T12:00:00Z"
new="2026-10-25T13:00:00Z"
def reset():
 db.execute("DELETE FROM gutenberg_source_cache")
 db.execute("DELETE FROM catalog_search_documents")
 db.execute("INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?,?)",
  ("2701",old,old,old,10,"active","public-domain","approved",'["US"]'))
 db.execute("INSERT INTO catalog_search_documents VALUES(?,?,?)",("prd_gutenberg_2701",old,10))
def apply():
 one=db.execute(src,(11,new,new,new,"2701",old)).rowcount
 two=db.execute(doc,(11,new,"prd_gutenberg_2701",old,"2701",new,11)).rowcount
 return one,two
reset()
assert apply()==(1,1)
assert db.execute("SELECT updated_at,download_count FROM gutenberg_source_cache").fetchone()==(new,11)
assert db.execute("SELECT updated_at,download_count FROM catalog_search_documents").fetchone()==(new,11)
assert apply()==(0,0), "Replay must not overwrite newer rows"
reset()
db.execute("UPDATE gutenberg_source_cache SET rights_status='withdrawn'")
assert apply()==(0,0), "Concurrent withdrawal blocks both source and projection"
assert db.execute("SELECT download_count FROM catalog_search_documents").fetchone()[0]==10
reset()
db.execute("UPDATE gutenberg_source_cache SET commercial_use_status='pending'")
assert apply()==(0,0), "Missing commercial grant must block both writes"
reset()
db.execute("UPDATE gutenberg_source_cache SET updated_at='new-version'")
assert apply()==(0,0), "Stale source observed before a newer publication must not overwrite it"
reset()
db.execute("UPDATE catalog_search_documents SET updated_at='newer-catalog'")
assert apply()==(1,0), "Canonical projection must not be overwritten on conflicting version"
assert db.execute("SELECT download_count FROM catalog_search_documents").fetchone()[0]==10
print("PASS: exact private owner popularity SQL; revocation race, publication, replay and projection guards")
