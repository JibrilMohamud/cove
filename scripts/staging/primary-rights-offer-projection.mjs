/**
 * PRIVATE SYNTHETIC D1 CAPACITY PROBE, NOT a storefront read API.
 *
 * One current primary-D1 statement verifies the deny-first live retail
 * availability view, active market and current retail offer. Cached text,
 * covers or contributors must never authorize book disclosure or purchase.
 * The normal production legal owner/checkout still performs independent checks.
 */
export const CURRENT_RIGHTS_OFFER_SQL = `
WITH ranked AS MATERIALIZED (
  SELECT d.product_id,d.fore_bestseller_score sort_score,d.external_book_id sort_source
  FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
  ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
  LIMIT 96
)
SELECT
  p.id product_id,
  p.public_id product_public_id,
  e.id edition_id,
  p.source_name source_name,
  e.release_status release_status,
  (SELECT json_object('type',o.offer_type,'currency',o.currency,'amountMinor',o.amount_minor)
   FROM offers o
   WHERE o.product_id=p.id AND o.sales_channel='retail' AND o.active=1
     AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
     AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))
   ORDER BY o.created_at DESC LIMIT 1) offer_json
FROM ranked wanted
CROSS JOIN catalog_search_documents d ON d.product_id=wanted.product_id
CROSS JOIN products p ON p.id=d.product_id
CROSS JOIN editions e ON e.id=p.edition_id
WHERE p.storefront_status='active'
  AND p.source_name<>'upload'
  AND d.suppressed=0
  AND e.release_status IN ('available','preorder')
  AND d.availability=?
  AND EXISTS (
    SELECT 1 FROM retail_product_availability_rows rpa
    WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?)
  )
  AND d.currency=?
  AND EXISTS (
    SELECT 1 FROM storefront_markets sm
    WHERE sm.country_code=upper(?) AND sm.market_status='active'
      AND upper(sm.default_currency)=upper(?)
  )
ORDER BY wanted.sort_score DESC,wanted.sort_source ASC,wanted.product_id ASC
LIMIT ?`;

const SYNTHETIC_ID = /^perf-synth-[a-zA-Z0-9_-]{1,120}$/;
export function validateCurrentRightsOfferWitness(rows, limit = 24, currency = "USD") {
  if (!Array.isArray(rows) || rows.length !== limit + 1) return null;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row.product_id !== "string" ||
      !SYNTHETIC_ID.test(row.product_id) ||
      seen.has(row.product_id) ||
      typeof row.edition_id !== "string" ||
      !row.edition_id ||
      row.source_name === "upload" ||
      !["available", "preorder"].includes(row.release_status)
    ) return null;
    seen.add(row.product_id);
    let offer = null;
    if (row.offer_json !== null && row.offer_json !== undefined) {
      try {
        const value = JSON.parse(row.offer_json);
        if (
          !value ||
          typeof value.type !== "string" ||
          value.type.length > 60 ||
          value.currency !== currency ||
          !Number.isSafeInteger(value.amountMinor) ||
          value.amountMinor < 0
        ) return null;
        offer = { type: value.type, currency: value.currency, amountMinor: value.amountMinor };
      } catch {
        return null;
      }
    }
    // Null offer means no current offer, never automatically a free sale.
    out.push({
      productId: row.product_id,
      editionId: row.edition_id,
      publicProductId: String(row.product_public_id || ""),
      releaseStatus: row.release_status,
      offer,
    });
  }
  return out.slice(0, limit);
}
