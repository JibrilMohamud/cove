"""Test-only SQLite proof of primary-D1 transactional legal projection fencing.

Never imports customer data, never opens Cloudflare, never claims the synthetic
fixtures reproduce the full canonical legal/settlement/publishing policy.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sqlite3

MODULE = pathlib.Path(__file__).with_name("owner-current-retail-invalidation.stage.py")
spec = importlib.util.spec_from_file_location("owner_projection_stage", MODULE)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

FIXTURE = """
CREATE TABLE products (id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,storefront_status TEXT);
CREATE TABLE editions (id TEXT PRIMARY KEY,release_status TEXT,drm_status TEXT);
CREATE TABLE rights_grants (id TEXT PRIMARY KEY,edition_id TEXT,contract_id TEXT,status TEXT,decision TEXT,format TEXT,sales_channel TEXT,drm_requirement TEXT);
CREATE TABLE rights_grant_territories (id TEXT PRIMARY KEY,grant_id TEXT,territory_code TEXT);
CREATE TABLE rights_contracts (id TEXT PRIMARY KEY,status TEXT);
CREATE TABLE rights_contract_languages (id TEXT PRIMARY KEY,contract_id TEXT,language_code TEXT);
CREATE TABLE rights_contract_versions (id TEXT PRIMARY KEY,contract_id TEXT,status TEXT);
CREATE TABLE rights_contract_version_territories (id TEXT PRIMARY KEY,contract_version_id TEXT,territory_code TEXT);
CREATE TABLE rights_contract_version_formats (id TEXT PRIMARY KEY,contract_version_id TEXT,format TEXT);
CREATE TABLE rights_contract_version_channels (id TEXT PRIMARY KEY,contract_version_id TEXT,sales_channel TEXT);
CREATE TABLE publisher_contract_assignments (id TEXT PRIMARY KEY,contract_id TEXT,status TEXT);
CREATE TABLE edition_languages (id TEXT PRIMARY KEY,edition_id TEXT,language_code TEXT);
CREATE TABLE offers (id TEXT PRIMARY KEY,product_id TEXT,amount_minor INTEGER);
CREATE TABLE digital_assets (id TEXT PRIMARY KEY,edition_id TEXT,current_version_id TEXT,kind TEXT);
CREATE TABLE asset_versions (id TEXT PRIMARY KEY,object_key TEXT);
CREATE TABLE catalog_search_documents (product_id TEXT PRIMARY KEY,availability TEXT);
CREATE TABLE storefront_markets (country_code TEXT PRIMARY KEY,currency TEXT);
CREATE TABLE territories (code TEXT PRIMARY KEY,is_sellable INTEGER);
CREATE TABLE territory_aliases (alias_code TEXT PRIMARY KEY,territory_code TEXT);
"""


def fixture():
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.executescript(FIXTURE + module.stage_schema())
    db.execute("INSERT INTO cove_stage_owner_authority_state VALUES(1,1,7)")
    for i in (1, 2):
        product, edition, grant = f"p{i}", f"e{i}", f"g{i}"
        db.execute("INSERT INTO products VALUES(?,?,?,?)", (product, edition, "ebook", "active"))
        db.execute("INSERT INTO editions VALUES(?,?,?)", (edition, "available", "none"))
        db.execute(
            "INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?)",
            (grant, edition, "c1" if i == 1 else None, "active", "allow", "ebook", "retail", "none"),
        )
        db.execute("INSERT INTO rights_grant_territories VALUES(?,?,?)", (f"t{i}", grant, "US"))
        db.execute("INSERT INTO offers VALUES(?,?,?)", (f"o{i}", product, 599))
        db.execute("INSERT INTO digital_assets VALUES(?,?,?,?)", (f"a{i}", edition, f"v{i}", "epub"))
        db.execute("INSERT INTO asset_versions VALUES(?,?)", (f"v{i}", "synthetic-public-epub-key"))
        db.execute("INSERT INTO catalog_search_documents VALUES(?,?)", (product, "available"))
        db.execute("INSERT INTO edition_languages VALUES(?,?,?)", (f"el{i}", edition, "en"))
    for sql, values in [
        ("INSERT INTO rights_contracts VALUES(?,?)", ("c1", "active")),
        ("INSERT INTO rights_contract_languages VALUES(?,?,?)", ("cl1", "c1", "en")),
        ("INSERT INTO rights_contract_versions VALUES(?,?,?)", ("rv1", "c1", "active")),
        ("INSERT INTO rights_contract_version_territories VALUES(?,?,?)", ("rvt1", "rv1", "US")),
        ("INSERT INTO rights_contract_version_formats VALUES(?,?,?)", ("rvf1", "rv1", "ebook")),
        ("INSERT INTO rights_contract_version_channels VALUES(?,?,?)", ("rvc1", "rv1", "retail")),
        ("INSERT INTO publisher_contract_assignments VALUES(?,?,?)", ("pa1", "c1", "active")),
        ("INSERT INTO storefront_markets VALUES(?,?)", ("US", "USD")),
        ("INSERT INTO territories VALUES(?,?)", ("US", 1)),
        ("INSERT INTO territories VALUES(?,?)", ("CA", 1)),
        ("INSERT INTO territory_aliases VALUES(?,?)", ("ZZ", "US")),
    ]:
        db.execute(sql, values)
    # A simulated owner has already obtained verified current evidence before
    # materialization. This fixture DOES NOT assert what grants real rights.
    for i in (1, 2):
        publish(db, f"p{i}")
    return db


def publish(db, product="p1", price=599, epoch=7, valid_until="2026-11-15 14:00:00",
            territory="US", currency="USD"):
    observed = db.execute(
        """SELECT sv.revision,tv.revision,COALESCE(mv.revision,0),
                  owner.us_fallback_revision
           FROM cove_stage_owner_product_source_version sv
           JOIN cove_stage_owner_territory_version tv ON tv.territory_code=?
           LEFT JOIN cove_stage_owner_market_version mv ON mv.territory_code=?
           CROSS JOIN cove_stage_owner_authority_state owner
           WHERE sv.product_id=? AND owner.id=1""",
        (territory, territory, product),
    ).fetchone()
    check(observed is not None, "Missing versioned source or territory in staging fixture")
    db.execute(
        "INSERT OR REPLACE INTO cove_stage_owner_retail_authority VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            product, territory, currency, price, "o" + product[1:], epoch,
            observed[0], observed[1], observed[2], observed[3],
            "a" * 64, valid_until,
        ),
    )


def read(db, product="p1", at="2026-11-15 13:30:00", territory="US", currency="USD"):
    return db.execute(module.READ_SQL, (product, territory, currency, at)).fetchone()


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def check_triggers_and_targeting():
    mutations = {
        "products": ("UPDATE products SET format='audiobook' WHERE id='p1'",),
        "editions": ("UPDATE editions SET release_status='withdrawn' WHERE id='e1'",),
        "rights_grants": ("UPDATE rights_grants SET status='revoked' WHERE id='g1'",),
        "rights_grant_territories": ("UPDATE rights_grant_territories SET territory_code='CA' WHERE id='t1'",),
        "rights_contracts": ("UPDATE rights_contracts SET status='terminated' WHERE id='c1'",),
        "rights_contract_languages": ("UPDATE rights_contract_languages SET language_code='fr' WHERE id='cl1'",),
        "rights_contract_versions": ("UPDATE rights_contract_versions SET status='revoked' WHERE id='rv1'",),
        "rights_contract_version_territories": ("UPDATE rights_contract_version_territories SET territory_code='CA' WHERE id='rvt1'",),
        "rights_contract_version_formats": ("UPDATE rights_contract_version_formats SET format='audio' WHERE id='rvf1'",),
        "rights_contract_version_channels": ("UPDATE rights_contract_version_channels SET sales_channel='library' WHERE id='rvc1'",),
        "publisher_contract_assignments": ("UPDATE publisher_contract_assignments SET status='revoked' WHERE id='pa1'",),
        "edition_languages": ("UPDATE edition_languages SET language_code='fr' WHERE id='el1'",),
        "offers": ("UPDATE offers SET amount_minor=699 WHERE id='o1'",),
        "digital_assets": ("UPDATE digital_assets SET kind='audio' WHERE id='a1'",),
        "asset_versions": ("UPDATE asset_versions SET object_key='changed' WHERE id='v1'",),
        "catalog_search_documents": ("UPDATE catalog_search_documents SET availability='preorder' WHERE product_id='p1'",),
    }
    check(set(mutations) == set(module.PRODUCT_SCOPES), "An untested invalidation family exists")
    for table, (sql,) in mutations.items():
        db = fixture()
        check(read(db) is not None, "Fixture must start authorized for " + table)
        check(read(db, "p2") is not None, "Unrelated fixture must start authorized")
        db.execute(sql)
        check(read(db) is None, "Stale positive persisted after " + table)
        check(read(db, "p2") is not None, "Unrelated book was globally invalidated by " + table)
        db.close()
    db = fixture()
    db.execute("UPDATE storefront_markets SET currency='CAD' WHERE country_code='US'")
    check(read(db) is None and read(db, "p2") is None, "US fallback change must deny all affected markets")
    db.close()


def check_insert_delete_and_key_migration():
    # Newly inserted denials and changed related records must invalidate the
    # old positive before any future legal-owner re-evaluation can occur.
    inserts = (
        ("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?)",
         ("deny3", "e1", None, "active", "deny", "ebook", "retail", "none")),
        ("INSERT INTO rights_grant_territories VALUES(?,?,?)", ("t3", "g1", "CA")),
        ("INSERT INTO rights_contract_languages VALUES(?,?,?)", ("cl3", "c1", "fr")),
        ("INSERT INTO offers VALUES(?,?,?)", ("o3", "p1", 799)),
        ("INSERT INTO digital_assets VALUES(?,?,?,?)", ("a3", "e1", "v1", "epub")),
        ("INSERT INTO rights_contract_versions VALUES(?,?,?)", ("rv3", "c1", "active")),
    )
    for sql, args in inserts:
        db = fixture()
        db.execute(sql, args)
        check(read(db) is None, "Inserted related record left stale positive: " + sql)
        check(read(db, "p2") is not None, "Insert improperly revoked unrelated book")
        db.close()

    removals = (
        "DELETE FROM rights_grants WHERE id='g1'",
        "DELETE FROM rights_grant_territories WHERE id='t1'",
        "DELETE FROM rights_contracts WHERE id='c1'",
        "DELETE FROM rights_contract_languages WHERE id='cl1'",
        "DELETE FROM offers WHERE id='o1'",
        "DELETE FROM digital_assets WHERE id='a1'",
        "DELETE FROM asset_versions WHERE id='v1'",
        "DELETE FROM catalog_search_documents WHERE product_id='p1'",
        "DELETE FROM edition_languages WHERE id='el1'",
    )
    for sql in removals:
        db = fixture()
        db.execute(sql)
        check(read(db) is None, "Deleted related record left stale positive: " + sql)
        check(read(db, "p2") is not None, "Delete improperly revoked unrelated book")
        db.close()

    db = fixture()
    db.execute("UPDATE offers SET product_id='p2' WHERE id='o1'")
    check(read(db) is None and read(db, "p2") is None,
          "Both OLD and NEW offer owners must lose previous authority")
    db.close()

    db = fixture()
    db.execute("UPDATE rights_grants SET edition_id='e2' WHERE id='g1'")
    check(read(db) is None and read(db, "p2") is None,
          "Both OLD and NEW edition rights must be invalidated")
    db.close()

    # An AFTER asset-version DELETE trigger could lose its owner after a
    # foreign-key ON DELETE SET NULL cascade changes digital_assets first.
    db = fixture()
    definition = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' "
        "AND name='cove_stage_owner_invalidate_asset_versions_delete'"
    ).fetchone()
    check(definition and "BEFORE DELETE" in definition[0],
          "Dependent asset invalidation must precede possible FK cascade")
    db.close()


def check_territory_and_alias_mutations():
    # Canonical territory sellability and alias mapping are live policy inputs.
    # Their mutations must invalidate only the affected territory rows.
    db = fixture()
    publish(db, "p1", territory="CA", currency="CAD")
    check(read(db, "p1", territory="CA", currency="CAD") is not None,
          "Second territory fixture must be present")
    db.execute("UPDATE territories SET is_sellable=0 WHERE code='US'")
    check(read(db) is None and read(db, "p2") is None,
          "Unsellable territory must synchronously deny previous positives")
    check(read(db, "p1", territory="CA", currency="CAD") is not None,
          "Unrelated territory must not be globally invalidated")
    db.close()

    db = fixture()
    publish(db, "p1", territory="CA", currency="CAD")
    db.execute("UPDATE territory_aliases SET territory_code='CA' WHERE alias_code='ZZ'")
    check(read(db) is None, "Old aliased territory must be invalidated")
    check(read(db, "p1", territory="CA", currency="CAD") is None,
          "New aliased territory must be invalidated")
    db.close()

    db = fixture()
    publish(db, "p1", territory="CA", currency="CAD")
    db.execute("INSERT INTO territory_aliases VALUES('AA','CA')")
    check(read(db) is not None, "Different territory alias must not invalidate US")
    check(read(db, "p1", territory="CA", currency="CAD") is None,
          "New alias must invalidate only target territory")
    db.close()

    db = fixture()
    db.execute("DELETE FROM territory_aliases WHERE alias_code='ZZ'")
    check(read(db) is None, "Removed alias must invalidate previous target")
    db.close()


def check_atomic_owner_mutations():
    db = fixture()
    # Invalidate within the SAME canonical transaction as a withdrawal.
    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE rights_grants SET status='revoked' WHERE id='g1'")
    check(read(db) is None, "Withdrawal must remove positive projection before commit")
    db.execute("COMMIT")
    check(read(db) is None, "Withdrawn grant cannot retain a positive projection")
    check(read(db, "p2") is not None, "Unrelated grant must stay available")

    db = fixture()
    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE offers SET amount_minor=699 WHERE id='o1'")
    check(read(db) is None, "Old price must not survive an offer change")
    # The future owner must recompute rights, current price and evidence before
    # this point. The fixture only tests atomic visibility, not real legal proof.
    publish(db, price=699)
    db.execute("COMMIT")
    check(read(db)[2] == 699, "Owner's committed new price must be atomic")

    db = fixture()
    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE rights_grants SET status='revoked' WHERE id='g1'")
    check(read(db) is None, "Row invalidation happens before transaction finishes")
    db.execute("ROLLBACK")
    check(read(db) is not None, "Failed transaction must restore BOTH source and projection")
    check(
        db.execute("SELECT status FROM rights_grants WHERE id='g1'").fetchone()[0] == "active",
        "Failed owner transaction must not commit withdrawal alone",
    )
    db.close()


def check_authority_boundaries():
    db = fixture()
    check(read(db, at="2026-11-15 13:59:59") is not None, "Current owner lease should read")
    check(read(db, at="2026-11-15 14:00:00") is None, "Scheduled boundary must fail closed")
    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=0 WHERE id=1")
    check(read(db) is None, "Disabled owner must not serve the projection")
    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=1,epoch=8 WHERE id=1")
    check(read(db) is None, "Old owner epoch must not authorize a new owner")
    plan = db.execute(
        "EXPLAIN QUERY PLAN " + module.READ_SQL,
        ("p1", "US", "USD", "2026-11-15 13:30:00"),
    ).fetchall()
    check(any("SEARCH p USING PRIMARY KEY" in r[3] for r in plan), "Primary-key point lookup must not scan legal joins")
    expected = 3 * (len(module.PRODUCT_SCOPES) + len(module.TERRITORY_SCOPES) + 1)
    actual = db.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'cove_stage_owner_invalidate_%'"
    ).fetchone()[0]
    check(actual == expected, f"All {expected} before-commit invalidation triggers required")
    db.close()


if __name__ == "__main__":
    check_triggers_and_targeting()
    check_insert_delete_and_key_migration()
    check_territory_and_alias_mutations()
    check_atomic_owner_mutations()
    check_authority_boundaries()
    print(
        "PASS: isolated owner projection invalidation across "
        f"{len(module.PRODUCT_SCOPES)+len(module.TERRITORY_SCOPES)+1} families, transactional withdrawal, "
        "offer repricing, rollbacks, owner fencing and point-indexed reads. "
        "NOT a canonical legal parity or production capacity certificate."
    )
