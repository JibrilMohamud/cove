-- Preserve author URL/alias behavior while using the existing partial index.
-- No stored data is rewritten. Local validation only; not applied remotely.
DROP TRIGGER trg_contributors_auto_slug;
CREATE TRIGGER trg_contributors_auto_slug AFTER INSERT ON contributors
WHEN NEW.slug=''
BEGIN
  UPDATE contributors SET slug=CASE WHEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')='' THEN 'author-' || lower(substr(hex(NEW.id),1,12)) WHEN EXISTS(SELECT 1 FROM contributors x WHERE x.id<>NEW.id AND x.slug<>'' AND x.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) OR EXISTS(SELECT 1 FROM catalog_entity_slugs a WHERE a.entity_type='author' AND a.slug=replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-')) THEN replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') || '-' || lower(substr(hex(NEW.id),1,12)) ELSE replace(replace(lower(trim(replace(replace(replace(replace(replace(replace(NEW.name, ' ', '-'), '.', ''), ',', ''), ':', ''), '/', '-'), '&', 'and'), '-')), '--', '-'), '--', '-') END WHERE id=NEW.id;
  INSERT OR IGNORE INTO catalog_entity_slugs(entity_type,entity_id,slug,canonical,created_at)
  SELECT 'author',id,slug,1,created_at FROM contributors WHERE id=NEW.id AND slug<>'';
END;
