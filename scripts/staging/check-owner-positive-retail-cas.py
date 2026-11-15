"""Stage-only owner CAS writer races and denial tests.

These tests use a deliberately reduced legal VIEW in SQLite. No test outcome
claims parity with Cove's full resolveProductRights TypeScript resolver.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

BASE = Path(__file__).with_name("check-owner-current-retail-invalidation.py")
WRITER = Path(__file__).with_name("owner-positive-retail-writer.stage.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


fixture = load(BASE, "stage_owner_cas_fixture")
writer = load(WRITER, "stage_owner_cas_writer")

CURRENT_LEGAL_VIEW = """
CREATE VIEW retail_product_availability_rows AS
SELECT p.id product_id,rg.territory_code territory_code
FROM products p
JOIN rights_grants rg ON rg.edition_id=p.edition_id
WHERE p.storefront_status='active'
  AND rg.status='active'
  AND rg.decision='allow'
  AND NOT EXISTS (
      SELECT 1 FROM rights_grants denied
      WHERE denied.edition_id=rg.edition_id AND denied.status='active'
        AND denied.decision='deny' AND denied.territory_code=rg.territory_code
  );
"""


def environment():
    db = fixture.fixture()
    # The independent simplified view is only a second race guard in this
    # fixture; it does not replace the actual production legal resolver.
    db.executescript(CURRENT_LEGAL_VIEW)
    return db


def granted(transition="2026-11-15 14:00:00"):
    return {
        "allowed": True,
        "productId": "p1",
        "territory": "US",
        "salesChannel": "retail",
        "grantId": "g1",
        "reasonCode": "ACTIVE_GRANT",
        "contractVersionId": "rv1",
        "nextTransitionAt": transition,
    }


def attempt(db, observed=None, verdict=None, time="2026-11-15 13:30:00", price=599, offer="o1"):
    if observed is None:
        observed = writer.observe_source_versions(db, "p1", "US")
    return writer.publish_if_still_authorized(
        db,
        product_id="p1",
        territory="US",
        currency="USD",
        offer_id=offer,
        amount_minor=price,
        observed=observed,
        canonical_verdict=verdict if verdict is not None else granted(),
        evaluated_at=time,
    )


def assert_denied(db, message):
    assert fixture.read(db) is None, message


def test_atomic_success_and_owner_boundaries():
    db = environment()
    assert writer.observe_source_versions(db, "p1", "US") is not None
    assert attempt(db) is True, "Current verified grant+offer should atomically publish"
    assert fixture.read(db) == ("p1", "o1", 599)
    assert fixture.read(db, at="2026-11-15 13:30:29") is not None
    assert fixture.read(db, at="2026-11-15 13:30:30") is None, "Short owner lease must expire"
    assert attempt(db, price=600) is False, "Changed price must not publish a fake offer"
    assert attempt(db, offer="missing") is False, "Offer ID must match current primary D1"

    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=0 WHERE id=1")
    assert attempt(db) is False, "Disabled canonical owner must not publish"
    db.execute("UPDATE cove_stage_owner_authority_state SET enabled=1,epoch=8 WHERE id=1")
    assert attempt(db, observed=(2, 2, 2, 7, 1)) is False, "Wrong old epoch must not publish"
    assert attempt(db) is True, "New owner may publish after observing the new epoch"
    db.close()


def test_stale_observations_cannot_regrant():
    cases = [
        ("grant revocation", "UPDATE rights_grants SET status='revoked' WHERE id='g1'"),
        ("explicit deny insertion",
         "INSERT INTO rights_grants VALUES('deny9','e1',NULL,'active','deny','ebook','retail','none')"),
        ("offer repricing", "UPDATE offers SET amount_minor=899 WHERE id='o1'"),
        ("offer disabled", "UPDATE offers SET active=0 WHERE id='o1'"),
        ("language rights change", "UPDATE rights_contract_languages SET language_code='fr' WHERE id='cl1'"),
        ("contract revocation", "UPDATE rights_contracts SET status='terminated' WHERE id='c1'"),
        ("new DRM policy", "UPDATE editions SET drm_status='adobe' WHERE id='e1'"),
        ("digital asset update", "UPDATE digital_assets SET kind='audio' WHERE id='a1'"),
        ("territory sellability", "UPDATE territories SET is_sellable=0 WHERE code='US'"),
        ("territory alias mapping", "UPDATE territory_aliases SET territory_code='CA' WHERE alias_code='ZZ'"),
        ("market fallback", "UPDATE storefront_markets SET currency='CAD' WHERE country_code='US'"),
        ("offer reassignment", "UPDATE offers SET product_id='p2' WHERE id='o1'"),
    ]
    for label, mutation in cases:
        db = environment()
        observation = writer.observe_source_versions(db, "p1", "US")
        assert observation is not None
        db.execute(mutation)
        assert not attempt(db, observed=observation), label + " regranted from stale evidence"
        assert_denied(db, label + " left a positive authority row")
        db.close()


def test_denials_and_transition_boundaries():
    db = environment()
    observed = writer.observe_source_versions(db, "p1", "US")
    denied = dict(granted(), allowed=False, reasonCode="EXPLICIT_DENY")
    assert not attempt(db, observed=observed, verdict=denied)
    assert_denied(db, "Explicit canonical DENY must remain denied")
    assert not attempt(db, verdict=dict(granted(), grantId=""))
    assert not attempt(db, verdict=dict(granted(), territory="CA"))
    assert not attempt(db, verdict=dict(granted(), salesChannel="library"))
    assert not attempt(db, verdict=dict(granted(), nextTransitionAt="2026-11-15 13:29:59"))
    assert not attempt(db, verdict=dict(granted(), nextTransitionAt="bad date"))
    assert attempt(db, verdict=granted("2026-11-15 13:30:04"))
    assert fixture.read(db, at="2026-11-15 13:30:04") is None
    db.execute("UPDATE offers SET ends_at='2026-11-15 13:30:02' WHERE id='o1'")
    assert not attempt(db, verdict=granted("2026-11-15 13:30:05"))
    db.close()


def test_scheduled_new_offer_fails_closed_and_atomic_rollback():
    db = environment()
    db.execute(
        "INSERT INTO offers(id,product_id,amount_minor,starts_at) VALUES(?,?,?,?)",
        ("future", "p1", 499, "2026-11-15 13:30:05"),
    )
    assert not attempt(db), "Current projected price cannot overlook future offer start"
    assert attempt(db, verdict=granted("2026-11-15 13:30:04"))
    assert fixture.read(db, at="2026-11-15 13:30:04") is None
    db.close()

    db = environment()
    db.execute("BEGIN IMMEDIATE")
    assert attempt(db)
    assert fixture.read(db) is not None
    db.execute("ROLLBACK")
    # Fixture already included a positive row. Rollback must return its old
    # observed value and never expose a newly computed price or grant.
    assert fixture.read(db) == ("p1", "o1", 599)
    db.close()


if __name__ == "__main__":
    test_atomic_success_and_owner_boundaries()
    test_stale_observations_cannot_regrant()
    test_denials_and_transition_boundaries()
    test_scheduled_new_offer_fails_closed_and_atomic_rollback()
    print(
        "PASS: isolated staged owner CAS positive writer; no stale regrant "
        "after revocation, repricing, owner, territory and market races; "
        "live offer ID and price checks, scheduled offer exclusion and "
        "30-second expiry. NOT real legal resolver parity."
    )
