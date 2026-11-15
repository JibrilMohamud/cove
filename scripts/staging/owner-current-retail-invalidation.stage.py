"""Stage-only D1 authority projection invalidation proof.

This module is intentionally NOT a production migration and NEVER grants rights.
Only the future canonical legal owner may materialize positive rows after
verifying the complete current legal/contract/language/DRM/offer policy.
Any mutation of known source tables invalidates affected primary-D1 rows
inside the SAME SQLite transaction, BEFORE foreign-key cascades can erase
referenced join paths. This is a fail-closed safety backstop, not
a substitute for retiring all non-owner D1 writers.

Do not bind it to production or put rights/offer eligibility in R2.
"""
from __future__ import annotations

AUTHORITY_STATE = "cove_stage_owner_authority_state"
PROJECTION = "cove_stage_owner_retail_authority"
SOURCE_VERSION = "cove_stage_owner_product_source_version"
TERRITORY_VERSION = "cove_stage_owner_territory_version"
MARKET_VERSION = "cove_stage_owner_market_version"

# Each expression maps NEW/OLD mutated rows to affected products. These are
# source-table dependencies, not statements that legal permission exists.
PRODUCT_SCOPES = {
    "products": "SELECT {ref}.id AS product_id",
    "editions": "SELECT p.id AS product_id FROM products p WHERE p.edition_id={ref}.id",
    "rights_grants": "SELECT p.id AS product_id FROM products p WHERE p.edition_id={ref}.edition_id",
    "rights_grant_territories": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "WHERE rg.id={ref}.grant_id"
    ),
    "rights_contracts": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "WHERE rg.contract_id={ref}.id"
    ),
    "rights_contract_languages": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "WHERE rg.contract_id={ref}.contract_id"
    ),
    "rights_contract_versions": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "WHERE rg.contract_id={ref}.contract_id"
    ),
    "rights_contract_version_territories": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "JOIN rights_contract_versions rv ON rv.contract_id=rg.contract_id "
        "WHERE rv.id={ref}.contract_version_id"
    ),
    "rights_contract_version_formats": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "JOIN rights_contract_versions rv ON rv.contract_id=rg.contract_id "
        "WHERE rv.id={ref}.contract_version_id"
    ),
    "rights_contract_version_channels": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "JOIN rights_contract_versions rv ON rv.contract_id=rg.contract_id "
        "WHERE rv.id={ref}.contract_version_id"
    ),
    "publisher_contract_assignments": (
        "SELECT p.id AS product_id FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id "
        "WHERE rg.contract_id={ref}.contract_id"
    ),
    "edition_languages": "SELECT p.id AS product_id FROM products p WHERE p.edition_id={ref}.edition_id",
    "offers": "SELECT {ref}.product_id AS product_id",
    "digital_assets": "SELECT p.id AS product_id FROM products p WHERE p.edition_id={ref}.edition_id",
    "asset_versions": (
        "SELECT p.id AS product_id FROM products p JOIN digital_assets da ON da.edition_id=p.edition_id "
        "WHERE da.current_version_id={ref}.id"
    ),
    "catalog_search_documents": "SELECT {ref}.product_id AS product_id",
}

# Territory eligibility and aliases are used directly by the canonical
# live resolver. Never keep a positive row for a territory whose sellability
# or canonical alias mapping changed.
TERRITORY_SCOPES = {
    "territories": "SELECT {ref}.code AS territory_code",
    "territory_aliases": "SELECT {ref}.territory_code AS territory_code",
}

# US market is an existing fallback for markets with missing local currency.
# On US market edits, deny all projection rows until owner rebuilds them.
# This is deliberately conservative; an atomic full rebuild is required
# before production to avoid global temporary display gaps.
MARKET_SCOPE = (
    "DELETE FROM " + PROJECTION
    + " WHERE territory_code={ref}.country_code OR {ref}.country_code='US';"
)

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {AUTHORITY_STATE} (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    epoch INTEGER NOT NULL CHECK(epoch>0),
    us_fallback_revision INTEGER NOT NULL DEFAULT 1 CHECK(us_fallback_revision>0)
);
-- A disabled legal authority must NEVER reactivate old positive rows using
-- the same epoch. Source-version match alone cannot guard an owner reset.
CREATE TRIGGER IF NOT EXISTS cove_stage_owner_require_epoch_rotation
BEFORE UPDATE ON {AUTHORITY_STATE}
WHEN NEW.epoch<OLD.epoch
  OR NEW.us_fallback_revision<OLD.us_fallback_revision
  OR (OLD.enabled=0 AND NEW.enabled=1 AND NEW.epoch<=OLD.epoch)
BEGIN SELECT RAISE(ABORT,'cove_stage_owner_epoch_rotation_required'); END;
CREATE TRIGGER IF NOT EXISTS cove_stage_owner_preserve_state
BEFORE DELETE ON {AUTHORITY_STATE}
BEGIN SELECT RAISE(ABORT,'cove_stage_owner_state_must_not_be_deleted'); END;
CREATE TABLE IF NOT EXISTS {SOURCE_VERSION} (
    product_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS {TERRITORY_VERSION} (
    territory_code TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS {MARKET_VERSION} (
    territory_code TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS {PROJECTION} (
    product_id TEXT NOT NULL,
    territory_code TEXT NOT NULL CHECK(length(territory_code)=2),
    currency TEXT NOT NULL CHECK(length(currency)=3),
    amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
    current_offer_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
    source_revision INTEGER NOT NULL CHECK(source_revision>0),
    territory_revision INTEGER NOT NULL CHECK(territory_revision>0),
    market_revision INTEGER NOT NULL CHECK(market_revision>=0),
    us_fallback_revision INTEGER NOT NULL CHECK(us_fallback_revision>0),
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
    valid_until TEXT NOT NULL,
    PRIMARY KEY(product_id,territory_code,currency)
) WITHOUT ROWID;
"""

READ_SQL = f"""
SELECT p.product_id,p.current_offer_id,p.amount_minor
FROM {PROJECTION} p
CROSS JOIN {AUTHORITY_STATE} owner
JOIN {SOURCE_VERSION} source_version ON source_version.product_id=p.product_id
JOIN {TERRITORY_VERSION} territory_version ON territory_version.territory_code=p.territory_code
LEFT JOIN {MARKET_VERSION} market_version ON market_version.territory_code=p.territory_code
WHERE owner.id=1 AND owner.enabled=1 AND p.owner_epoch=owner.epoch
 AND p.source_revision=source_version.revision
 AND p.territory_revision=territory_version.revision
 AND p.market_revision=COALESCE(market_version.revision,0)
 AND p.us_fallback_revision=owner.us_fallback_revision
 AND p.product_id=? AND p.territory_code=? AND p.currency=?
 AND p.valid_until>?
"""


def invalidation_triggers() -> str:
    statements = []
    for table, scope in PRODUCT_SCOPES.items():
        for operation, aliases in (
            ("INSERT", ("NEW",)),
            ("UPDATE", ("OLD", "NEW")),
            ("DELETE", ("OLD",)),
        ):
            conditions = " OR ".join(
                "product_id IN (" + scope.format(ref=ref) + ")" for ref in aliases
            )
            scopes = " UNION ".join(scope.format(ref=ref) for ref in aliases)
            statements.append(
                f"CREATE TRIGGER cove_stage_owner_invalidate_{table}_{operation.lower()} "
                f"BEFORE {operation} ON {table} BEGIN "
                f"DELETE FROM {PROJECTION} WHERE {conditions}; "
                f"INSERT OR IGNORE INTO {SOURCE_VERSION}(product_id,revision) "
                f"SELECT product_id,1 FROM ({scopes}); "
                f"UPDATE {SOURCE_VERSION} SET revision=revision+1 "
                f"WHERE product_id IN ({scopes}); END;"
            )
    for table, scope in TERRITORY_SCOPES.items():
        for operation, aliases in (
            ("INSERT", ("NEW",)),
            ("UPDATE", ("OLD", "NEW")),
            ("DELETE", ("OLD",)),
        ):
            conditions = " OR ".join(
                "territory_code IN (" + scope.format(ref=ref) + ")" for ref in aliases
            )
            scopes = " UNION ".join(scope.format(ref=ref) for ref in aliases)
            statements.append(
                f"CREATE TRIGGER cove_stage_owner_invalidate_{table}_{operation.lower()} "
                f"BEFORE {operation} ON {table} BEGIN "
                f"DELETE FROM {PROJECTION} WHERE {conditions}; "
                f"INSERT OR IGNORE INTO {TERRITORY_VERSION}(territory_code,revision) "
                f"SELECT territory_code,1 FROM ({scopes}); "
                f"UPDATE {TERRITORY_VERSION} SET revision=revision+1 "
                f"WHERE territory_code IN ({scopes}); END;"
            )
    for operation, aliases in (
        ("INSERT", ("NEW",)),
        ("UPDATE", ("OLD", "NEW")),
        ("DELETE", ("OLD",)),
    ):
        actions = " ".join(
            MARKET_SCOPE.format(ref=ref)
            + f"INSERT OR IGNORE INTO {MARKET_VERSION}(territory_code,revision) VALUES({ref}.country_code,1); "
            + f"UPDATE {MARKET_VERSION} SET revision=revision+1 WHERE territory_code={ref}.country_code; "
            + f"UPDATE {AUTHORITY_STATE} SET us_fallback_revision=us_fallback_revision+1 WHERE id=1 AND {ref}.country_code='US'; "
            for ref in aliases
        )
        statements.append(
            "CREATE TRIGGER cove_stage_owner_invalidate_storefront_markets_"
            + operation.lower()
            + f" BEFORE {operation} ON storefront_markets BEGIN {actions} END;"
        )
    return "\n".join(statements) + "\n"


def stage_schema() -> str:
    return SCHEMA + invalidation_triggers()


if __name__ == "__main__":
    print(stage_schema())
