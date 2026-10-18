"""Verify FTS trigger parity and count VM work instead of timing noisy tests."""
import re
import sqlite3
from pathlib import Path

source = Path("drizzle/0006_commercial_search.sql").read_text()
migration = Path("drizzle/0075_catalog_fts_indexed_deletes.sql").read_text()


def base_db():
    db = sqlite3.connect(":memory:")
    db.executescript("""
      CREATE TABLE editions(id TEXT PRIMARY KEY,language TEXT);
      CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);
      CREATE TABLE catalog_search_documents(
        product_id TEXT PRIMARY KEY,external_book_id TEXT NOT NULL,title TEXT NOT NULL,
        subtitle TEXT DEFAULT '',contributors_text TEXT DEFAULT '',series_text TEXT DEFAULT '',
        publisher_text TEXT DEFAULT '',isbn13 TEXT DEFAULT '',categories_text TEXT DEFAULT '',
        keywords_text TEXT DEFAULT '',description TEXT DEFAULT '',suppressed INTEGER DEFAULT 0);
      CREATE TABLE search_index_outbox(product_id TEXT PRIMARY KEY,operation TEXT,
        queued_at TEXT,attempts INTEGER,last_error TEXT);
      INSERT INTO editions VALUES('edition','en');
    """)
    for table in ["catalog_search_fts", "catalog_search_fts_en"]:
        db.executescript(re.search(r"CREATE VIRTUAL TABLE `" + table + r"`.*?;", source, re.S)[0])
    for trigger in ["catalog_search_ai", "catalog_search_au", "catalog_search_ad"]:
        db.executescript(re.search(r"CREATE TRIGGER `" + trigger + r"`.*?END;", source, re.S)[0])
    return db


def add(db, product, external):
    db.execute("INSERT INTO products VALUES(?,'edition')", [product])
    db.execute("INSERT INTO catalog_search_documents(product_id,external_book_id,title) VALUES(?,?,?)",
               [product, external, "Original title " + product])


def upgrade(db):
    db.commit()
    try:
        db.executescript("BEGIN;\n" + migration + "\nCOMMIT;")
    except sqlite3.Error:
        db.rollback()
        raise


legacy = base_db()
for n in range(5000):
    add(legacy, "product-" + str(n), "source-" + str(n))
legacy.commit()
fast = sqlite3.connect(":memory:")
legacy.backup(fast)
upgrade(fast)


def measured_update(db):
    steps = [0]

    def progress():
        steps[0] += 100
        return 0

    db.set_progress_handler(progress, 100)
    db.execute("UPDATE catalog_search_documents SET title='Updated title' WHERE product_id='product-2000'")
    db.set_progress_handler(None, 0)
    return steps[0]


old_steps = measured_update(legacy)
new_steps = measured_update(fast)
assert old_steps > new_steps * 5, (old_steps, new_steps)


def snapshot(db, table):
    return db.execute(f"SELECT product_id,external_book_id,title FROM {table} ORDER BY product_id").fetchall()


def parity():
    for table in ["catalog_search_fts", "catalog_search_fts_en"]:
        assert snapshot(legacy, table) == snapshot(fast, table), table
    # Ignore only timestamps; enqueue operation, retry/reset and exact keys match.
    sql = "SELECT product_id,operation,attempts,last_error FROM search_index_outbox ORDER BY product_id"
    assert legacy.execute(sql).fetchall() == fast.execute(sql).fetchall()


parity()
for n, external in enumerate(["1342", "1342", "13420", 'sku"quoted', "OR AND NOT NEAR",
                               "publisher-uuid-123", "---", "", "日本語", "book日本語", "id\x00suffix"]):
    product = "edge-" + str(n)
    for db in [legacy, fast]:
        add(db, product, external)
        db.execute("UPDATE catalog_search_documents SET title='Changed' WHERE product_id=?", [product])
        db.execute("UPDATE catalog_search_documents SET external_book_id=? WHERE product_id=?",
                   [external + "-new", product])
        db.execute("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?", [product])
        db.execute("UPDATE catalog_search_documents SET suppressed=0 WHERE product_id=?", [product])
    parity()
    for db in [legacy, fast]:
        db.execute("DELETE FROM catalog_search_documents WHERE product_id=?", [product])
    parity()

for language in ["fr", "en"]:
    for db in [legacy, fast]:
        db.execute("UPDATE editions SET language=?", [language])
        db.execute("UPDATE catalog_search_documents SET title='Language changed' WHERE product_id='product-10'")
    parity()

# Migration validation must leave the old triggers and existing data intact on failure.
bad = base_db()
add(bad, "bad-product", "external-1")
bad.execute("UPDATE catalog_search_fts SET external_book_id='wrong' WHERE product_id='bad-product'")
try:
    upgrade(bad)
    raise AssertionError("inconsistent FTS identity must reject the migration")
except sqlite3.IntegrityError:
    trigger = bad.execute("SELECT sql FROM sqlite_master WHERE name='catalog_search_au'").fetchone()[0]
    assert "external_book_id MATCH" not in trigger
    assert bad.execute("SELECT COUNT(*) FROM catalog_search_fts").fetchone()[0] == 1

print(f"PASS: FTS update/delete parity, shared/quoted/unusual/NUL identifiers, suppression, languages, "
      f"outbox and migration rollback; VM work {old_steps} -> {new_steps} steps.")
