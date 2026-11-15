"""Synthetic-only SQLite migration proof. Never points at production D1."""
from pathlib import Path
import sqlite3

SCHEMA = Path("scripts/staging/sql/synthetic-public-metadata-revision-fence.sql").read_text()
assert "SYNTHETIC FIXTURE ONLY" in SCHEMA
assert "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" in SCHEMA
assert "4bd657ac-8789-403e-a28c-93aba8d0a989" not in SCHEMA
assert SCHEMA.count("CREATE TRIGGER IF NOT EXISTS ") == 18

db = sqlite3.connect(":memory:")
db.executescript(
    """
CREATE TABLE gutenberg_source_cache (
  id TEXT PRIMARY KEY, source_project TEXT NOT NULL, source_url TEXT NOT NULL,
  source_license_url TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE publishing_publication_disclosures (
  publication_version_id TEXT PRIMARY KEY, ai_disclosure_id TEXT,
  policy_version TEXT, text_origin TEXT, cover_origin TEXT,
  narration_origin TEXT, translation_origin TEXT,
  synthetic_voice_label TEXT, public_badges_json TEXT
);
CREATE TABLE publishing_release_lifecycles (
  id TEXT PRIMARY KEY, publishing_edition_id TEXT,
  current_publication_version_id TEXT
);
CREATE TABLE publishing_publications (
  id TEXT PRIMARY KEY, product_id TEXT, edition_id TEXT
);
CREATE TABLE publishing_publication_versions (
  id TEXT PRIMARY KEY, publication_id TEXT, lifecycle_id TEXT
);
CREATE TABLE products (
  id TEXT PRIMARY KEY, source_name TEXT, source_external_id TEXT, updated_at TEXT
);
"""
)
db.executescript(SCHEMA)
db.executescript(SCHEMA)  # Idempotent even after a staged recovery
def revision():
    row = db.execute(
        "SELECT CAST(revision AS TEXT) FROM cove_synthetic_public_metadata_revision WHERE id=1"
    ).fetchone()
    assert row and row[0].isdigit()
    return int(row[0])

def changed(stmt, params=(), expected=True):
    old = revision()
    db.execute(stmt, params)
    assert revision() == old + int(expected), (stmt, old, revision())

assert revision() == 1
changed(
    "INSERT INTO gutenberg_source_cache VALUES (?,?,?,?,?)",
    ("synthetic-1", "Gutenberg", "https://source.test/1", "https://license.test/1", "2026-11-15"),
)
changed(
    "UPDATE gutenberg_source_cache SET updated_at=? WHERE id='synthetic-1'",
    ("2026-11-16",),
    expected=False,
)
changed(
    "UPDATE gutenberg_source_cache SET source_license_url=? WHERE id='synthetic-1'",
    ("https://license.test/1",),
    expected=False,
)
changed(
    "UPDATE gutenberg_source_cache SET source_license_url=? WHERE id='synthetic-1'",
    ("https://license.test/withdrawn",),
)
changed(
    "UPDATE gutenberg_source_cache SET source_project=? WHERE id='synthetic-1'",
    ("New Source",),
)
changed("DELETE FROM gutenberg_source_cache WHERE id='synthetic-1'")
# A product can point to a NEW Gutenberg record without modifying either
# source-cache row. No-op updates must not invalidate; inserts, source pointer
# changes, and deletes must deny stale publication snapshots immediately.
changed(
    "INSERT INTO products VALUES (?,?,?,?)",
    ("product-1", "gutenberg", "synthetic-1", "2026-11-15"),
)
changed(
    "UPDATE products SET updated_at=? WHERE id='product-1'",
    ("2026-11-16",),
    expected=False,
)
changed(
    "UPDATE products SET source_external_id=? WHERE id='product-1'",
    ("synthetic-1",),
    expected=False,
)
changed(
    "UPDATE products SET source_external_id=? WHERE id='product-1'",
    ("synthetic-2",),
)
changed(
    "UPDATE products SET source_name=? WHERE id='product-1'",
    ("publisher",),
)
changed("DELETE FROM products WHERE id='product-1'")
changed(
    "INSERT INTO publishing_publication_disclosures VALUES (?,?,?,?,?,?,?,?,?)",
    ("version-1", "ai-1", "1", "human", "human", "human", "human", "", "[]"),
)
changed(
    "UPDATE publishing_publication_disclosures SET public_badges_json=? WHERE publication_version_id='version-1'",
    ("[]",),
    expected=False,
)
changed(
    "UPDATE publishing_publication_disclosures SET public_badges_json=? WHERE publication_version_id='version-1'",
    ('[{"label":"revised"}]',),
)
changed("DELETE FROM publishing_publication_disclosures WHERE publication_version_id='version-1'")
changed(
    "INSERT INTO publishing_release_lifecycles VALUES (?,?,?)",
    ("lifecycle-1", "draft-1", "version-1"),
)
changed(
    "UPDATE publishing_release_lifecycles SET current_publication_version_id=? WHERE id='lifecycle-1'",
    ("version-1",),
    expected=False,
)
changed(
    "UPDATE publishing_release_lifecycles SET current_publication_version_id=? WHERE id='lifecycle-1'",
    ("version-2",),
)
changed("DELETE FROM publishing_release_lifecycles WHERE id='lifecycle-1'")
changed(
    "INSERT INTO publishing_publications VALUES (?,?,?)",
    ("publication-1", "product-1", "edition-1"),
)
changed(
    "UPDATE publishing_publications SET product_id=? WHERE id='publication-1'",
    ("product-2",),
)
changed("DELETE FROM publishing_publications WHERE id='publication-1'")
changed(
    "INSERT INTO publishing_publication_versions VALUES (?,?,?)",
    ("version-1", "pub-1", "lifecycle-1"),
)
changed(
    "UPDATE publishing_publication_versions SET publication_id=? WHERE id='version-1'",
    ("pub-2",),
)
changed("DELETE FROM publishing_publication_versions WHERE id='version-1'")

prior = revision()
db.commit()
db.execute("BEGIN")
db.execute(
    "INSERT INTO publishing_publication_disclosures VALUES (?,?,?,?,?,?,?,?,?)",
    ("version-2", "ai-2", "1", "human", "human", "human", "human", "", "[]"),
)
assert revision() == prior + 1
db.rollback()
assert revision() == prior, "Aborted metadata publication must not advance committed revision"

print("PASS: 18 isolated D1 triggers deny stale source pointers, license and AI generations; no-op and rolled-back writes handled")
