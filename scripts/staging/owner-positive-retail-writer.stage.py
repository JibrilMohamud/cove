"""Stage-only canonical-owner positive publication prototype.

This is NOT production authorization: the canonical positive decision must
come from Cove's real resolveProductRights at the verified owner, not from
the hand-built predicates in this fixture. The test evaluator below is
deliberately fake and proves stale evaluations CANNOT reinsert a positive
after a source, market, territory or owner-epoch mutation.

The final INSERT ... SELECT is one SQLite statement and must be executed by
the sole canonical legal owner. Production must prevent any other D1 writer
or bearer token from issuing it, and prove parity with the real resolver.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from hashlib import sha256
import importlib.util
import json
from pathlib import Path

SOURCE = Path(__file__).with_name("owner-current-retail-invalidation.stage.py")
spec = importlib.util.spec_from_file_location("stage_owner_projection", SOURCE)
assert spec and spec.loader
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)

MAX_STAGE_LEASE_SECONDS = 30

OBSERVE_SQL = f"""
SELECT src.revision,t.revision,COALESCE(m.revision,0),
       owner.epoch,owner.us_fallback_revision
FROM {projection.SOURCE_VERSION} src
JOIN {projection.TERRITORY_VERSION} t ON t.territory_code=?
LEFT JOIN {projection.MARKET_VERSION} m ON m.territory_code=t.territory_code
CROSS JOIN {projection.AUTHORITY_STATE} owner
WHERE src.product_id=? AND owner.id=1 AND owner.enabled=1
"""

# No D1 batch of a separately evaluated SELECT followed by an unconditional
# INSERT. Instead every policy dependency revision is checked in the SAME
# primary-D1 statement as the positive insert. An offer race also fails.
CAS_INSERT_SQL = f"""
INSERT OR REPLACE INTO {projection.PROJECTION} (
  product_id,territory_code,currency,amount_minor,current_offer_id,
  owner_epoch,source_revision,territory_revision,market_revision,
  us_fallback_revision,evidence_digest,valid_until
)
SELECT p.id,?,?,o.amount_minor,o.id,owner.epoch,
       src.revision,t.revision,COALESCE(m.revision,0),
       owner.us_fallback_revision,?,?
FROM products p
JOIN editions e ON e.id=p.edition_id
JOIN offers o ON o.product_id=p.id AND o.id=?
JOIN {projection.SOURCE_VERSION} src ON src.product_id=p.id
JOIN {projection.TERRITORY_VERSION} t ON t.territory_code=?
LEFT JOIN {projection.MARKET_VERSION} m ON m.territory_code=t.territory_code
CROSS JOIN {projection.AUTHORITY_STATE} owner
JOIN territories territory ON territory.code=t.territory_code
WHERE p.id=? AND owner.id=1 AND owner.enabled=1
  AND p.storefront_status='active' AND e.release_status='available'
  AND territory.is_sellable=1
  AND owner.epoch=? AND owner.us_fallback_revision=?
  AND src.revision=? AND t.revision=? AND COALESCE(m.revision,0)=?
  AND o.amount_minor=? AND o.currency=? AND o.sales_channel='retail'
  AND o.active=1
  AND (o.starts_at IS NULL OR o.starts_at<=?)
  AND (o.ends_at IS NULL OR o.ends_at>?)
  AND (o.ends_at IS NULL OR o.ends_at>=?)
  AND ?='allow'
  AND EXISTS (
    SELECT 1 FROM retail_product_availability_rows current_legal
    WHERE current_legal.product_id=p.id
      AND current_legal.territory_code=?
  )
  AND NOT EXISTS (
    SELECT 1 FROM offers future_offer
    WHERE future_offer.product_id=p.id
      AND future_offer.currency=o.currency
      AND future_offer.sales_channel='retail'
      AND future_offer.active=1 AND future_offer.id<>o.id
      AND future_offer.starts_at>? AND future_offer.starts_at<?
  )
"""

REVOKE_SQL = f"DELETE FROM {projection.PROJECTION} WHERE product_id=? AND territory_code=? AND currency=?"


def observe_source_versions(db, product_id: str, territory: str):
    return db.execute(OBSERVE_SQL, (territory, product_id)).fetchone()


def _instant(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")


def publish_if_still_authorized(
    db,
    *,
    product_id: str,
    territory: str,
    currency: str,
    offer_id: str,
    amount_minor: int,
    observed: tuple,
    canonical_verdict: dict,
    evaluated_at: str,
) -> bool:
    """Publish only a previously verified canonical decision with exact CAS.

    True means one SQLite row was inserted; this stage implementation does
    NOT implement resolveProductRights itself or ensure exclusive DB writes.
    The real owner must fetch the actual resolver verdict before calling it.
    """
    if not observed or len(observed) != 5:
        return False
    if (
        canonical_verdict.get("allowed") is not True
        or canonical_verdict.get("productId") != product_id
        or canonical_verdict.get("territory") != territory
        or canonical_verdict.get("salesChannel") != "retail"
        or not isinstance(canonical_verdict.get("grantId"), str)
        or not canonical_verdict["grantId"]
    ):
        db.execute(REVOKE_SQL, (product_id, territory, currency))
        return False
    try:
        now = _instant(evaluated_at)
        boundary = _instant(canonical_verdict["nextTransitionAt"])
        expiry = min(now + timedelta(seconds=MAX_STAGE_LEASE_SECONDS), boundary)
        if expiry <= now or not isinstance(amount_minor, int) or amount_minor < 0:
            return False
        if not isinstance(offer_id, str) or not offer_id:
            return False
        if not isinstance(currency, str) or len(currency) != 3 or currency != currency.upper():
            return False
        if not isinstance(territory, str) or len(territory) != 2 or territory != territory.upper():
            return False
        if not all(isinstance(x, int) and x >= 0 for x in observed):
            return False
    except (KeyError, TypeError, ValueError):
        return False
    expires_at = expiry.strftime("%Y-%m-%d %H:%M:%S")
    evidence = {
        "product": product_id,
        "market": territory,
        "currency": currency,
        "offer": offer_id,
        "price": amount_minor,
        "observed": list(observed),
        "canonicalGrant": canonical_verdict["grantId"],
        "canonicalReason": canonical_verdict.get("reasonCode"),
        "canonicalContractVersion": canonical_verdict.get("contractVersionId"),
        "validUntil": expires_at,
    }
    digest = sha256(json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    # SQLite serializes this one statement against concurrent source edits.
    # A stale canonical evaluation cannot pass its source/market/owner version
    # equality tests after any covered permission-changing mutation.
    before = db.total_changes
    db.execute(
        CAS_INSERT_SQL,
        (
            territory, currency, digest, expires_at,
            offer_id, territory, product_id,
            observed[3], observed[4], observed[0], observed[1], observed[2],
            amount_minor, currency, evaluated_at, evaluated_at, expires_at,
            "allow", territory, evaluated_at, expires_at,
        ),
    )
    return db.total_changes - before == 1
