/**
 * These plans calculate taxonomy DISPLAY counts on cache misses from
 * live rights; their results may subsequently be cached as presentation-only
 * numbers. No cached count authorizes a book, sale, download or reading,
 * and there is no cached eligibility or cross-request Worker I/O.
 *
 * The runtime always seeds indexed territorial retail grants before executing
 * the UNCHANGED live retail availability view, even for dense markets. The
 * previous full-catalog plan remains available only for parity testing.
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


/**
 * The runtime always starts from indexed, active territory grants and then
 * applies the SAME live retail availability predicate. The old >1,000-grant
 * fallback scanned the full product catalog and read 1.7M+ rows on primary D1.
 * Keep the legacy sparse argument to avoid touching reviewed writer modules.
 */
export function taxonomyCountPlan(
  territory: string,
  language: string,
  _sparse: boolean,
): TaxonomyCountPlan {
  const seeded = `WITH territory_seed AS MATERIALIZED (
    SELECT DISTINCT seed_product.id,seed_product.edition_id
    FROM rights_grant_territories rgt
    JOIN rights_grants g ON g.id=rgt.grant_id
      AND g.sales_channel='retail' AND g.status='active'
    JOIN products seed_product ON seed_product.edition_id=g.edition_id
    WHERE rgt.territory_code=upper(?)
  ), eligible AS MATERIALIZED (
    SELECT p.id,p.edition_id
    FROM territory_seed seed
    CROSS JOIN products p ON p.id=seed.id
    CROSS JOIN editions e ON e.id=p.edition_id
    ${eligibleWhere.replace("retail_product_availability rpa", "retail_product_availability_rows rpa")}
  )
  SELECT et.taxonomy_node_id node_id,COUNT(*) product_count
  FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
  GROUP BY et.taxonomy_node_id`;
  return { sql: seeded, binds: [territory, language, language, territory] };
}

export const taxonomySparseRightsProbe = `
  SELECT COUNT(*) grant_count FROM (
    SELECT 1 FROM rights_grant_territories rgt
    JOIN rights_grants g ON g.id=rgt.grant_id
    WHERE rgt.territory_code=upper(?)
      AND g.sales_channel='retail' AND g.status='active'
    LIMIT 1001
  )`;
