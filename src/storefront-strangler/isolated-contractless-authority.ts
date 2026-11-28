import type {
  CatalogDB,
  PrimaryStorefrontAuthorityRow,
} from "../features/fore/catalog-model.server";

/** A conservative subset of the frozen snapshot's retail membership view.
 * Any deny, contract, or nontrivial DRM grant forces canonical evaluation.
 * Every predicate and offer is read in this fresh primary statement. This
 * is neither a cached grant nor a production legal-authority enrollment. */
export async function authorizeIsolatedContractlessPrefix(
  db: CatalogDB,
  ids: string[],
  territory: string,
  currency: string,
) {
  if (
    !/^[A-Z]{2}$/.test(territory) ||
    !/^[A-Z]{3}$/.test(currency) ||
    !ids.length ||
    ids.length > 25 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^prd_gutenberg_[1-9][0-9]{0,8}$/.test(id))
  )
    throw Error("Invalid isolated authorization prefix");
  const result = await db
    .prepare(
      `WITH market(currency) AS MATERIALIZED (
    SELECT COALESCE(
      (SELECT default_currency FROM storefront_markets WHERE country_code=? AND market_status='active'),
      (SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active'))
  ), candidates AS MATERIALIZED (
    SELECT value product_id,CAST(key AS INTEGER) position FROM json_each(?)
  ), authorized AS MATERIALIZED (
    SELECT p.id product_id,p.public_id product_public_id,p.edition_id,
      e.public_id edition_public_id,c.position,d.currency
    FROM candidates c CROSS JOIN products p ON p.id=c.product_id
    JOIN editions e ON e.id=p.edition_id
    JOIN catalog_search_documents d ON d.product_id=p.id
    WHERE p.storefront_status='active' AND p.source_name='gutenberg'
      AND e.release_status IN ('available','preorder')
      AND d.suppressed=0 AND d.availability='available'
      AND d.currency=? AND ?=(SELECT currency FROM market)
      AND NOT EXISTS (
        SELECT 1 FROM rights_grants complex
        WHERE complex.edition_id=e.id AND complex.sales_channel='retail'
          AND lower(complex.format)=lower(p.format)
          AND (complex.decision<>'allow' OR complex.contract_id IS NOT NULL
            OR lower(COALESCE(complex.drm_requirement,'none')) NOT IN ('','none','optional','any'))
      )
      AND EXISTS (
        SELECT 1 FROM rights_grants rg JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id
        WHERE rg.edition_id=e.id AND rg.sales_channel='retail'
          AND lower(rg.format)=lower(p.format) AND rg.decision='allow' AND rg.status='active'
          AND rg.contract_id IS NULL
          AND lower(COALESCE(rg.drm_requirement,'none')) IN ('','none','optional','any')
          AND (rg.starts_at IS NULL OR rg.starts_at<=datetime('now'))
          AND (rg.ends_at IS NULL OR rg.ends_at>datetime('now'))
          AND upper(rgt.territory_code)=?
      )
    ORDER BY c.position LIMIT 25
  ) SELECT a.product_id,a.product_public_id,a.edition_id,a.edition_public_id,
    (SELECT json_object('type',o.offer_type,'currency',o.currency,'amountMinor',o.amount_minor)
      FROM offers o WHERE o.product_id=a.product_id AND o.sales_channel='retail'
        AND o.currency=a.currency AND o.active=1
        AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
        AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))
      ORDER BY o.created_at DESC LIMIT 1) offer_json
    FROM authorized a ORDER BY a.position`,
    )
    .bind(territory, JSON.stringify(ids), currency, currency, territory)
    .all<PrimaryStorefrontAuthorityRow>();
  return result.results;
}
