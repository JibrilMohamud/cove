"""Compare actual slug triggers and bound insertion work with 25k existing authors."""
from pathlib import Path
import re
import sqlite3

source = Path('drizzle/0018_catalog_entities_and_private_exports.sql').read_text()
migration = Path('drizzle/0079_contributor_slug_seek.sql').read_text()
legacy = sqlite3.connect(':memory:')
legacy.executescript('''
CREATE TABLE contributors(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '2026-10-01');
CREATE UNIQUE INDEX idx_contributors_slug ON contributors(slug) WHERE slug<>'';
CREATE TABLE catalog_entity_slugs(entity_type TEXT,entity_id TEXT,slug TEXT,canonical INTEGER,created_at TEXT,PRIMARY KEY(entity_type,slug));
CREATE INDEX idx_catalog_entity_slugs_entity ON catalog_entity_slugs(entity_type,entity_id,canonical DESC);
CREATE UNIQUE INDEX idx_catalog_entity_slugs_one_canonical ON catalog_entity_slugs(entity_type,entity_id) WHERE canonical=1;
''')
for name in ['trg_contributors_auto_slug','trg_contributors_register_slug','trg_contributors_slug_change']:
    legacy.executescript(re.search(r'CREATE TRIGGER '+name+r'\b.*?END;', source, re.S).group())
legacy.executemany('INSERT INTO contributors(id,name,slug,created_at) VALUES (?,?,?,?)',
                  [(f'old-{i}',f'Existing {i}',f'existing-{i}','2026-10-01') for i in range(25000)])
legacy.execute("INSERT INTO catalog_entity_slugs VALUES('author','reserved','reserved-alias',0,'2026-10-01')")
legacy.commit()
fixed = sqlite3.connect(':memory:')
legacy.backup(fixed)
fixed.executescript(migration)
# The only trigger change is an equivalent predicate exposing a partial index.
old = re.search(r'CREATE TRIGGER trg_contributors_auto_slug\b.*?END;',source,re.S).group()
new = re.search(r'CREATE TRIGGER trg_contributors_auto_slug\b.*?END;',migration,re.S).group()
assert new.replace(" AND x.slug<>''",'') == old

def measured_insert(db, identity, name, slug=''):
    steps=[0]
    db.set_progress_handler(lambda: steps.__setitem__(0,steps[0]+10) or 0,10)
    try:
        db.execute('INSERT INTO contributors(id,name,slug,created_at) VALUES (?,?,?,?)',(identity,name,slug,'2026-10-19'))
    finally:
        db.set_progress_handler(None,0)
    return steps[0]

baseline = measured_insert(legacy,'new-001','New author without collision')
optimized = measured_insert(fixed,'new-001','New author without collision')
assert baseline > 100000, baseline
assert optimized < 1000, optimized
for identity,name,slug in [
    ('new-002','Existing 12500',''),('uniq003','Reserved Alias',''),
    ('uniq004','---',''),('uniq005','Émile Zola',''),('uniq006','Dr. A & B / C',''),
    ('uniq007','Manual author','custom-slug'),('uniq008',"O'Neil, Author",''),
]:
    measured_insert(legacy,identity,name,slug)
    measured_insert(fixed,identity,name,slug)
for db in (legacy,fixed):
    db.execute("UPDATE contributors SET slug='changed-alias' WHERE id='new-001'")
    db.commit()
for table in ['contributors','catalog_entity_slugs']:
    assert legacy.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() == fixed.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall(), table
for db in (legacy,fixed):
    try:
        measured_insert(db,'duplicate-slug','Duplicate','custom-slug')
        raise AssertionError('Unique slugs must remain enforced')
    except sqlite3.IntegrityError:
        db.rollback()
# Roll back the migration itself by restoring the exact legacy trigger.
fixed.executescript('DROP TRIGGER trg_contributors_auto_slug;\n'+old)
assert fixed.execute("SELECT sql FROM sqlite_master WHERE name='trg_contributors_auto_slug'").fetchone()[0] == old.rstrip(';')
print(f'PASS: exact trigger/alias parity, Unicode/punctuation/collisions, uniqueness and rollback; insert VM work {baseline} -> {optimized}')
