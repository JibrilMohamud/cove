// Strictly stage-only operator-grant fixture. The 50k synthetic records carry
// rights_grants.source='operator', not Gutenberg source/evidence. The existing
// capacity seed mislabels their products as Gutenberg and carries zero offers:
// after source-proof hardening the old benchmark rendered ZERO authorized books.
// This plan repairs ONLY 24 bounded QA records, and the run restores them.
import assert from "node:assert/strict";

export const REQUIRED_BOOK_CARDS = 24;
export function syntheticOperatorFixturePlan(productIds, runId) {
  assert.match(String(runId), /^[0-9]{5,20}$/);
  assert.ok(Array.isArray(productIds) && productIds.length >= REQUIRED_BOOK_CARDS);
  const ids=productIds.slice(0,REQUIRED_BOOK_CARDS);
  assert.equal(new Set(ids).size,REQUIRED_BOOK_CARDS);
  for (const id of ids) assert.match(id,/^perf-synth-[0-9]{6}$/);
  const list=ids.map(()=>"?").join(",");
  const params=[...ids];
  const prefix="cove-arch-qa-"+runId+"-";
  const validGrant=`EXISTS (
    SELECT 1 FROM retail_product_availability_rows rpa
    JOIN rights_grants rg ON rg.id=rpa.rights_grant_id
    WHERE rpa.product_id=p.id AND rpa.territory_code='US'
      AND rg.source='operator' AND rg.status='active'
      AND rg.decision='allow' AND rg.sales_channel='retail'
  )`;
  return {
    ids,
    offerPrefix:prefix,
    preflight:{
      sql:`SELECT COUNT(*) n FROM products p
        WHERE p.id IN (${list}) AND p.source_name='gutenberg'
          AND ${validGrant}`,params,
    },
    operatorize:{
      sql:`UPDATE products SET source_name='operator' WHERE id IN (${list})
        AND source_name='gutenberg'
        AND EXISTS (SELECT 1 FROM rights_grants rg
          WHERE rg.edition_id=products.edition_id AND rg.source='operator'
            AND rg.decision='allow' AND rg.status='active'
            AND rg.sales_channel='retail')`,params,
    },
    // Every synthetic card has an explicit time-unbounded FREE retail offer.
    issueOffers:ids.map(id=>({
        sql:`INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,
          active,created_at,updated_at,sales_channel)
          SELECT ?,p.id,'free','USD',0,1,datetime('now'),datetime('now'),'retail'
          FROM products p WHERE p.id=? AND p.source_name='operator'
            AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND o.active=1 AND o.sales_channel='retail')`,
        params:[prefix+id,id],
      })),
    verify:{
      sql:`SELECT COUNT(DISTINCT p.id) n FROM products p
        JOIN offers o ON o.product_id=p.id AND o.sales_channel='retail'
          AND o.active=1 AND o.offer_type='free' AND o.amount_minor=0
        WHERE p.id IN (${list}) AND p.source_name='operator'
          AND ${validGrant}`,params,
    },
    dropOffers:{
      sql:`DELETE FROM offers WHERE id IN (${list})`,
      params:ids.map(id=>prefix+id),
    },
    restore:{
      sql:`UPDATE products SET source_name='gutenberg'
        WHERE id IN (${list}) AND source_name='operator'`,params,
    },
  };
}
