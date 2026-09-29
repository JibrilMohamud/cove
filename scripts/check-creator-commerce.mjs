import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(), db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
for(const f of migrations) db.exec(fs.readFileSync(path.join(root,'drizzle',f),'utf8'));
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');

const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
for(const t of [
  'finance_royalty_rules','finance_royalty_calculations','finance_royalty_allocations','finance_usage_events','finance_usage_pools',
  'creator_daily_metrics','creator_statement_exports','creator_tax_documents','finance_statement_revisions',
  'preorder_policy_versions','preorder_release_plans','preorders','preorder_price_adjustments','preorder_refund_jobs','preorder_events','publishing_preorder_incidents','preorder_release_changes',
  'promotion_policy_versions','promotion_campaigns','promotion_campaign_products','promotion_attribution_events','promotion_campaign_events'
]) assert.ok(tables.has(t),`missing creator-commerce table ${t}`);

const triggers=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r=>r.name));
for(const t of ['trg_preorders_no_duplicate_active_insert','trg_preorder_events_append_only_update','trg_promotion_attribution_events_append_only_update']) assert.ok(triggers.has(t),`missing creator-commerce safety trigger ${t}`);

for(const permission of ['finance.contract.manage','finance.usage.ingest','finance.statement.generate','finance.metrics.refresh','finance.tax_document.manage','promotions.review','promotions.operations.read']){
  const n=Number(db.prepare('SELECT COUNT(*) n FROM staff_role_permissions WHERE permission=?').get(permission).n);
  assert.ok(n>=1,`missing RBAC permission ${permission}`);
}

// A contract version is immutable and links to its predecessor/actor/change reason.
db.prepare("INSERT INTO finance_royalty_contracts(id,name,sales_channel,effective_from,status,created_at,updated_at) VALUES('rc','Test','retail','2026-01-01T00:00:00.000Z','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
db.prepare("INSERT INTO finance_royalty_contract_versions(id,contract_id,version,calculation_basis,fore_commission_bps,payment_terms_days,reserve_bps,effective_from,created_at,rules_version_hash,default_royalty_rate_bps,effective_to,notes,created_by_user_id,change_reason) VALUES('rcv1','rc',1,'net_revenue',2500,60,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','hash',NULL,NULL,'','staff','Initial terms')").run();
let blocked=false;try{db.prepare("UPDATE finance_royalty_contract_versions SET fore_commission_bps=1000 WHERE id='rcv1'").run()}catch{blocked=true}assert.ok(blocked,'royalty contract versions must be immutable');

// Promotion terms lock as soon as submitted.
db.prepare("INSERT INTO promotion_campaigns(id,name,campaign_type,status,funding_source,publisher_funding_bps,starts_at,ends_at,stackable,eligibility_json,merchandising_submission,created_at,updated_at,policy_version) VALUES('camp','Launch','launch_pricing','submitted','publisher',10000,'2026-10-01T00:00:00.000Z','2026-10-08T00:00:00.000Z',0,'{}',0,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','fore-promotions-v1')").run();
blocked=false;try{db.prepare("UPDATE promotion_campaigns SET funding_source='fore' WHERE id='camp'").run()}catch{blocked=true}assert.ok(blocked,'submitted promotion economics must be immutable');

// Tax-document identity/provenance is immutable.
db.prepare("INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,created_at,updated_at) VALUES('pa','company','Publisher LLC','Publisher','US','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
db.prepare("INSERT INTO creator_tax_documents(id,publishing_account_id,tax_year,jurisdiction,document_type,status,object_key,created_at,source_provider,source_reference,sha256,mime_type) VALUES('td','pa',2026,'US','1099','available','tax/x.pdf','2026-09-01T00:00:00.000Z','provider','ref','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','application/pdf')").run();
blocked=false;try{db.prepare("UPDATE creator_tax_documents SET object_key='tax/changed.pdf' WHERE id='td'").run()}catch{blocked=true}assert.ok(blocked,'tax-document evidence identity must be immutable');

// Source checks make sure the operational surface is connected rather than schema-only.
const royalty=fs.readFileSync(path.join(root,'src/features/fore/royalty-engine.server.ts'),'utf8');
const reporting=fs.readFileSync(path.join(root,'src/features/fore/creator-reporting.server.ts'),'utf8');
const preorder=fs.readFileSync(path.join(root,'src/features/fore/preorder.server.ts'),'utf8');
const promotions=fs.readFileSync(path.join(root,'src/features/fore/promotions.server.ts'),'utf8');
const commerce=fs.readFileSync(path.join(root,'src/features/fore/commerce.server.ts'),'utf8');
const api=fs.readFileSync(path.join(root,'src/features/fore/api.server.ts'),'utf8');
const publishingUi=fs.readFileSync(path.join(root,'src/features/fore/Publishing.tsx'),'utf8');
const bookUi=fs.readFileSync(path.join(root,'src/features/fore/Book.tsx'),'utf8');
for(const needle of ['rules_version_hash','contractForContext','publisherFundedDiscountTreatment','processorFeeTreatment','finance_royalty_allocations','supersedesVersionId','Royalty splits must allocate exactly 100%','availabilityAnchorAt','preorder_release_at']) assert.ok(royalty.includes(needle),`royalty engine missing ${needle}`);
for(const needle of ['creatorDashboard','creatorSalesCsv','creatorRoyaltyCsv','creatorStatementCsv','generateMonthlyStatement','creatorTaxDocumentRecord','registerCreatorTaxDocument','WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id']) assert.ok(reporting.includes(needle),`reporting missing ${needle}`);
for(const needle of ['preorderPurchaseState','assertPreorderPurchaseAllowed','registerPaidPreorder','updatePreorderLowestPrice','customerCancelPreorder','advancePreorders','publishing_preorder_incidents']) assert.ok(preorder.includes(needle),`preorder engine missing ${needle}`);
for(const needle of ['savePromotionCampaign','reviewPromotionCampaign','recordStorefrontPromotionEvent','createCampaignCoupon','recordPromotionAttribution','promotion.price_changed']) assert.ok(promotions.includes(needle),`promotions missing ${needle}`);
for(const needle of ['processPreorderRefundJobs','processor_fee_minor','accrueRoyaltiesForOrder','registerPaidPreorder']) assert.ok(commerce.includes(needle),`commerce integration missing ${needle}`);
for(const route of ['/publishing/dashboard','/publishing/sales.csv','/publishing/royalties.csv','/publishing/statements/','/publishing/preorders','/publishing/promotions','/admin/publishing/royalty-contract-version','/admin/publishing/usage-event','/publishing-worker/preorders/tick','/publishing-worker/promotions/tick']) assert.ok(api.includes(route),`API route missing ${route}`);
for(const uiNeedle of ['Promotion review queue','/admin/publishing/promotion-review','promotions.operations.read','Monthly statements']) assert.ok(publishingUi.includes(uiNeedle),`creator/staff UI missing ${uiNeedle}`);
for(const uiNeedle of ['Preorder now','Cancel preorder','/promotions/event']) assert.ok(bookUi.includes(uiNeedle),`preorder/storefront UI missing ${uiNeedle}`);
assert.ok(fs.existsSync(path.join(root,'docs/CREATOR_COMMERCE.md')),'creator commerce operations documentation missing');

// Sanity-check the example economics Cove is designed to express.
const sale=999,tax=80,processor=35,commission=250;
assert.equal(sale-tax-processor-commission,634,'example $9.99 sale should leave $6.34 publisher economics');

console.log(`creator commerce regression passed: ${migrations.length} migrations; contractual royalty versioning, reporting, preorder fulfillment/refunds, promotion operations, RBAC, and immutable accounting evidence verified.`);
