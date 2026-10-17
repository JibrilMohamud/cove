-- Keep the public DISTINCT contract while allowing EXISTS membership predicates
-- to flatten through the same live legal rules without a catalog-wide coroutine.
DROP VIEW retail_product_availability;
CREATE VIEW retail_product_availability_rows AS
WITH effective_grants AS NOT MATERIALIZED (
 SELECT rg.*, 'retail' AS effective_sales_channel FROM rights_grants rg WHERE rg.sales_channel='retail'
), legally_scoped AS NOT MATERIALIZED (
  SELECT p.id AS product_id,p.edition_id,p.format AS product_format,e.drm_status AS edition_drm,
    rg.*,rgt.territory_code AS effective_territory_code
  FROM products p
  JOIN editions e ON e.id=p.edition_id
  JOIN effective_grants rg ON rg.edition_id=e.id AND lower(rg.format)=lower(p.format)
  JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id
  WHERE p.storefront_status='active'
    AND rg.status='active'
    AND (rg.starts_at IS NULL OR rg.starts_at<=datetime('now'))
    AND (rg.ends_at IS NULL OR rg.ends_at>datetime('now'))
    AND (
      rg.contract_id IS NULL OR EXISTS(
        SELECT 1 FROM rights_contracts rc
        WHERE rc.id=rg.contract_id AND rc.status='active'
          AND (rc.effective_from IS NULL OR rc.effective_from<=datetime('now'))
          AND (rc.effective_to IS NULL OR rc.effective_to>datetime('now'))
          AND NOT EXISTS(
            SELECT 1 FROM rights_contract_languages deny
            JOIN edition_languages el ON el.edition_id=e.id AND el.kind='content' AND lower(el.language_code)=lower(deny.language_code)
            WHERE deny.contract_id=rc.id AND deny.decision='deny'
              AND (deny.format IS NULL OR lower(deny.format)=lower(p.format))
              AND (deny.sales_channel IS NULL OR deny.sales_channel=rg.effective_sales_channel)
              AND (deny.starts_at IS NULL OR deny.starts_at<=datetime('now')) AND (deny.ends_at IS NULL OR deny.ends_at>datetime('now'))
          )
          AND (
            NOT EXISTS(
              SELECT 1 FROM rights_contract_languages allow
              WHERE allow.contract_id=rc.id AND allow.decision='allow'
                AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
            )
            OR (rc.language_match_mode='any' AND EXISTS(
              SELECT 1 FROM rights_contract_languages allow
              JOIN edition_languages el ON el.edition_id=e.id AND el.kind='content' AND lower(el.language_code)=lower(allow.language_code)
              WHERE allow.contract_id=rc.id AND allow.decision='allow'
                AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
            ))
            OR (rc.language_match_mode='all' AND EXISTS(SELECT 1 FROM edition_languages el WHERE el.edition_id=e.id AND el.kind='content')
              AND NOT EXISTS(
                SELECT 1 FROM edition_languages el
                WHERE el.edition_id=e.id AND el.kind='content' AND NOT EXISTS(
                  SELECT 1 FROM rights_contract_languages allow
                  WHERE allow.contract_id=rc.id AND allow.decision='allow' AND lower(allow.language_code)=lower(el.language_code)
                    AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                    AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                    AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
                )
              )
            )
          )
      )
    )
)
SELECT
  allow.product_id,allow.edition_id,upper(allow.effective_territory_code) AS territory_code,
  allow.product_format AS format,allow.id AS rights_grant_id
FROM legally_scoped allow
WHERE allow.decision='allow'
  AND NOT EXISTS(
    SELECT 1 FROM legally_scoped deny
    WHERE deny.product_id=allow.product_id
      AND upper(deny.effective_territory_code)=upper(allow.effective_territory_code)
      AND deny.effective_sales_channel=allow.effective_sales_channel
      AND deny.decision='deny'
  )
  AND (
    lower(COALESCE(allow.drm_requirement,'none')) IN ('','none','optional','any')
    OR (lower(allow.drm_requirement) IN ('none-only','drm-free') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('','none','drm-free'))
    OR (lower(allow.drm_requirement) IN ('required','drm','encrypted','any-drm') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) NOT IN ('','none','drm-free'))
    OR (lower(allow.drm_requirement) IN ('watermark','social-drm') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('watermark','social-drm'))
    OR (lower(allow.drm_requirement) IN ('adobe','adobe-acs','acs4') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('adobe','adobe-acs','acs4'))
    OR (lower(allow.drm_requirement) IN ('lcp','readium-lcp') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('lcp','readium-lcp'))
    OR lower(allow.drm_requirement)=lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none'))
  );
CREATE VIEW retail_product_availability AS
SELECT DISTINCT product_id,edition_id,territory_code,format,rights_grant_id
FROM retail_product_availability_rows;
