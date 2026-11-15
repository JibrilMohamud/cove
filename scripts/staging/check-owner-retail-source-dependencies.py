"""Fail closed on new source tables in the current retail rights read path.

Static source guard only: it is NOT a proof that all legal semantics or writes
have been inventoried. Production owner remains disabled and projection draft.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
rights = (ROOT / "src/features/fore/rights.server.ts").read_text()
spec = importlib.util.spec_from_file_location(
    "cove_stage_owner_dep", Path(__file__).with_name("owner-current-retail-invalidation.stage.py")
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

FUNCTION_BOUNDS = (
    ("async function canonicalTerritoryFromDb", "async function expandHistoricalCode"),
    ("async function languageEligibility", "async function activeGrantRows"),
    ("async function activeGrantRows", "type ContractResolution"),
    ("async function resolveContractPolicyForGrant", "function emptyDecision"),
    ("export async function resolveRightsDecision", "export async function resolveProductRights"),
    ("export async function resolveProductRights", "export const restrictionsSchema"),
)
DEPENDENCY_PATTERN = re.compile(r"\b(?:FROM|JOIN)\s+([a-z][a-z0-9_]*)\b", re.IGNORECASE)
used = set()
for start, end in FUNCTION_BOUNDS:
    a, b = rights.find(start), rights.find(end)
    assert a >= 0 and b > a, "Cove's legal resolver changed shape: review source dependencies"
    used.update(m.group(1).lower() for m in DEPENDENCY_PATTERN.finditer(rights[a:b]))

# Rightsholder/Publisher display names do not determine allowed/denied or
# price in the specific current resolver, and are not stored in the proposed
# compact point-authorization row. Treat adding their policy influence as a
# mandatory human review and explicit projection/trigger change.
ATTRIBUTION_ONLY = {"rights_parties", "publishers"}
covered = set(module.PRODUCT_SCOPES) | set(module.TERRITORY_SCOPES) | {"storefront_markets"}
uncovered = used - covered - ATTRIBUTION_ONLY
assert not uncovered, "New unresolved live rights policy table(s): " + ", ".join(sorted(uncovered))

assert {
    "products",
    "editions",
    "rights_grants",
    "rights_grant_territories",
    "rights_contracts",
    "rights_contract_languages",
    "rights_contract_versions",
    "rights_contract_version_territories",
    "rights_contract_version_formats",
    "rights_contract_version_channels",
    "edition_languages",
    "digital_assets",
    "territories",
    "territory_aliases",
}.issubset(used), "Expected canonical permission tables were removed; review the resolver"

assert len(module.PRODUCT_SCOPES) >= 16
assert {"territories", "territory_aliases"}.issubset(module.TERRITORY_SCOPES)
print(
    "PASS: current canonical rights read-path SQL table dependencies are "
    "known and covered by transactional invalidation (attribution-only "
    "name sources explicitly excluded). Dynamic SQL and owner writers "
    "still require manual production review."
)
