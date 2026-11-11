/** Exactly one live primary-D1 snapshot for two secondary availability flags.
 *
 * The permissive, product-scoped candidate gate cannot grant a right:
 * every qualifying row in product_channel_availability must originate from
 * an ACTIVE, format-matched rights_grants row covering the product edition,
 * in either the exact secondary sales channel or an explicitly opted-in
 * retail grant. If no such row exists, both channel flags are necessarily
 * false. If one does, the original comprehensive SQL rights view remains
 * the *only* authority for allows, denies, contracts, territory, language,
 * time and DRM.
 *
 * SQLite CASE is lazy: it never executes the heavy view's THEN branch when
 * potential is empty. MATERIALIZED means one indexed negative gate per
 * query. There is no stale cache, independent round trip or new rights
 * interpretation. This must stay on the authoritative primary D1 binding.
 */
export const productChannelFlagsSql = `WITH potential AS MATERIALIZED (
  SELECT 1 present
  FROM products p
  JOIN rights_grants rg INDEXED BY idx_rights_grant_live_lookup
    ON rg.edition_id=p.edition_id
  WHERE p.id=? AND rg.status='active' AND lower(rg.format)=lower(p.format)
    AND (
      rg.sales_channel IN ('subscription','library')
      OR (rg.sales_channel='retail'
        AND (rg.subscription_permitted=1 OR rg.library_permitted=1))
    )
  LIMIT 1
)
SELECT
  CASE WHEN EXISTS(SELECT 1 FROM potential) THEN
    EXISTS(SELECT 1 FROM product_channel_availability
      WHERE product_id=? AND territory_code=upper(?) AND sales_channel='subscription')
    ELSE 0 END subscription_eligible,
  CASE WHEN EXISTS(SELECT 1 FROM potential) THEN
    EXISTS(SELECT 1 FROM product_channel_availability
      WHERE product_id=? AND territory_code=upper(?) AND sales_channel='library')
    ELSE 0 END library_eligible`;
