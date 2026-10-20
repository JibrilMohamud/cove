import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const database = "ce0e67b7-692d-44c6-94dc-7f324e7c5421";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token?.length > 24);
async function execute(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: "POST",
      headers: { Authorization: `*** "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(45000),
    },
  );
  const json = await response.json();
  if (!response.ok || !json.success) {
    const err = (json.errors || [])
      .map((x) => x.message)
      .join("; ")
      .slice(0, 220);
    throw Error(`Synthetic staging D1 query failed ${response.status}: ${err}`);
  }
  return json.result?.[0]?.results || [];
}
const counts = await execute(
  "SELECT (SELECT COUNT(*) FROM works) works,(SELECT COUNT(*) FROM products) products,(SELECT COUNT(*) FROM auth_accounts) users,(SELECT COUNT(*) FROM commerce_orders) orders",
);
const initial = counts[0];
assert.equal(initial.users, 0, "Synthetic stage may never contain real accounts");
assert.equal(initial.orders, 0, "Synthetic stage may never contain checkout orders");
if (initial.works || initial.products) {
  assert.equal(initial.works, 1000, "Only resumable synthetic fixtures allowed");
  assert.equal(initial.products, 1000, "Only resumable synthetic products allowed");
  const foreign = await execute(
    "SELECT (SELECT count(*) FROM works WHERE id NOT LIKE 'w_stage_%') works,(SELECT count(*) FROM products WHERE id NOT LIKE 'p_stage_%') products",
  );
  assert.equal(foreign[0].works, 0, "Non-fixture work detected");
  assert.equal(foreign[0].products, 0, "Non-fixture product detected");
}
const now = "2026-10-20T12:00:00Z";
for (const territory of [
  ["US", "United States", "en-US", "USD"],
  ["AU", "Australia", "en-AU", "AUD"],
  ["CA", "Canada", "en-CA", "CAD"],
  ["JP", "Japan", "ja-JP", "JPY"],
]) {
  const [code, name, locale, currency] = territory;
  await execute(
    `INSERT OR IGNORE INTO territories(code,name,is_sellable) VALUES('${code}','${name}',1)`,
  );
  await execute(
    `INSERT OR IGNORE INTO storefront_locales(locale,language_code,region_code,display_name,native_name,created_at,updated_at) VALUES('${locale}','${locale.split("-")[0]}','${code}','${locale}','${locale}','${now}','${now}')`,
  );
  await execute(
    `INSERT OR IGNORE INTO storefront_markets(country_code,display_name,default_locale,default_currency,market_status,checkout_enabled,created_at,updated_at) VALUES('${code}','${name}','${locale}','${currency}','active',0,'${now}','${now}')`,
  );
  await execute(
    `INSERT OR IGNORE INTO storefront_market_locales(country_code,locale) VALUES('${code}','${locale}')`,
  );
  await execute(
    `INSERT OR IGNORE INTO storefront_currency_options(country_code,currency) VALUES('${code}','${currency}')`,
  );
}
await execute(
  `INSERT OR IGNORE INTO storefront_pages(id,path,title,heading,description,query_json,status,created_at,updated_at) VALUES('stage_home','/','Synthetic test bookstore','Synthetic test bookstore','Noncommercial isolated test content','{}','published','${now}','${now}')`,
);
const makeSeq = (sql, max = 1000) =>
  `WITH RECURSIVE seq(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${max}) ${sql}`;
const id = (prefix) => `'${prefix}'||printf('%06d',n)`;
const queries = [
  makeSeq(
    `INSERT OR IGNORE INTO works(id,title,created_at,updated_at) SELECT ${id("w_stage_")},'Synthetic Work '||n,'${now}','${now}' FROM seq`,
  ),
  makeSeq(
    `INSERT OR IGNORE INTO editions(id,work_id,title,created_at,updated_at,release_status) SELECT ${id("e_stage_")},${id("w_stage_")},'Synthetic Book '||n,'${now}','${now}','available' FROM seq`,
  ),
  makeSeq(
    `INSERT OR IGNORE INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) SELECT ${id("p_stage_")},${id("e_stage_")},${id("sku_stage_")},'ebook','active','stage-fixture',${id("src_stage_")},'${now}','${now}' FROM seq`,
  ),
  makeSeq(
    `INSERT OR IGNORE INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at) SELECT ${id("o_stage_")},${id("p_stage_")},'standard','USD',0,1,'${now}','${now}' FROM seq`,
  ),
  makeSeq(
    `INSERT OR IGNORE INTO rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,decision,status,created_at,source) SELECT ${id("rg_stage_")},${id("e_stage_")},'US','ebook','retail','staging-synthetic-only','allow','active','${now}','operator-test-fixture' FROM seq`,
  ),
  // Rights-grant insert triggers already materialize normalized scopes.
  makeSeq(
    `INSERT OR IGNORE INTO catalog_search_documents(product_id,external_book_id,title,description,first_ingested_at,updated_at,currency,price_minor,download_count,availability,suppressed) SELECT ${id("p_stage_")},${id("src_stage_")},'Synthetic Book '||n,'Test fixture', '${now}','${now}','USD',0,1000-n,'available',0 FROM seq`,
  ),
];
for (let i = 0; i < queries.length; i++) {
  await execute(queries[i]);
  console.log(JSON.stringify({ fixturePhase: i + 1, totalPhases: queries.length }));
}
const out = await execute(
  `SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM rights_grants) grants,(SELECT count(*) FROM catalog_search_documents) documents,(SELECT count(*) FROM retail_product_availability_rows WHERE territory_code='US') usLegal,(SELECT count(*) FROM retail_product_availability_rows WHERE territory_code='AU') auLegal,(SELECT count(*) FROM commerce_orders) orders`,
);
assert.equal(out[0].products, 1000);
assert.equal(out[0].grants, 1000);
assert.equal(out[0].documents, 1000);
assert.equal(out[0].usLegal, 1000);
assert.equal(out[0].auLegal, 0);
assert.equal(out[0].orders, 0);
console.log(JSON.stringify({ stageFixture: true, results: out[0], syntheticOnly: true }));
