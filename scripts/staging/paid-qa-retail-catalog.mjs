/* The QA storefront uses the same canonical rights view and search document
 * authorization query as production. These fixtures are synthetic only.
 * Never copy rights data from the production account or invent grant rows.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

export const PAID_QA_RETAIL_PRODUCT="prd_paid_qa_20261027";
const PAID_QA_EDITION="ed_paid_qa_20261027";
const PAID_QA_GRANT="rgrant_paid_qa_20261027";
const VIEW_NAMES=["retail_product_availability_rows","retail_product_availability"];

export function canonicalPaidQaRetailViews(migration=fs.readFileSync(
  "drizzle/0074_flatten_retail_membership.sql","utf8"
)){
  const statements=migration.split(";").map(s=>s.trim()).filter(Boolean);
  const views=VIEW_NAMES.map(name=>{
    const matches=statements.filter(s=>s.startsWith("CREATE VIEW "+name+" AS"));
    assert.equal(matches.length,1,"Canonical retail authority view is missing/duplicated: "+name);
    const sql=matches[0].slice(matches[0].indexOf("CREATE VIEW "+name+" AS"));
    assert.ok(sql.length>(name===VIEW_NAMES[0]?3000:70)&&sql.length<16000);
    return {name,sql};
  });
  assert.ok(views[0].sql.includes("rights_grants")&&
    views[0].sql.includes("rights_grant_territories")&&
    views[0].sql.includes("deny.decision='deny'")&&
    views[0].sql.includes("drm_requirement"),
    "Synthetic QA must retain canonical contract/territory/deny/DRM checks");
  assert.ok(views[1].sql.includes("FROM retail_product_availability_rows"));
  return views;
}

export function exactRetailAuthorizationSql(source=fs.readFileSync(
  "src/features/fore/catalog-model.server.ts","utf8"
)){
  const fn=source.indexOf("export async function authorizeStorefrontPresentationIds");
  const begin=source.indexOf("`WITH market(currency) AS MATERIALIZED (",fn);
  const end=source.indexOf("`,\n    )\n    .bind(territory",begin);
  assert.ok(fn>=0&&begin>fn&&end>begin);
  const sql=source.slice(begin+1,end);
  assert.ok(!sql.includes("${")&&
    sql.includes("retail_product_availability_rows")&&
    sql.includes("d.suppressed=0")&&
    sql.includes("d.availability='available'")&&
    sql.includes("FROM authorized a ORDER BY a.position"),
    "QA must run unchanged canonical storefront authorization SQL");
  return sql;
}

export async function preparePaidQaRetailCatalog(qaSql){
  // qaSql is the separately signed QA D1 gateway, already locked to the
  // exact QA-account database. Do not accept target IDs or arbitrary SQL.
  for(const {name,sql} of canonicalPaidQaRetailViews()){
    const rows=(await qaSql(
      "SELECT type,sql FROM sqlite_master WHERE name=?",[name]
    )).results;
    assert.ok(rows.length<=1);
    if(rows.length){
      assert.equal(rows[0].type,"view");
      assert.equal(rows[0].sql.trim(),sql,
        "Existing QA retail view differs from source-controlled legal migration");
    }else{
      const created=await qaSql(sql);
      assert.equal(created.success,true);
    }
  }
  const rights=(await qaSql(
    "SELECT product_id,edition_id,territory_code,rights_grant_id "+
    "FROM retail_product_availability_rows WHERE product_id=? AND territory_code='US' LIMIT 3",
    [PAID_QA_RETAIL_PRODUCT]
  )).results;
  assert.deepEqual(rights,[{
    product_id:PAID_QA_RETAIL_PRODUCT,
    edition_id:PAID_QA_EDITION,
    territory_code:"US",
    rights_grant_id:PAID_QA_GRANT
  }],"Current synthetic canonical grant, territory, DRM and contract must allow exact QA retail item");
  // A search document is only a price/discovery projection, never a rights
  // grant. Build solely from pre-existing canonical product/edition/offer
  // records after the live legal view independently permits this item.
  await qaSql(
    "INSERT INTO catalog_search_documents "+
    "(product_id,external_book_id,title,first_ingested_at,updated_at,format,"+
    "currency,price_minor,availability,suppressed,release_date,product_created_at,product_updated_at) "+
    "SELECT p.id,p.source_external_id,e.title,p.created_at,p.updated_at,p.format,"+
    "o.currency,o.amount_minor,'available',0,e.release_date,p.created_at,p.updated_at "+
    "FROM products p JOIN editions e ON e.id=p.edition_id "+
    "JOIN offers o ON o.product_id=p.id "+
    "WHERE p.id=? AND p.edition_id=? AND p.source_name='publisher' "+
    "AND p.source_external_id='qa-synthetic' AND p.storefront_status='active' "+
    "AND e.release_status='available' AND o.id='offer_paid_qa_20261027' "+
    "AND o.sales_channel='retail' AND o.currency='USD' AND o.active=1 "+
    "AND o.amount_minor=399 AND NOT EXISTS "+
    "(SELECT 1 FROM catalog_search_documents d WHERE d.product_id=p.id)",
    [PAID_QA_RETAIL_PRODUCT,PAID_QA_EDITION]
  );
  const docs=(await qaSql(
    "SELECT product_id,external_book_id,title,currency,price_minor,availability,suppressed "+
    "FROM catalog_search_documents WHERE product_id=?",[PAID_QA_RETAIL_PRODUCT]
  )).results;
  assert.deepEqual(docs,[{
    product_id:PAID_QA_RETAIL_PRODUCT,
    external_book_id:"qa-synthetic",
    title:"QA Synthetic Rights Book",
    currency:"USD",price_minor:399,availability:"available",suppressed:0
  }],"Exact synthetic paid catalog projection must exist and remain unsuppressed");

  // This is the *exact* production query shape, not a simplified stand-in.
  const result=(await qaSql(exactRetailAuthorizationSql(),[
    "US",JSON.stringify([PAID_QA_RETAIL_PRODUCT]),"USD","USD","US"
  ])).results;
  assert.equal(result.length,1,"Canonical storefront must authorize exactly one QA paid product");
  assert.equal(result[0].product_id,PAID_QA_RETAIL_PRODUCT);
  assert.equal(result[0].edition_id,PAID_QA_EDITION);
  assert.deepEqual(JSON.parse(result[0].offer_json),{
    type:"purchase",currency:"USD",amountMinor:399
  });
  return {productId:PAID_QA_RETAIL_PRODUCT,legalViewChecked:true,canonicalQueryChecked:true};
}
