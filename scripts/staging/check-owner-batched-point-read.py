"""Stage-only batched 25-candidate owner projection, database-clock and denial proof.

No Cloudflare credentials, no deployment, no production table. Test positives
are deliberately seeded by a local simulated owner: this does NOT certify
current legal/offer grant parity, exclusive writer privileges or 100-RPS.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path

BASE = Path(__file__).with_name("check-owner-current-retail-invalidation.py")
spec = importlib.util.spec_from_file_location("stage_current_fixture", BASE)
assert spec and spec.loader
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
module = fixture.module

PRODUCTS = [f"p{i}" for i in range(1, 26)]


def expiry(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def batch(db, products=PRODUCTS):
    return db.execute(module.BATCH_READ_NOW_SQL, (json.dumps(products), "US", "USD")).fetchall()


def seeded():
    db = fixture.fixture()
    lease = expiry(25)
    for i in range(1, 26):
        product = f"p{i}"
        if i > 2:
            edition = f"e{i}"
            grant = f"g{i}"
            db.execute(
                "INSERT INTO products VALUES(?,?,?,?)",
                (product, edition, "ebook", "active"),
            )
            db.execute(
                "INSERT INTO editions VALUES(?,?,?)",
                (edition, "available", "none"),
            )
            db.execute(
                "INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?)",
                (grant, edition, None, "active", "allow", "ebook", "retail", "none"),
            )
            db.execute(
                "INSERT INTO rights_grant_territories VALUES(?,?,?)",
                (f"t{i}", grant, "US"),
            )
            db.execute(
                "INSERT INTO offers(id,product_id,amount_minor) VALUES(?,?,?)",
                (f"o{i}", product, 599),
            )
        fixture.publish(db, product, valid_until=lease)
    return db


def test_complete_valid_and_order():
    db = seeded()
    rows = batch(db)
    assert len(rows) == 25, "Each 25th witness must be currently authorized"
    assert [r[0] for r in rows] == PRODUCTS, "Immutable rank order is mandatory"
    assert all(r[1] == f"o{i}" and r[2] == 599 for i, r in enumerate(rows, 1))
    assert all(len(r[3]) == 64 for r in rows), "Each current positive has evidence digest"
    assert len(batch(db, list(reversed(PRODUCTS)))) == 25
    assert [r[0] for r in batch(db, list(reversed(PRODUCTS)))] == list(reversed(PRODUCTS))
    # Public call site MUST reject duplicates and wrong candidate count; the
    # SQL is deliberately a strict point lookup, never an index search.
    plan = db.execute(
        "EXPLAIN QUERY PLAN " + module.BATCH_READ_NOW_SQL,
        (json.dumps(PRODUCTS), "US", "USD"),
    ).fetchall()
    assert any("SEARCH p USING PRIMARY KEY" in x[3] for x in plan), plan
    assert "retail_product_availability_rows" not in module.BATCH_READ_NOW_SQL
    assert "rights_grants" not in module.BATCH_READ_NOW_SQL
    assert "offers" not in module.BATCH_READ_NOW_SQL
    db.close()


def test_fail_closed_withdrawal_and_repricing():
    db = seeded()
    db.execute("UPDATE rights_grants SET status='revoked' WHERE id='g10'")
    rows = batch(db)
    assert len(rows) == 24 and "p10" not in [r[0] for r in rows], "Withdrawn grant cannot survive"
    assert [r[0] for r in rows] == [p for p in PRODUCTS if p != "p10"]
    db.close()

    db = seeded()
    db.execute("UPDATE offers SET amount_minor=699 WHERE id='o12'")
    rows = batch(db)
    assert len(rows) == 24 and "p12" not in [r[0] for r in rows], "Stale price must not survive"
    db.close()

    db = seeded()
    # A stale positive reinserted by an unauthorized writer with the old
    # version must still be invisible after a source mutation. Such writers
    # MUST be retired before production, not merely tolerated.
    saved = db.execute(
        "SELECT * FROM cove_stage_owner_retail_authority WHERE product_id='p3'"
    ).fetchone()
    db.execute("UPDATE editions SET drm_status='lcp' WHERE id='e3'")
    db.execute("INSERT OR REPLACE INTO cove_stage_owner_retail_authority VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", saved)
    assert len(batch(db)) == 24, "Owner source version rejects stale reinserted positive"
    db.close()


def test_owner_policy_time_and_territory():
    db = seeded()
    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=0 WHERE id=1")
    assert not batch(db), "Disabled authority must deny all pending catalog positives"
    try:
        db.execute("UPDATE cove_stage_owner_authority_state SET enabled=1 WHERE id=1")
    except Exception:
        pass
    else:
        raise AssertionError("Reenable without owner epoch rotation must fail")
    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=1,epoch=8 WHERE id=1")
    assert not batch(db), "New owner epoch requires newly verified positives"
    db.close()

    db = seeded()
    db.execute("UPDATE territory_aliases SET territory_code='CA' WHERE alias_code='ZZ'")
    assert not batch(db), "US alias policy changed, all US positives must deny"
    db.close()

    db = seeded()
    db.execute("UPDATE storefront_markets SET currency='CAD' WHERE country_code='US'")
    assert not batch(db), "US market fallback changes must deny current authority"
    db.close()

    db = seeded()
    db.execute("UPDATE cove_stage_owner_retail_authority SET valid_until=?",
               (expiry(-1),))
    assert not batch(db), "Query must use primary-D1 current time, not caller time"
    db.close()


if __name__ == "__main__":
    test_complete_valid_and_order()
    test_fail_closed_withdrawal_and_repricing()
    test_owner_policy_time_and_territory()
    print(
        "PASS: 25 indexed current-D1 point witnesses, rank stability, invalidation, "
        "no stale repricing, owner epoch/territory/market fencing and DB-clock "
        "expiry. NO production legal parity or hosted 100RPS certificate."
    )
