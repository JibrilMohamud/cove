-- First-class discovery entities and explicit private-export semantics.
-- Book content and personal reading data remain separate at the API boundary; this migration
-- strengthens public catalog identity and records non-content export activity without storing export payloads.

ALTER TABLE contributors ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE contributors ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE contributors ADD COLUMN image_url TEXT NOT NULL DEFAULT '';

ALTER TABLE publishers ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE publishers ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE publishers ADD COLUMN logo_url TEXT NOT NULL DEFAULT '';

ALTER TABLE imprints ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE imprints ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE imprints ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE imprints ADD COLUMN logo_url TEXT NOT NULL DEFAULT '';

ALTER TABLE series ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE series ADD COLUMN series_type TEXT NOT NULL DEFAULT 'ordered' CHECK(series_type IN ('ordered','unordered'));
ALTER TABLE series ADD COLUMN hero_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE series ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','archived'));

ALTER TABLE series_memberships ADD COLUMN relationship TEXT NOT NULL DEFAULT 'main' CHECK(relationship IN ('main','prequel','novella','related','boxset','companion'));
ALTER TABLE series_memberships ADD COLUMN reading_order REAL;
ALTER TABLE series_memberships ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

UPDATE contributors
SET slug = CASE
  WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(contributors.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'author-' || lower(substr(hex(contributors.id),1,12))
  WHEN (SELECT COUNT(*) FROM contributors other WHERE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(other.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(contributors.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-'))>1 THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(contributors.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(contributors.id),1,12))
  ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(contributors.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')
END
WHERE slug='';
UPDATE publishers
SET slug = CASE
  WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(publishers.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'publisher-' || lower(substr(hex(publishers.id),1,12))
  WHEN (SELECT COUNT(*) FROM publishers other WHERE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(other.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(publishers.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-'))>1 THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(publishers.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(publishers.id),1,12))
  ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(publishers.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')
END
WHERE slug='';
UPDATE imprints
SET slug = CASE
  WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(imprints.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'imprint-' || lower(substr(hex(imprints.id),1,12))
  WHEN (SELECT COUNT(*) FROM imprints other WHERE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(other.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(imprints.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-'))>1 THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(imprints.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(imprints.id),1,12))
  ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(imprints.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')
END
WHERE slug='';
UPDATE series
SET slug = CASE
  WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(series.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'series-' || lower(substr(hex(series.id),1,12))
  WHEN (SELECT COUNT(*) FROM series other WHERE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(other.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(series.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-'))>1 THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(series.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(series.id),1,12))
  ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(series.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')
END
WHERE slug='';

CREATE UNIQUE INDEX idx_contributors_slug ON contributors(slug) WHERE slug<>'';
CREATE UNIQUE INDEX idx_publishers_slug ON publishers(slug) WHERE slug<>'';
CREATE UNIQUE INDEX idx_imprints_slug ON imprints(slug) WHERE slug<>'';
CREATE UNIQUE INDEX idx_series_slug ON series(slug) WHERE slug<>'';
CREATE INDEX idx_series_memberships_discovery ON series_memberships(series_id,relationship,reading_order,display_order,position);

-- Stable, redirect-friendly public slugs. Old canonical slugs remain aliases if a curator changes a slug.
CREATE TABLE catalog_entity_slugs (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('author','publisher','imprint','series')),
  entity_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_type,slug)
);
CREATE INDEX idx_catalog_entity_slugs_entity ON catalog_entity_slugs(entity_type,entity_id,canonical DESC);
CREATE UNIQUE INDEX idx_catalog_entity_slugs_one_canonical ON catalog_entity_slugs(entity_type,entity_id) WHERE canonical=1;
INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) SELECT 'author',id,slug,1,created_at FROM contributors WHERE slug<>'';
INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) SELECT 'publisher',id,slug,1,created_at FROM publishers WHERE slug<>'';
INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) SELECT 'imprint',id,slug,1,created_at FROM imprints WHERE slug<>'';
INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) SELECT 'series',id,slug,1,created_at FROM series WHERE slug<>'';

CREATE TRIGGER trg_contributors_auto_slug AFTER INSERT ON contributors
WHEN NEW.slug=''
BEGIN
  UPDATE contributors SET slug=CASE WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'author-' || lower(substr(hex(NEW.id),1,12)) WHEN EXISTS(SELECT 1 FROM contributors x WHERE x.id<>NEW.id AND x.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) OR EXISTS(SELECT 1 FROM catalog_entity_slugs a WHERE a.entity_type='author' AND a.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(NEW.id),1,12)) ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') END WHERE id=NEW.id;
  INSERT OR IGNORE INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at)
  SELECT 'author',id,slug,1,created_at FROM contributors WHERE id=NEW.id AND slug<>'';
END;
CREATE TRIGGER trg_contributors_register_slug AFTER INSERT ON contributors
WHEN NEW.slug<>''
BEGIN
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('author',NEW.id,NEW.slug,1,NEW.created_at);
END;
CREATE TRIGGER trg_contributors_slug_change AFTER UPDATE OF slug ON contributors
WHEN NEW.slug<>OLD.slug AND NEW.slug<>''
BEGIN
  UPDATE catalog_entity_slugs SET canonical=0 WHERE entity_type='author' AND entity_id=NEW.id AND canonical=1;
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('author',NEW.id,NEW.slug,1,COALESCE(NEW.updated_at,NEW.created_at));
END;

CREATE TRIGGER trg_publishers_auto_slug AFTER INSERT ON publishers
WHEN NEW.slug=''
BEGIN
  UPDATE publishers SET slug=CASE WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'publisher-' || lower(substr(hex(NEW.id),1,12)) WHEN EXISTS(SELECT 1 FROM publishers x WHERE x.id<>NEW.id AND x.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) OR EXISTS(SELECT 1 FROM catalog_entity_slugs a WHERE a.entity_type='publisher' AND a.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(NEW.id),1,12)) ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') END WHERE id=NEW.id;
  INSERT OR IGNORE INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at)
  SELECT 'publisher',id,slug,1,created_at FROM publishers WHERE id=NEW.id AND slug<>'';
END;
CREATE TRIGGER trg_publishers_register_slug AFTER INSERT ON publishers
WHEN NEW.slug<>''
BEGIN
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('publisher',NEW.id,NEW.slug,1,NEW.created_at);
END;
CREATE TRIGGER trg_publishers_slug_change AFTER UPDATE OF slug ON publishers
WHEN NEW.slug<>OLD.slug AND NEW.slug<>''
BEGIN
  UPDATE catalog_entity_slugs SET canonical=0 WHERE entity_type='publisher' AND entity_id=NEW.id AND canonical=1;
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('publisher',NEW.id,NEW.slug,1,COALESCE(NEW.updated_at,NEW.created_at));
END;

CREATE TRIGGER trg_imprints_auto_slug AFTER INSERT ON imprints
WHEN NEW.slug=''
BEGIN
  UPDATE imprints SET slug=CASE WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'imprint-' || lower(substr(hex(NEW.id),1,12)) WHEN EXISTS(SELECT 1 FROM imprints x WHERE x.id<>NEW.id AND x.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) OR EXISTS(SELECT 1 FROM catalog_entity_slugs a WHERE a.entity_type='imprint' AND a.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(NEW.id),1,12)) ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') END WHERE id=NEW.id;
  INSERT OR IGNORE INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at)
  SELECT 'imprint',id,slug,1,created_at FROM imprints WHERE id=NEW.id AND slug<>'';
END;
CREATE TRIGGER trg_imprints_register_slug AFTER INSERT ON imprints
WHEN NEW.slug<>''
BEGIN
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('imprint',NEW.id,NEW.slug,1,NEW.created_at);
END;
CREATE TRIGGER trg_imprints_slug_change AFTER UPDATE OF slug ON imprints
WHEN NEW.slug<>OLD.slug AND NEW.slug<>''
BEGIN
  UPDATE catalog_entity_slugs SET canonical=0 WHERE entity_type='imprint' AND entity_id=NEW.id AND canonical=1;
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('imprint',NEW.id,NEW.slug,1,COALESCE(NEW.updated_at,NEW.created_at));
END;

CREATE TRIGGER trg_series_auto_slug AFTER INSERT ON series
WHEN NEW.slug=''
BEGIN
  UPDATE series SET slug=CASE WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'series-' || lower(substr(hex(NEW.id),1,12)) WHEN EXISTS(SELECT 1 FROM series x WHERE x.id<>NEW.id AND x.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) OR EXISTS(SELECT 1 FROM catalog_entity_slugs a WHERE a.entity_type='series' AND a.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(NEW.id),1,12)) ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') END WHERE id=NEW.id;
  INSERT OR IGNORE INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at)
  SELECT 'series',id,slug,1,created_at FROM series WHERE id=NEW.id AND slug<>'';
END;
CREATE TRIGGER trg_series_register_slug AFTER INSERT ON series
WHEN NEW.slug<>''
BEGIN
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('series',NEW.id,NEW.slug,1,NEW.created_at);
END;
CREATE TRIGGER trg_series_slug_change AFTER UPDATE OF slug ON series
WHEN NEW.slug<>OLD.slug AND NEW.slug<>''
BEGIN
  UPDATE catalog_entity_slugs SET canonical=0 WHERE entity_type='series' AND entity_id=NEW.id AND canonical=1;
  INSERT INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at) VALUES('series',NEW.id,NEW.slug,1,COALESCE(NEW.updated_at,NEW.created_at));
END;

-- Work-level relationships let edition pages point to related works without conflating a work with a product.
CREATE TABLE work_relationships (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  related_work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK(relationship IN ('adaptation','translation','revision','companion','related')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(work_id,related_work_id,relationship)
);
CREATE INDEX idx_work_relationships_related ON work_relationships(related_work_id,relationship,position);

-- Security/audit metadata only: never stores notes, highlights, EPUB bytes, or export archive contents.
CREATE TABLE personal_export_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  external_book_id TEXT NOT NULL,
  export_kind TEXT NOT NULL CHECK(export_kind IN ('reading-data','private-backup')),
  requested_at TEXT NOT NULL
);
CREATE INDEX idx_personal_export_events_user_time ON personal_export_events(user_id,requested_at DESC);
