import assert from "node:assert/strict";

// Inspects only synthetic stage D1. Read-only LIMIT 1 queries verify the
// exact access path the producer uses. Never publish book IDs, SQL rows or
// production identifiers in CI logs.
const id = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.match(account, /^[0-9a-f]{32}$/);
assert.ok(token.length >= 20);
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`;
const sql = `SELECT d.product_id FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
 JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id
 WHERE d.currency=COALESCE(
   (SELECT default_currency FROM storefront_markets WHERE country_code=? AND market_status='active'),
   (SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active'))
   AND d.availability='available' AND d.suppressed=0
   AND p.storefront_status='active' AND p.source_name<>'upload'
   AND e.release_status IN ('available','preorder')
   AND EXISTS (
      SELECT 1 FROM retail_product_availability_rows rpa
      WHERE rpa.product_id=p.id AND rpa.territory_code=?
   )
 ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC LIMIT 1`;
for (const country of ["US", "CA", "SA", "JP"]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql, params: [country, country] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("Synthetic D1 query API refused: " + response.status);
  const body = await response.json();
  const value = body.result?.[0];
  // Check only response shape and whether at least one rankable licensed
  // product exists in the isolated fixture; never emit product identifiers.
  const count = Array.isArray(value?.results) ? value.results.length : 0;
  const queryOk = body.success === true && value?.success === true;
  console.log(
    "COVE_PRODUCER_SQL_PREFLIGHT " + JSON.stringify({ country, queryOk, candidates: count }),
  );
  if (!queryOk) throw Error("Stage candidate SQL failed for " + country);
  // A legally empty market is valid; never invent a grant merely to pass
  // staging. Only the US smoke fixture must have at least one candidate.
  if (country === "US" && count === 0)
    throw Error("Protected US stage shelf fixture has no licensed products");
}

const marketsResponse = await fetch(endpoint, {
  method: "POST",
  headers: {
    authorization: "Bearer " + token,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    sql: "SELECT COUNT(*) AS total FROM storefront_markets WHERE market_status='active'",
  }),
  signal: AbortSignal.timeout(20000),
});
if (!marketsResponse.ok) throw Error("Stage market-count API refused");
const marketData = await marketsResponse.json();
const total = Number(marketData.result?.[0]?.results?.[0]?.total);
if (!marketData.success || !Number.isSafeInteger(total) || total < 1)
  throw Error("Isolated stage market configuration unavailable");
console.log("COVE_PRODUCER_MARKET_COUNT " + JSON.stringify({ markets: total, limit: 32 }));
if (total > 32)
  throw Error("Private projection producer cannot cover all active markets within its configured limit");
