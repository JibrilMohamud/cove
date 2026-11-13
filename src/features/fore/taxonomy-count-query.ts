/**
 * These plans calculate taxonomy DISPLAY counts on cache misses from
 * live rights; their results may subsequently be cached as presentation-only
 * numbers. No cached count authorizes a book, sale, download or reading,
 * and there is no cached eligibility or cross-request Worker I/O.
 *
 * The runtime seeds distinct taxonomy editions before consulting the
 * UNCHANGED live retail availability view. The previous full-catalog plan
 * remains available for parity tests of rights, locale and counts.
 * The count is exact because products.id and (edition_id,node_id) are unique.
 */
export type TaxonomyCountPlan = { sql: string; binds: (string | number)[] };
const eligibleWhere = `
  WHERE p.storefront_status='active' AND p.source_name<>'upload'
    AND e.release_status IN ('available','preorder')
    AND (?='' OR EXISTS(
      SELECT 1 FROM edition_languages el
      WHERE el.edition_id=e.id AND lower(el.language_code)=lower(?)
    ))
    AND EXISTS(
      SELECT 1 FROM retail_product_availability rpa
      WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?)
    )`;

/** Legacy dense full-catalog scan retained only for exact parity tests. */
export function legacyDenseTaxonomyCountPlan(
  territory: string,
  language: string,
): TaxonomyCountPlan {
  const normal = `WITH eligible AS MATERIALIZED (
    SELECT p.id,p.edition_id FROM products p
    JOIN editions e ON e.id=p.edition_id
    ${eligibleWhere}
  )
  SELECT et.taxonomy_node_id node_id,COUNT(*) product_count
  FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
  GROUP BY et.taxonomy_node_id`;
  return { sql: normal, binds: [language, language, territory] };
}

/**
 * Taxonomy counts are presentation-only. Start from the distinct editions
 * actually assigned to a node, not all catalog products or all live grants;
 * keep the complete current retail availability view and territory/locale
 * restrictions on EACH candidate. This avoids a giant primary-D1 rights scan
 * for books with no taxonomy membership and handles empty taxonomies cheaply.
 * The legacy sparse argument is retained for the audited caller interface.
 */
export function taxonomyCountPlan(
  territory: string,
  language: string,
  _sparse: boolean,
): TaxonomyCountPlan {
  const seeded = `WITH taxonomy_seed AS MATERIALIZED (
    SELECT DISTINCT et.edition_id
    FROM edition_taxonomy_nodes et
  ), eligible AS MATERIALIZED (
    SELECT p.id,p.edition_id
    FROM taxonomy_seed seed
    CROSS JOIN products p ON p.edition_id=seed.edition_id
    CROSS JOIN editions e ON e.id=p.edition_id
    ${eligibleWhere.replace("retail_product_availability rpa", "retail_product_availability_rows rpa")}
  )
  SELECT et.taxonomy_node_id node_id,COUNT(*) product_count
  FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
  GROUP BY et.taxonomy_node_id`;
  return { sql: seeded, binds: [language, language, territory] };
}

export const taxonomySparseRightsProbe = `
  SELECT COUNT(*) grant_count FROM (
    SELECT 1 FROM rights_grant_territories rgt
    JOIN rights_grants g ON g.id=rgt.grant_id
    WHERE rgt.territory_code=upper(?)
      AND g.sales_channel='retail' AND g.status='active'
    LIMIT 1001
  )`;
