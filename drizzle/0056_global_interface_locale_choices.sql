-- A reader's interface language is not their licensed-book territory.
-- Keep default country, billing, rights and tax decisions unchanged; provide
-- the five fully activated Cove UI languages as display-language choices in
-- every active storefront market. Market administrators retain their existing
-- first-choice locales and disabled mappings are not overridden.
INSERT OR IGNORE INTO storefront_market_locales(country_code,locale,priority,active)
SELECT m.country_code,l.locale,100,1
FROM storefront_markets m CROSS JOIN storefront_locales l
WHERE m.market_status='active'
  AND l.status='active'
  AND l.locale IN ('en-US','es-ES','fr-FR','de-DE','ar-SA')
  AND EXISTS (
    SELECT 1 FROM ui_translation_bundles b
    WHERE b.locale=l.locale AND b.status='active'
  );
