import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {
  PAID_QA_RETAIL_PRODUCT,canonicalPaidQaRetailViews,
  exactRetailAuthorizationSql,preparePaidQaRetailCatalog
} from "./paid-qa-retail-catalog.mjs";

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,public_id TEXT,source_name TEXT,source_external_id TEXT,storefront_status TEXT,format TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE editions(id TEXT PRIMARY KEY,public_id TEXT,title TEXT,drm_status TEXT,release_status TEXT,release_date TEXT);
    CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,sales_channel TEXT,format TEXT,status TEXT,starts_at TEXT,ends_at TEXT,contract_id TEXT,decision TEXT,drm_requirement TEXT);
    CREATE TABLE rights_grant_territories(grant_id TEXT,territory_code TEXT);
    CREATE TABLE rights_contracts(id TEXT PRIMARY KEY,status TEXT,effective_from TEXT,effective_to TEXT,language_match_mode TEXT);
    CREATE TABLE rights_contract_languages(contract_id TEXT,decision TEXT,language_code TEXT,format TEXT,sales_channel TEXT,starts_at TEXT,ends_at TEXT);
    CREATE TABLE edition_languages(edition_id TEXT,kind TEXT,language_code TEXT);
    CREATE TABLE digital_assets(edition_id TEXT,kind TEXT,drm_status TEXT,updated_at TEXT);
    CREATE TABLE offers(id TEXT,product_id TEXT,sales_channel TEXT,currency TEXT,amount_minor INTEGER,active INTEGER,starts_at TEXT,ends_at TEXT,offer_type TEXT,created_at TEXT);
    CREATE TABLE storefront_markets(country_code TEXT,default_currency TEXT,market_status TEXT);
    CREATE TABLE catalog_search_documents(product_id TEXT PRIMARY KEY,external_book_id TEXT NOT NULL,title TEXT NOT NULL,first_ingested_at TEXT NOT NULL,updated_at TEXT NOT NULL,format TEXT,currency TEXT,price_minor INTEGER,availability TEXT,suppressed INTEGER,release_date TEXT,product_created_at TEXT,product_updated_at TEXT);
    INSERT INTO products VALUES('prd_paid_qa_20261027','ed_paid_qa_20261027',NULL,'publisher','qa-synthetic','active','ebook','2026-10-27T02:38:57.304Z','2026-10-27T02:38:57.304Z');
    INSERT INTO editions VALUES('ed_paid_qa_20261027',NULL,'QA Synthetic Rights Book','none','available',NULL);
    INSERT INTO rights_grants VALUES('rgrant_paid_qa_20261027','ed_paid_qa_20261027','retail','ebook','active',NULL,NULL,'rcontract_paid_qa_20261027','allow','none');
    INSERT INTO rights_grant_territories VALUES('rgrant_paid_qa_20261027','US');
    INSERT INTO rights_contracts VALUES('rcontract_paid_qa_20261027','active','2026-10-01',NULL,'all');
    INSERT INTO edition_languages VALUES('ed_paid_qa_20261027','content','en');
    INSERT INTO offers VALUES('offer_paid_qa_20261027','prd_paid_qa_20261027','retail','USD',399,1,NULL,NULL,'purchase','2026-10-27T02:44:03.340Z');
    INSERT INTO storefront_markets VALUES('US','USD','active');
  `);
  const qaSql=async(sql,params=[])=>{
    const statement=db.prepare(sql);
    if(/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql))
      return {success:true,results:statement.all(...params).map(row=>({...row}))};
    return {success:true,results:[],meta:statement.run(...params)};
  };
  return {db,qaSql};
}

test("source-controlled legal views and exact storefront query remain unchanged",()=>{
  const views=canonicalPaidQaRetailViews();
  assert.deepEqual(views.map(x=>x.name),[
    "retail_product_availability_rows","retail_product_availability"
  ]);
  assert.ok(views[0].sql.includes("rg.status='active'"));
  assert.ok(views[0].sql.includes("deny.decision='deny'"));
  const sql=exactRetailAuthorizationSql();
  assert.ok(sql.includes("JOIN catalog_search_documents d"));
  assert.ok(sql.includes("EXISTS (SELECT 1 FROM retail_product_availability_rows"));
});

test("isolated QA canonical retail schema and paid search document are idempotent",async()=>{
  const {db,qaSql}=fixture();
  try{
    const a=await preparePaidQaRetailCatalog(qaSql);
    const b=await preparePaidQaRetailCatalog(qaSql);
    assert.deepEqual(a,b);
    assert.equal(a.canonicalQueryChecked,true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_search_documents").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM retail_product_availability_rows WHERE product_id=?")
      .get(PAID_QA_RETAIL_PRODUCT).n,1);
  }finally{db.close()}
});

test("current grant withdrawal cannot be authorized by stale search materialization",async()=>{
  const {db,qaSql}=fixture();
  try{
    await preparePaidQaRetailCatalog(qaSql);
    db.prepare("UPDATE rights_grants SET decision='deny' WHERE id='rgrant_paid_qa_20261027'").run();
    const canonical=exactRetailAuthorizationSql();
    assert.deepEqual((await qaSql(canonical,[
      "US",JSON.stringify([PAID_QA_RETAIL_PRODUCT]),"USD","USD","US"
    ])).results,[]);
    await assert.rejects(preparePaidQaRetailCatalog(qaSql));
  }finally{db.close()}
});

test("suppressed catalog rows fail even while canonical rights are active",async()=>{
  const {db,qaSql}=fixture();
  try{
    await preparePaidQaRetailCatalog(qaSql);
    db.exec("UPDATE catalog_search_documents SET suppressed=1");
    await assert.rejects(preparePaidQaRetailCatalog(qaSql));
  }finally{db.close()}
});

test("a forged view and wrong synthetic offer cannot pass protected QA preflight",async()=>{
  const {db,qaSql}=fixture();
  try{
    db.exec("CREATE VIEW retail_product_availability_rows AS SELECT 1 product_id");
    await assert.rejects(preparePaidQaRetailCatalog(qaSql));
  }finally{db.close()}
  const second=fixture();
  try{
    second.db.exec("UPDATE offers SET amount_minor=1");
    await assert.rejects(preparePaidQaRetailCatalog(second.qaSql));
    assert.equal(second.db.prepare("SELECT COUNT(*) n FROM catalog_search_documents").get().n,0);
  }finally{second.db.close()}
});
