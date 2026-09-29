-- Cove-native catalog identity + normalized discovery metadata.
-- Source identifiers (Gutenberg, ISBN, publisher keys) are aliases, never public identity.

ALTER TABLE works ADD COLUMN public_id TEXT;
ALTER TABLE editions ADD COLUMN public_id TEXT;
ALTER TABLE products ADD COLUMN public_id TEXT;

UPDATE works SET public_id='wrk_'||lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id='';
UPDATE editions SET public_id='edn_'||lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id='';
UPDATE products SET public_id='prd_'||lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id='';

CREATE UNIQUE INDEX idx_works_public_id ON works(public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX idx_editions_public_id ON editions(public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX idx_products_public_id ON products(public_id) WHERE public_id IS NOT NULL;

CREATE TRIGGER trg_works_public_id AFTER INSERT ON works
WHEN NEW.public_id IS NULL OR NEW.public_id=''
BEGIN UPDATE works SET public_id='wrk_'||lower(hex(randomblob(16))) WHERE id=NEW.id; END;
CREATE TRIGGER trg_editions_public_id AFTER INSERT ON editions
WHEN NEW.public_id IS NULL OR NEW.public_id=''
BEGIN UPDATE editions SET public_id='edn_'||lower(hex(randomblob(16))) WHERE id=NEW.id; END;
CREATE TRIGGER trg_products_public_id AFTER INSERT ON products
WHEN NEW.public_id IS NULL OR NEW.public_id=''
BEGIN UPDATE products SET public_id='prd_'||lower(hex(randomblob(16))) WHERE id=NEW.id; END;

-- Public IDs are immutable. Internal PKs can remain implementation details while all
-- customer/API/catalog references move to the opaque identity.
CREATE TRIGGER trg_works_public_id_immutable BEFORE UPDATE OF public_id ON works
WHEN OLD.public_id IS NOT NULL AND OLD.public_id<>'' AND NEW.public_id<>OLD.public_id
BEGIN SELECT RAISE(ABORT,'Cove work public_id is immutable'); END;
CREATE TRIGGER trg_editions_public_id_immutable BEFORE UPDATE OF public_id ON editions
WHEN OLD.public_id IS NOT NULL AND OLD.public_id<>'' AND NEW.public_id<>OLD.public_id
BEGIN SELECT RAISE(ABORT,'Cove edition public_id is immutable'); END;
CREATE TRIGGER trg_products_public_id_immutable BEFORE UPDATE OF public_id ON products
WHEN OLD.public_id IS NOT NULL AND OLD.public_id<>'' AND NEW.public_id<>OLD.public_id
BEGIN SELECT RAISE(ABORT,'Cove product public_id is immutable'); END;

-- Explicit source aliases for Gutenberg and ISBN. Existing source_name/source_external_id
-- remain ingestion provenance, not customer-visible identity.
INSERT OR IGNORE INTO external_identifiers(entity_type,entity_id,scheme,value)
SELECT 'product',p.id,'gutenberg',gc.source_item_id
FROM products p JOIN gutenberg_source_cache gc ON gc.id=p.source_external_id
WHERE p.source_name='gutenberg' AND gc.source_id='pg_us' AND gc.source_item_id<>'';
INSERT OR IGNORE INTO external_identifiers(entity_type,entity_id,scheme,value)
SELECT 'edition',e.id,'gutenberg',gc.source_item_id
FROM editions e JOIN products p ON p.edition_id=e.id JOIN gutenberg_source_cache gc ON gc.id=p.source_external_id
WHERE p.source_name='gutenberg' AND gc.source_id='pg_us' AND gc.source_item_id<>'';
INSERT OR IGNORE INTO external_identifiers(entity_type,entity_id,scheme,value)
SELECT 'work',w.id,'gutenberg',gc.source_item_id
FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id JOIN gutenberg_source_cache gc ON gc.id=p.source_external_id
WHERE p.source_name='gutenberg' AND gc.source_id='pg_us' AND gc.source_item_id<>'';
INSERT OR IGNORE INTO external_identifiers(entity_type,entity_id,scheme,value)
SELECT 'edition',id,'isbn13',isbn13 FROM editions WHERE isbn13 IS NOT NULL AND trim(isbn13)<>'';

CREATE TABLE subjects (
  id TEXT PRIMARY KEY NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'source',
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_subjects_scheme_normalized ON subjects(scheme,normalized_name);
CREATE INDEX idx_subjects_parent ON subjects(parent_id,name);

CREATE TABLE edition_subjects (
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'metadata',
  PRIMARY KEY(edition_id,subject_id)
);
CREATE INDEX idx_edition_subjects_subject ON edition_subjects(subject_id,edition_id);

-- Backfill Gutenberg subjects from their prior category representation. Categories remain
-- the browse/taxonomy classification layer; subjects are descriptive metadata.
INSERT OR IGNORE INTO subjects(id,scheme,name,normalized_name,created_at,updated_at)
SELECT 'sub_'||lower(hex(randomblob(16))),'gutenberg',c.name,lower(trim(c.name)),datetime('now'),datetime('now')
FROM categories c WHERE c.scheme='gutenberg-subject';
INSERT OR IGNORE INTO edition_subjects(edition_id,subject_id,position,source)
SELECT ec.edition_id,s.id,ec.position,'gutenberg'
FROM edition_categories ec JOIN categories c ON c.id=ec.category_id
JOIN subjects s ON s.scheme='gutenberg' AND s.normalized_name=lower(trim(c.name))
WHERE c.scheme='gutenberg-subject';

CREATE TABLE languages (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  native_name TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'ltr' CHECK(direction IN ('ltr','rtl')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO languages(code,name,native_name,direction,created_at,updated_at)
SELECT DISTINCT lower(language_code),'','',CASE WHEN lower(language_code) IN ('ar','fa','he','ur') THEN 'rtl' ELSE 'ltr' END,datetime('now'),datetime('now')
FROM edition_languages WHERE trim(language_code)<>'';
INSERT OR IGNORE INTO languages(code,name,native_name,direction,created_at,updated_at) VALUES
('en','English','English','ltr',datetime('now'),datetime('now')),
('es','Spanish','Español','ltr',datetime('now'),datetime('now')),
('fr','French','Français','ltr',datetime('now'),datetime('now')),
('de','German','Deutsch','ltr',datetime('now'),datetime('now')),
('it','Italian','Italiano','ltr',datetime('now'),datetime('now')),
('pt','Portuguese','Português','ltr',datetime('now'),datetime('now')),
('ar','Arabic','العربية','rtl',datetime('now'),datetime('now'));

-- Work-level authorship is distinct from edition-level contributors (translator/editor/etc.).
CREATE TABLE work_contributors (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'author',
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(work_id,contributor_id,role)
);
CREATE INDEX idx_work_contributors_person ON work_contributors(contributor_id,role,work_id);
INSERT OR IGNORE INTO work_contributors(work_id,contributor_id,role,position)
SELECT DISTINCT e.work_id,ec.contributor_id,'author',ec.position
FROM edition_contributors ec JOIN editions e ON e.id=ec.edition_id WHERE ec.role='author';

-- Search documents remain denormalized projections for speed, but source-of-truth metadata
-- now comes from normalized relations above.
UPDATE catalog_search_documents SET
  subjects_text=COALESCE((
    SELECT group_concat(s.name,' | ') FROM products p2 JOIN edition_subjects es ON es.edition_id=p2.edition_id JOIN subjects s ON s.id=es.subject_id
    WHERE p2.id=catalog_search_documents.product_id
  ),''),
  categories_text=COALESCE((
    SELECT group_concat(c.name,' | ') FROM products p2 JOIN edition_categories ec ON ec.edition_id=p2.edition_id JOIN categories c ON c.id=ec.category_id
    WHERE p2.id=catalog_search_documents.product_id AND c.scheme<>'gutenberg-subject'
  ),'');

-- Gutenberg subjects are descriptive subject headings, not retail categories. Once safely
-- backfilled, remove the old duplicate classification rows so discovery has one source of truth.
DELETE FROM edition_categories WHERE category_id IN (SELECT id FROM categories WHERE scheme='gutenberg-subject');
DELETE FROM categories WHERE scheme='gutenberg-subject';

-- Preserve old URLs as aliases while allowing SEO/public APIs to resolve opaque IDs.
CREATE TABLE catalog_public_aliases (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('work','edition','product')),
  alias TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'legacy',
  canonical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_type,alias)
);
CREATE INDEX idx_catalog_public_alias_entity ON catalog_public_aliases(entity_type,entity_id,canonical);
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'work',id,id,'legacy-internal-id',0,datetime('now') FROM works;
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'edition',id,id,'legacy-internal-id',0,datetime('now') FROM editions;
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'product',id,id,'legacy-internal-id',0,datetime('now') FROM products;
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'product',source_external_id,id,'source-external-id',0,datetime('now') FROM products WHERE source_external_id<>'' AND source_name IN ('gutenberg','upload');

-- Canonical aliases are the opaque Cove IDs. Source IDs remain compatibility aliases only.
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'work',public_id,id,'fore-public-id',1,datetime('now') FROM works WHERE public_id IS NOT NULL AND public_id<>'';
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'edition',public_id,id,'fore-public-id',1,datetime('now') FROM editions WHERE public_id IS NOT NULL AND public_id<>'';
INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
SELECT 'product',public_id,id,'fore-public-id',1,datetime('now') FROM products WHERE public_id IS NOT NULL AND public_id<>'';

-- Keep the alias registry complete for records created after this migration. Public IDs are
-- generated by the triggers above; the UPDATE trigger captures those generated values while
-- the INSERT trigger covers callers that explicitly provide a Cove public ID.
CREATE TRIGGER trg_works_public_alias_insert AFTER INSERT ON works
WHEN NEW.public_id IS NOT NULL AND NEW.public_id<>''
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  VALUES('work',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now'));
END;
CREATE TRIGGER trg_works_public_alias_update AFTER UPDATE OF public_id ON works
WHEN NEW.public_id IS NOT NULL AND NEW.public_id<>'' AND (OLD.public_id IS NULL OR OLD.public_id='')
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  VALUES('work',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now'));
END;
CREATE TRIGGER trg_editions_public_alias_insert AFTER INSERT ON editions
WHEN NEW.public_id IS NOT NULL AND NEW.public_id<>''
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  VALUES('edition',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now'));
END;
CREATE TRIGGER trg_editions_public_alias_update AFTER UPDATE OF public_id ON editions
WHEN NEW.public_id IS NOT NULL AND NEW.public_id<>'' AND (OLD.public_id IS NULL OR OLD.public_id='')
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  VALUES('edition',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now'));
END;
CREATE TRIGGER trg_products_public_alias_insert AFTER INSERT ON products
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  SELECT 'product',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now') WHERE NEW.public_id IS NOT NULL AND NEW.public_id<>'';
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  SELECT 'product',NEW.source_external_id,NEW.id,'source-external-id',0,datetime('now') WHERE NEW.source_external_id<>'' AND NEW.source_name IN ('gutenberg','upload');
END;
CREATE TRIGGER trg_products_public_alias_update AFTER UPDATE OF public_id ON products
WHEN NEW.public_id IS NOT NULL AND NEW.public_id<>'' AND (OLD.public_id IS NULL OR OLD.public_id='')
BEGIN
  INSERT OR IGNORE INTO catalog_public_aliases(entity_type,alias,entity_id,alias_kind,canonical,created_at)
  VALUES('product',NEW.public_id,NEW.id,'fore-public-id',1,datetime('now'));
END;
