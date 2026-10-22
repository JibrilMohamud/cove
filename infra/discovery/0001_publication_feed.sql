-- Independent presentation ledger. Never apply to the rights/customer DB.
CREATE TABLE discovery_domain_identity (
  id INTEGER PRIMARY KEY CHECK(id=1), domain TEXT NOT NULL, schema_version INTEGER NOT NULL
);
INSERT INTO discovery_domain_identity VALUES(1,'cove-public-presentation',1);
CREATE TABLE discovery_publications (
  country TEXT PRIMARY KEY CHECK(length(country)=2),
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK(status IN ('delivered','exporting','ready','publishing')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  due_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '', sha256 TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  source_metrics TEXT NOT NULL DEFAULT '{}', last_error TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX discovery_publications_due ON discovery_publications(active,status,due_at,country);
