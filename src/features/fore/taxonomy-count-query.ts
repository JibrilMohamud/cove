/**
 * Taxonomy counts are DISPLAY METADATA, but remain strictly live-rights
 * authoritative, even for sparse markets and grant revocations. No cached
 * eligibility, snapshots, materialized authorization or cross-request I/O.
 *
 * With <=1000 potential active retail territorial grants, seed only those
 * products before executing the UNCHANGED retail availability view. At
 * >1000 grants, the primary-D1 optimizer uses the established catalog scan.
 * The count is exact because products.id and the (edition_id,node_id) pair
 * in edition_taxonomy_nodes are primary keys.
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

export function taxonomyCountPlan(
  territory: string,
  language: string,
  sparse: boolean,
): TaxonomyCountPlan {
  const normal = `WITH eligible AS MATERIALIZED (
    SELECT p.id,p.edition_id FROM products p
    JOIN editions e ON e.id=p.edition_id
    ${eligibleWhere}
  )
  SELECT et.taxonomy_node_id node_id,COUNT(*) product_count
  FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.edition_id
  GROUP BY et.taxonomy_node_id`;
  if (!sparse) return { sql: normal, binds: [language, language, territory] };

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
    ${eligibleWhere}
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
