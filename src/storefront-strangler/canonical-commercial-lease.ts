/* eslint-disable prettier/prettier -- A positive commercial authority lease must never outlive source legal transitions. */
import type { CatalogDB } from "../features/fore/catalog-model.server";

const PRODUCT = /^prd_[a-zA-Z0-9_-]{3,120}$/;
const MAX_RIGHTS_LEASE_MS = 30 * 60_000;
const FRESH_EVALUATION_MS = 2000;
const CLOCK_BOUNDARY_MARGIN_MS = 2500;

/**
 * This is a publication-time PRIMARY-D1 query, NEVER a request-time
 * authorization check. A legal owner must already hold the deny-first
 * publication fence and must still compare its epoch when committing.
 *
 * Include every dated positive AND negative legal source: a future deny
 * grant, future restrictive contract/version/language entry, or competing
 * offer must expire a positive proof before the scheduled change. No
 * positive can be published when a source date is not parseable.
 */
export const CANONICAL_PAID_NEXT_BOUNDARY_SQL = `WITH target AS MATERIALIZED (
  SELECT p.id product_id,p.edition_id FROM products p WHERE p.id=?
), times(at) AS (
  SELECT rg.starts_at FROM rights_grants rg JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT rg.ends_at FROM rights_grants rg JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT rc.effective_from FROM rights_contracts rc JOIN rights_grants rg ON rg.contract_id=rc.id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT rc.effective_to FROM rights_contracts rc JOIN rights_grants rg ON rg.contract_id=rc.id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT cv.effective_from FROM rights_contract_versions cv JOIN rights_grants rg ON rg.contract_id=cv.contract_id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT cv.effective_to FROM rights_contract_versions cv JOIN rights_grants rg ON rg.contract_id=cv.contract_id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT cl.starts_at FROM rights_contract_languages cl JOIN rights_grants rg ON rg.contract_id=cl.contract_id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT cl.ends_at FROM rights_contract_languages cl JOIN rights_grants rg ON rg.contract_id=cl.contract_id JOIN target t ON t.edition_id=rg.edition_id
  UNION ALL SELECT o.starts_at FROM offers o JOIN target t ON t.product_id=o.product_id
  UNION ALL SELECT o.ends_at FROM offers o JOIN target t ON t.product_id=o.product_id
  UNION ALL SELECT e.release_date FROM editions e JOIN target t ON t.edition_id=e.id
  UNION ALL SELECT e.preorder_date FROM editions e JOIN target t ON t.edition_id=e.id
) SELECT
  (SELECT COUNT(*) FROM target) product_count,
  strftime('%Y-%m-%dT%H:%M:%fZ','now') primary_now,
  MIN(CASE WHEN julianday(at)>julianday('now')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ',at) END) next_transition,
  SUM(CASE WHEN at IS NOT NULL AND julianday(at) IS NULL THEN 1 ELSE 0 END) invalid_times
  FROM times`;

type BoundaryRow = {
  product_count:number;
  primary_now:string;
  next_transition:string|null;
  invalid_times:number|null;
};

/**
 * Called ONLY after fresh resolveProductRights(persist:false) returns a
 * canonical positive. evaluatedAtMs is captured immediately BEFORE that
 * resolver invocation, never supplied by a user or a presentation cache.
 *
 * The primary D1 clock independently bounds staleness and any future
 * boundary (including negative changes); owner SQLite's epoch/denial CAS
 * remains the final authority on publication.
 */
export async function canonicalCommercialLeaseUntil(
  db:CatalogDB,productId:string,evaluatedAtMs:number
):Promise<string>{
  if(!PRODUCT.test(productId)||productId.startsWith("prd_gutenberg_")||
     !Number.isSafeInteger(evaluatedAtMs)||
     Math.abs(Date.now()-evaluatedAtMs)>FRESH_EVALUATION_MS)
    throw Error("canonical_lease_unfresh_evaluation");

  const row=await db.prepare(CANONICAL_PAID_NEXT_BOUNDARY_SQL)
    .bind(productId).first<BoundaryRow>();
  const now=Date.now();
  const primaryMs=Date.parse(row?.primary_now||"");
  if(!row||row.product_count!==1||
     !Number.isFinite(primaryMs)||
     row.invalid_times===null||!Number.isSafeInteger(row.invalid_times)||
     row.invalid_times!==0||
     Math.abs(primaryMs-now)>FRESH_EVALUATION_MS||
     Math.abs(primaryMs-evaluatedAtMs)>FRESH_EVALUATION_MS)
    throw Error("canonical_lease_primary_unverified");

  const boundary=row.next_transition===null
    ? Number.POSITIVE_INFINITY:Date.parse(row.next_transition);
  if(Number.isNaN(boundary))
    throw Error("canonical_lease_invalid_transition");
  const expires=Math.min(primaryMs+MAX_RIGHTS_LEASE_MS,
    boundary-CLOCK_BOUNDARY_MARGIN_MS);
  if(!(expires>now+50))
    throw Error("canonical_lease_transition_imminent");
  return new Date(expires).toISOString();
}
