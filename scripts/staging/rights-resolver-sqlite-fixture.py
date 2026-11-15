"""In-memory SQLite RPC for canonical rights-resolver policy branch tests.

No cloud binding, no production data, no authentication or payment fixtures.
Actual TypeScript resolveProductRights issues the SQL via this read-only RPC.
Only named test scenarios can mutate this isolated in-memory database.
"""
from __future__ import annotations

import json
import sqlite3
import sys

SCHEMA = """
CREATE TABLE territory_aliases(alias_code TEXT,territory_code TEXT);
CREATE TABLE territories(code TEXT PRIMARY KEY,is_sellable INTEGER);
CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,storefront_status TEXT);
CREATE TABLE editions(id TEXT PRIMARY KEY,drm_status TEXT,release_status TEXT);
CREATE TABLE digital_assets(id TEXT,edition_id TEXT,kind TEXT,drm_status TEXT,updated_at TEXT);
CREATE TABLE rights_parties(id TEXT,display_name TEXT);
CREATE TABLE publishers(id TEXT,name TEXT);
CREATE TABLE rights_grants (
 id TEXT,edition_id TEXT,rightsholder_party_id TEXT,rightsholder_id TEXT,
 format TEXT,status TEXT,decision TEXT,sales_channel TEXT,starts_at TEXT,ends_at TEXT,
 drm_requirement TEXT,contract_id TEXT,contract_version_id TEXT,created_at TEXT,
 subscription_permitted INTEGER,library_permitted INTEGER,
 promotion_restrictions_json TEXT,license_type TEXT,
 source_evidence_id TEXT,exclusivity TEXT,scope_summary TEXT,
 contract_reference TEXT
);
CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT);
CREATE TABLE rights_contracts (
 id TEXT,name TEXT,reference_code TEXT,status TEXT,effective_from TEXT,
 effective_to TEXT,language_match_mode TEXT
);
CREATE TABLE edition_languages(edition_id TEXT,language_code TEXT,kind TEXT);
CREATE TABLE rights_contract_languages (
 contract_id TEXT,language_code TEXT,decision TEXT,format TEXT,sales_channel TEXT,
 starts_at TEXT,ends_at TEXT
);
CREATE TABLE rights_contract_versions (
 id TEXT,contract_id TEXT,version_number INTEGER,status TEXT,
 effective_from TEXT,effective_to TEXT,retailer_commission_bps INTEGER,
 payment_schedule_json TEXT,returns_policy_json TEXT,
 subscription_terms_json TEXT,marketing_permissions_json TEXT,
 delivery_rules_json TEXT,termination_policy_json TEXT,
 post_termination_access_policy TEXT,drm_requirements_json TEXT
);
CREATE TABLE rights_contract_version_territories (
 contract_version_id TEXT,territory_code TEXT,decision TEXT
);
CREATE TABLE rights_contract_version_formats (
 contract_version_id TEXT,format TEXT,decision TEXT,drm_requirement TEXT,
 download_limit INTEGER,device_limit INTEGER,offline_permitted INTEGER
);
CREATE TABLE rights_contract_version_channels (
 contract_version_id TEXT,sales_channel TEXT,permitted INTEGER,terms_json TEXT
);
"""

ROWS = [
 ("INSERT INTO territories VALUES('US',1)", ()),
 ("INSERT INTO products VALUES('p_fixture','e_fixture','ebook','active')", ()),
 ("INSERT INTO editions VALUES('e_fixture','none','available')", ()),
 ("INSERT INTO edition_languages VALUES('e_fixture','en','content')", ()),
 ("INSERT INTO digital_assets VALUES('a_fixture','e_fixture','epub','none','2026-01-01')", ()),
 ("INSERT INTO rights_contracts VALUES('rc_fixture','Test contract','R1','active','2020-01-01','2040-01-01','all')", ()),
 ("""INSERT INTO rights_grants VALUES(
 'g_fixture','e_fixture',NULL,NULL,'ebook','active','allow','retail',
 '2020-01-01','2040-01-01','none','rc_fixture','rv_fixture','2020-01-01',
 0,0,'{}','license',NULL,'nonexclusive','',''
 )""", ()),
 ("INSERT INTO rights_grant_territories VALUES('g_fixture','US')", ()),
 ("INSERT INTO rights_contract_languages VALUES('rc_fixture','en','allow','ebook','retail',NULL,NULL)", ()),
 ("""INSERT INTO rights_contract_versions VALUES(
 'rv_fixture','rc_fixture',1,'active','2020-01-01','2040-01-01',1500,
 '{}','{}','{}','{}','{}','{}','preserve_perpetual_purchases','{}'
 )""", ()),
 ("INSERT INTO rights_contract_version_territories VALUES('rv_fixture','US','allow')", ()),
 ("INSERT INTO rights_contract_version_formats VALUES('rv_fixture','ebook','allow','none',NULL,NULL,1)", ()),
 ("INSERT INTO rights_contract_version_channels VALUES('rv_fixture','retail',1,'{}')", ()),
]

MUTATIONS = {
 "baseline": [],
 "explicit-deny": [
  "INSERT INTO rights_grants SELECT 'g_deny',edition_id,rightsholder_party_id,rightsholder_id,format,status,'deny',sales_channel,starts_at,ends_at,drm_requirement,contract_id,contract_version_id,created_at,subscription_permitted,library_permitted,promotion_restrictions_json,license_type,source_evidence_id,exclusivity,scope_summary,contract_reference FROM rights_grants WHERE id='g_fixture'",
  "INSERT INTO rights_grant_territories VALUES('g_deny','US')",
 ],
 "version-inactive": ["UPDATE rights_contract_versions SET status='terminated'"],
 "contract-inactive": ["UPDATE rights_contracts SET status='terminated'"],
 "contract-expired": ["UPDATE rights_contracts SET effective_to='2020-01-01'"],
 "grant-expired": ["UPDATE rights_grants SET ends_at='2020-01-01'"],
 "format-denied": ["UPDATE rights_contract_version_formats SET decision='deny'"],
 "territory-denied": ["UPDATE rights_contract_version_territories SET decision='deny'"],
 "channel-denied": ["UPDATE rights_contract_version_channels SET permitted=0"],
 "drm-required": ["UPDATE rights_contract_version_formats SET drm_requirement='lcp'"],
 "language-denied": [
  "INSERT INTO rights_contract_languages VALUES('rc_fixture','en','deny','ebook','retail',NULL,NULL)"
 ],
 "language-allow-mismatch": [
  "UPDATE rights_contract_languages SET language_code='fr' WHERE decision='allow'",
 ],
 "product-disabled": ["UPDATE products SET storefront_status='hidden'"],
}


def init():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    for sql, params in ROWS:
        db.execute(sql, params)
    db.commit()
    return db


db = init()
for line in sys.stdin:
    try:
        req = json.loads(line)
        kind = req.get("op")
        if kind == "scenario":
            name = req.get("name")
            if name not in MUTATIONS:
                raise ValueError("Unknown isolated scenario")
            db.close()
            db = init()
            for statement in MUTATIONS[name]:
                db.execute(statement)
            db.commit()
            result = {"ready": True}
        elif kind == "query":
            sql = str(req.get("sql") or "")
            if not sql.lstrip().upper().startswith(("SELECT ", "WITH ")):
                raise ValueError("Only read-only SQL is permitted")
            cursor = db.execute(sql, req.get("params") or [])
            result = {"results": [dict(row) for row in cursor.fetchall()]}
        else:
            raise ValueError("Unknown isolated RPC operation")
        print(json.dumps({"id": req["id"], "ok": True, **result}), flush=True)
    except Exception as error:
        print(
            json.dumps({
                "id": req.get("id"),
                "ok": False,
                "error": type(error).__name__ + ": " + str(error)[:250],
            }),
            flush=True,
        )
