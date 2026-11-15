"""Fail-closed proof for SQLite REPLACE bypassing nonrecursive DELETE triggers.

SQLite's INSERT OR REPLACE can remove a previous row without executing its
DELETE trigger when recursive_triggers=OFF. This is NOT a canonical-owner
write test or a production migration: we reject all unique-key colliding
source INSERTs in the stage D1 projection's guarded SQL.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sqlite3

BASE = Path(__file__).with_name("check-owner-current-retail-invalidation.py")
spec = importlib.util.spec_from_file_location("owner_replace_base", BASE)
assert spec and spec.loader
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
module = fixture.module


def reproduce_prior_bypass():
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.executescript("""
    PRAGMA recursive_triggers=OFF;
    CREATE TABLE offers(id TEXT PRIMARY KEY,product_id TEXT);
    CREATE TABLE positive(product_id TEXT PRIMARY KEY);
    CREATE TRIGGER invalidate_insert BEFORE INSERT ON offers BEGIN
      DELETE FROM positive WHERE product_id=NEW.product_id;
    END;
    CREATE TRIGGER invalidate_delete BEFORE DELETE ON offers BEGIN
      DELETE FROM positive WHERE product_id=OLD.product_id;
    END;
    INSERT INTO offers VALUES('offer-1','old-product');
    INSERT INTO positive VALUES('old-product');
    INSERT OR REPLACE INTO offers VALUES('offer-1','new-product');
    """)
    assert db.execute("SELECT product_id FROM positive").fetchone()[0] == "old-product", (
        "Regression reproduction changed; re-evaluate SQLite replacement semantics"
    )
    db.close()


def guarded_fixture():
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA recursive_triggers=OFF")
    db.executescript(fixture.FIXTURE)
    # Expand intentionally sparse legacy fixture to the production-equivalent
    # unique-key columns (read-only synthetic D1 index inventory verified).
    for table, keys in module.SOURCE_UNIQUE_KEYS.items():
        present = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        needed = {column for key in keys for column in key}
        for column in sorted(needed - present):
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
        for index, key in enumerate(keys):
            db.execute(
                f"CREATE UNIQUE INDEX idx_test_source_collision_{table}_{index} "
                f"ON {table}({','.join(key)})"
            )
    db.executescript(module.stage_schema())
    db.execute("INSERT INTO cove_stage_owner_authority_state(id,enabled,epoch) VALUES(1,1,7)")
    db.execute("INSERT INTO territories(code,is_sellable) VALUES('US',1)")
    db.execute("INSERT INTO territories(code,is_sellable) VALUES('CA',1)")
    for i in (1, 2):
        db.execute(
            """INSERT INTO products
             (id,edition_id,format,storefront_status,sku,source_name,source_external_id,public_id)
             VALUES(?,?,?,?,?,?,?,?)""",
            (f"p{i}", f"e{i}", "ebook", "active", f"SKU-{i}", "gutenberg", str(i), f"public-{i}"),
        )
        db.execute("INSERT INTO editions(id,release_status,drm_status) VALUES(?,?,?)",
                   (f"e{i}", "available", "none"))
        db.execute(
            """INSERT INTO rights_grants(id,edition_id,status,decision,format,sales_channel,drm_requirement)
               VALUES(?,?,?,?,?,?,?)""",
            (f"g{i}", f"e{i}", "active", "allow", "ebook", "retail", "none"),
        )
        db.execute(
            "INSERT INTO rights_grant_territories(id,grant_id,territory_code) VALUES(?,?,?)",
            (f"t{i}", f"g{i}", "US"),
        )
        db.execute(
            "INSERT INTO offers(id,product_id,amount_minor) VALUES(?,?,?)",
            (f"o{i}", f"p{i}", 599),
        )
        db.execute(
            "INSERT INTO catalog_search_documents(product_id,availability,external_book_id) VALUES(?,?,?)",
            (f"p{i}", "available", f"external-{i}"),
        )
    db.execute(
        "INSERT INTO asset_versions(id,asset_id,version_number,object_key) VALUES('v1','a1',1,'fixture')"
    )
    db.execute(
        "INSERT INTO digital_assets(id,edition_id,current_version_id,kind) VALUES('a1','e1','v1','epub')"
    )
    db.execute("INSERT INTO storefront_markets(country_code,currency) VALUES('US','USD')")
    for i in (1, 2):
        fixture.publish(db, f"p{i}",
                        valid_until=(datetime.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S"))
    return db


def expect_blocked(db, sql, params=()):
    try:
        db.execute(sql, params)
    except sqlite3.IntegrityError as error:
        assert "cove_owner_requires_explicit_update" in str(error), (
            "Source unique collision was rejected for the wrong reason: " + str(error)
        )
    else:
        raise AssertionError("SQLite REPLACE bypassed source authority fence: " + sql[:85])


def test_rejects_all_unique_source_collisions():
    db = guarded_fixture()
    expected = len(module.SOURCE_UNIQUE_KEYS)
    actual = db.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' "
        "AND name LIKE 'cove_stage_owner_abort_conflicting_insert_%'"
    ).fetchone()[0]
    assert actual == expected, f"All {expected} source families require REPLACE collision guard"
    assert fixture.read(db) is not None and fixture.read(db,"p2") is not None

    # Identity collision on an offer being moved between books.
    expect_blocked(db, "INSERT OR REPLACE INTO offers(id,product_id,amount_minor) VALUES('o1','p2',599)")
    assert db.execute("SELECT product_id FROM offers WHERE id='o1'").fetchone()[0] == "p1"
    assert fixture.read(db) is not None and fixture.read(db,"p2") is not None

    # Unique SKU / independent product ID would otherwise silently remove p1.
    expect_blocked(db,
        """INSERT OR REPLACE INTO products
           (id,edition_id,format,storefront_status,sku) VALUES('p3','e3','ebook','active','SKU-1')""")
    expect_blocked(db,
        """INSERT OR REPLACE INTO products
           (id,edition_id,format,storefront_status,source_name,source_external_id)
           VALUES('p3','e3','ebook','active','gutenberg','1')""")
    expect_blocked(db,
        """INSERT OR REPLACE INTO products
           (id,edition_id,format,storefront_status,public_id)
           VALUES('p3','e3','ebook','active','public-1')""")

    # Legal source conflicts at both identity and composite parent scope.
    expect_blocked(db,
        """INSERT OR REPLACE INTO rights_grants
           (id,edition_id,status,decision,format,sales_channel,drm_requirement)
           VALUES('g1','e2','active','allow','ebook','retail','none')""")
    expect_blocked(db,
        """INSERT OR REPLACE INTO rights_grant_territories(id,grant_id,territory_code)
           VALUES('new-t','g1','US')""")
    expect_blocked(db,
        """INSERT OR REPLACE INTO catalog_search_documents
           (product_id,availability,external_book_id)
           VALUES('p3','available','external-1')""")
    expect_blocked(db,
        """INSERT OR REPLACE INTO asset_versions(id,asset_id,version_number,object_key)
           VALUES('v2','a1',1,'new')""")
    expect_blocked(db, "INSERT OR REPLACE INTO storefront_markets(country_code,currency) VALUES('US','CAD')")
    assert fixture.read(db) is not None and fixture.read(db,"p2") is not None, (
        "Rejected source REPLACE must rollback EVERY attempted invalidation"
    )

    # Correctly scoped INSERTs of genuinely new source records remain allowed.
    db.execute(
        """INSERT INTO offers(id,product_id,amount_minor)
           VALUES('new-offer','p1',699)"""
    )
    assert fixture.read(db) is None, "New retail offer invalidates p1 immediately"
    assert fixture.read(db,"p2") is not None, "Unrelated p2 remains authorized"

    # And an explicit UPDATE retains OLD+NEW scoped denial-first behavior.
    db = guarded_fixture()
    db.execute("UPDATE offers SET product_id='p2' WHERE id='o1'")
    assert fixture.read(db) is None and fixture.read(db,"p2") is None, (
        "Audited UPDATE must invalidate both old and new offer owners"
    )
    db.close()


if __name__ == "__main__":
    reproduce_prior_bypass()
    test_rejects_all_unique_source_collisions()
    print(
        "PASS: demonstrated SQLite nonrecursive REPLACE stale-authorization hazard; "
        f"blocked unique collisions on all {len(module.SOURCE_UNIQUE_KEYS)} staged legal/offer "
        "source families, while legitimate INSERT and OLD/NEW UPDATE still invalidate correctly. "
        "NO production migration or writer exclusivity certified."
    )
