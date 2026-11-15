/* eslint-disable prettier/prettier -- A positive commercial authority lease must never outlive source legal transitions. */
import type { CatalogDB } from "../features/fore/catalog-model.server";

const PRODUCT = /^prd_[a-zA-Z0-9_-]{3,120}$/;
const MAX_RIGHTS_LEASE_MS = 30 * 60_000;
const FRESH_EVALUATION_MS = 2000;
const CLOCK_BOUNDARY_MARGIN_MS = 2500;

/**
 * This is a publication-time PRIMARY-D1 read, NEVER a request-time
 * authorization check. Every canonical mutation writer must still issue a
 * deny-first owner fence and the owner must atomically compare its epoch.
 *
 * D1's production SQLite compound-SELECT budget is restrictive. Use TWO
 * small, bounded, indexed reads with four and two UNION terms respectively,
 * rather than a dozen-term UNION that fails to compile on live primary D1.
 * json_each(json_array(start,end)) folds both time columns into one stream.
 * NULL date fields are ignored; a malformed NON-NULL date fails closed.
 */
export const CANONICAL_PAID_NEXT_BOUNDARY_SQL = `WITH target AS MATERIALIZED (
  SELECT p.id product_id,p.edition_id FROM products p WHERE p.id=?
), times(at) AS MATERIALIZED (
  SELECT dates.value FROM rights_grants rg
    JOIN target t ON t.edition_id=rg.edition_id
    CROSS JOIN json_each(json_array(rg.starts_at,rg.ends_at)) dates
  UNION ALL SELECT dates.value FROM rights_contracts rc
    JOIN rights_grants rg ON rg.contract_id=rc.id
    JOIN target t ON t.edition_id=rg.edition_id
    CROSS JOIN json_each(json_array(rc.effective_from,rc.effective_to)) dates
  UNION ALL SELECT dates.value FROM rights_contract_versions cv
    JOIN rights_grants rg ON rg.contract_id=cv.contract_id
    JOIN target t ON t.edition_id=rg.edition_id
    CROSS JOIN json_each(json_array(cv.effective_from,cv.effective_to)) dates
  UNION ALL SELECT dates.value FROM rights_contract_languages cl
    JOIN rights_grants rg ON rg.contract_id=cl.contract_id
    JOIN target t ON t.edition_id=rg.edition_id
    CROSS JOIN json_each(json_array(cl.starts_at,cl.ends_at)) dates
) SELECT
  (SELECT COUNT(*) FROM target) product_count,
  strftime('%Y-%m-%dT%H:%M:%fZ','now') primary_now,
  MIN(CASE WHEN julianday(at)>julianday('now')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ',at) END) next_transition,
  SUM(CASE WHEN at IS NOT NULL AND julianday(at) IS NULL THEN 1 ELSE 0 END) invalid_times
  FROM times`;

export const CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL = `WITH target AS MATERIALIZED (
  SELECT p.id product_id,p.edition_id FROM products p WHERE p.id=?
), times(at) AS MATERIALIZED (
  SELECT dates.value FROM offers o JOIN target t ON t.product_id=o.product_id
    CROSS JOIN json_each(json_array(o.starts_at,o.ends_at)) dates
  UNION ALL SELECT dates.value FROM editions e JOIN target t ON t.edition_id=e.id
    CROSS JOIN json_each(json_array(e.release_date,e.preorder_date)) dates
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
 * resolver invocation; it must never come from a customer or R2/KV bytes.
 *
 * The PRIMARY D1 clock rejects stale/future decisions and bounds ALL known
 * future positives and negatives, even if the chosen grant remains active.
 * Owner SQLite's epoch, subject-denial and evidence CAS remain final.
 */
export async function canonicalCommercialLeaseUntil(
  db:CatalogDB,productId:string,evaluatedAtMs:number
):Promise<string>{
  if(!PRODUCT.test(productId)||productId.startsWith("prd_gutenberg_")||
     !Number.isSafeInteger(evaluatedAtMs)||
     Math.abs(Date.now()-evaluatedAtMs)>FRESH_EVALUATION_MS)
    throw Error("canonical_lease_unfresh_evaluation");

  const rows=await Promise.all([
    db.prepare(CANONICAL_PAID_NEXT_BOUNDARY_SQL)
      .bind(productId).first<BoundaryRow>(),
    db.prepare(CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL)
      .bind(productId).first<BoundaryRow>(),
  ]);
  const now=Date.now();
  const primaryTimes=rows.map(row=>Date.parse(row?.primary_now||""));
  if(rows.some((row,i)=>
       !row||row.product_count!==1||
       !Number.isFinite(primaryTimes[i])||
       row.invalid_times===null||!Number.isSafeInteger(row.invalid_times)||
       row.invalid_times!==0||
       Math.abs(primaryTimes[i]-now)>FRESH_EVALUATION_MS||
       Math.abs(primaryTimes[i]-evaluatedAtMs)>FRESH_EVALUATION_MS))
    throw Error("canonical_lease_primary_unverified");

  // Use the oldest verified primary timestamp and the EARLIEST boundary.
  // Cross-query inconsistency cannot extend the lease; source withdrawals
  // still require their separate owner-first fences before any D1 mutation.
  const earliest=rows.map(row=>row!.next_transition===null
    ? Number.POSITIVE_INFINITY:Date.parse(row!.next_transition!));
  if(earliest.some(value=>Number.isNaN(value)))
    throw Error("canonical_lease_invalid_transition");
  const expires=Math.min(
    Math.min(...primaryTimes)+MAX_RIGHTS_LEASE_MS,
    Math.min(...earliest)-CLOCK_BOUNDARY_MARGIN_MS,
  );
  if(!(expires>now+50))
    throw Error("canonical_lease_transition_imminent");
  return new Date(expires).toISOString();
}
