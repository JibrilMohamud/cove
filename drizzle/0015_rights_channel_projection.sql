-- Unify retail, subscription, and library availability behind one fail-closed legal projection.
-- A channel is available only when an active grant authorizes the exact
-- edition + territory + format + channel at query time and the delivered asset satisfies DRM.

DROP VIEW IF EXISTS retail_product_availability;
DROP VIEW IF EXISTS product_channel_availability;

CREATE VIEW product_channel_availability AS
WITH effective_grants AS (
  SELECT rg.*, 'retail' AS effective_sales_channel
  FROM rights_grants rg
  WHERE rg.sales_channel='retail'

  UNION ALL

  SELECT rg.*, 'subscription' AS effective_sales_channel
  FROM rights_grants rg
  WHERE rg.sales_channel='subscription'
     OR (rg.sales_channel='retail' AND rg.subscription_permitted=1)

  UNION ALL

  SELECT rg.*, 'library' AS effective_sales_channel
  FROM rights_grants rg
  WHERE rg.sales_channel='library'
     OR (rg.sales_channel='retail' AND rg.library_permitted=1)
)
SELECT DISTINCT
  p.id AS product_id,
  p.edition_id,
  upper(rg.territory_code) AS territory_code,
  p.format,
  rg.effective_sales_channel AS sales_channel,
  rg.id AS rights_grant_id
FROM products p
JOIN editions e ON e.id=p.edition_id
JOIN effective_grants rg
  ON rg.edition_id=e.id
 AND lower(rg.format)=lower(p.format)
WHERE p.storefront_status='active'
  AND rg.decision='allow'
  AND rg.status='active'
  AND (rg.starts_at IS NULL OR rg.starts_at<=datetime('now'))
  AND (rg.ends_at IS NULL OR rg.ends_at>datetime('now'))
  AND NOT EXISTS (
    SELECT 1
    FROM effective_grants deny
    WHERE deny.edition_id=e.id
      AND upper(deny.territory_code)=upper(rg.territory_code)
      AND lower(deny.format)=lower(p.format)
      AND deny.effective_sales_channel=rg.effective_sales_channel
      AND deny.decision='deny'
      AND deny.status='active'
      AND (deny.starts_at IS NULL OR deny.starts_at<=datetime('now'))
      AND (deny.ends_at IS NULL OR deny.ends_at>datetime('now'))
  )
  AND (
    lower(COALESCE(rg.drm_requirement,'none')) IN ('','none','optional','any')
    OR (lower(rg.drm_requirement) IN ('none-only','drm-free') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('','none','drm-free'))
    OR (lower(rg.drm_requirement) IN ('required','drm','encrypted','any-drm') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) NOT IN ('','none','drm-free'))
    OR (lower(rg.drm_requirement) IN ('watermark','social-drm') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('watermark','social-drm'))
    OR (lower(rg.drm_requirement) IN ('adobe','adobe-acs','acs4') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('adobe','adobe-acs','acs4'))
    OR (lower(rg.drm_requirement) IN ('lcp','readium-lcp') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('lcp','readium-lcp'))
    OR lower(rg.drm_requirement)=lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none'))
  );

CREATE VIEW retail_product_availability AS
SELECT product_id,edition_id,territory_code,format,rights_grant_id
FROM product_channel_availability
WHERE sales_channel='retail';
