import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(),read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');
const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
for(const f of migrations)db.exec(read(`drizzle/${f}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);

const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
for(const t of ['risk_policy_versions','risk_events','risk_assessments','risk_holds','risk_entity_links','risk_cases','risk_case_events','risk_provider_signals','commerce_tax_registrations','commerce_tax_evidence','commerce_tax_records','commerce_tax_reversals','commerce_tax_reconciliation_runs','publisher_tax_withholding_rules','publisher_tax_verification_events','publisher_tax_reporting_periods'])assert.ok(tables.has(t),`missing ${t}`);
assert.equal(db.prepare("SELECT COUNT(*) n FROM risk_policy_versions WHERE status='active'").get().n,5);
for(const domain of ['buyer','publisher','community','payout','usage'])assert.equal(db.prepare("SELECT COUNT(*) n FROM risk_policy_versions WHERE domain=? AND status='active'").get(domain).n,1,`missing active ${domain} policy`);
const buyerPolicy=JSON.parse(db.prepare("SELECT policy_json FROM risk_policy_versions WHERE domain='buyer' AND status='active'").get().policy_json);for(const k of ['refundRatio','promoVelocity','giftCardHeavy','giftCardReuse','publisherSelfPurchase','processorHighRisk','securityChangeBurst'])assert.ok(Number(buyerPolicy.weights[k])>0,`buyer policy missing ${k}`);

const taxCols=new Set(db.prepare('PRAGMA table_info(publishing_tax_profiles)').all().map(r=>r.name));
const usageCols=new Set(db.prepare('PRAGMA table_info(finance_usage_events)').all().map(r=>r.name));for(const c of ['device_fingerprint_hash','network_fingerprint_hash','session_fingerprint_hash'])assert.ok(usageCols.has(c),`usage fraud field missing ${c}`);
for(const c of ['tax_residency_country','tin_last4','provider_verification_status','form_status','treaty_rate_bps','backup_withholding_bps','effective_withholding_bps','compliance_snapshot_json','next_review_at'])assert.ok(taxCols.has(c),`missing tax profile field ${c}`);
assert.ok(!taxCols.has('tin')&&!taxCols.has('ssn')&&!taxCols.has('ein'),'Cove must not add raw tax identifiers to publishing_tax_profiles');

const now='2026-09-25T16:00:00.000Z';
db.prepare("INSERT INTO risk_events(id,domain,event_type,subject_type,subject_id,metadata_json,dedupe_key,occurred_at,created_at) VALUES('re','buyer','checkout_assessed','order','o','{}','d',?,?)").run(now,now);
let blocked=false;try{db.prepare("UPDATE risk_events SET event_type='tampered' WHERE id='re'").run()}catch{blocked=true}assert.ok(blocked,'risk events must be immutable');
db.prepare("INSERT INTO risk_assessments(id,domain,subject_type,subject_id,policy_version_id,score,level,action,signals_json,provider_scores_json,input_snapshot_json,created_at) VALUES('ra','buyer','order','o','risk-buyer-v1',10,'low','allow','[]','{}','{}',?)").run(now);
blocked=false;try{db.prepare("UPDATE risk_assessments SET score=99 WHERE id='ra'").run()}catch{blocked=true}assert.ok(blocked,'risk assessments must be immutable');

const risk=read('src/features/fore/risk-tax.server.ts');
for(const token of ['assessBuyerOrderRisk','assessAccountTakeoverRisk','ingestStripeRiskSignal','assessPublisherRisk','assessCommunityReviewRisk','assessUsageRisk','assessPayoutRisk','createRiskHold','manageRiskCase','riskTaxOperationsSnapshot','recordCheckoutTaxEvidence','recordCustomerTaxCalculation','reconcileCustomerTaxPeriod','registerPublisherTaxVerification','effectivePublisherWithholding','publisher_tax_withholding_rules','refreshPublisherTaxReportingPeriod','verifyPublisherTaxWebhook'])assert.ok(risk.includes(token),`risk/tax server missing ${token}`);
const commerce=read('src/features/fore/commerce.server.ts');for(const token of ['assessBuyerOrderRisk','ingestStripeRiskSignal','recordCheckoutTaxEvidence','recordCustomerTaxCalculation','commitCustomerTaxRecord','recordCustomerTaxReversal','request_three_d_secure','capture_method'])assert.ok(commerce.includes(token),`commerce risk/tax wiring missing ${token}`);
const delivery=read('src/features/fore/delivery.server.ts');assert.ok(delivery.includes('assertNoBuyerFulfillmentHold'),'buyer fraud holds must gate commercial delivery');
const audio=read('src/features/fore/commercial-audio.server.ts');assert.ok(audio.includes('assertCommercialAudioRiskAccess'),'buyer fraud holds must gate commercial audiobook access');
const publishing=read('src/features/fore/publishing.server.ts');assert.ok(publishing.includes('assessPublisherRisk'),'publisher fraud risk must gate publishing');
const retail=read('src/features/fore/retail-intelligence.server.ts');assert.ok(retail.includes('assessCommunityReviewRisk'),'community fraud signals must enter unified risk cases');
const royalty=read('src/features/fore/royalty-engine.server.ts');for(const token of ['deviceFingerprintHash','networkFingerprintHash','assessUsageRisk','effectivePublisherWithholding','!tax.verified','tax_profile_id','withholding_rule_id'])assert.ok(royalty.includes(token),`royalty compliance missing ${token}`);
const finance=read('src/features/fore/finance.server.ts');assert.ok(finance.includes('assessPayoutRisk'),'payout risk assessment missing');
const auth=read('src/features/fore/auth.server.ts');assert.ok(auth.includes('assessAccountTakeoverRisk'),'account takeover signals missing from auth');
const api=read('src/features/fore/api.server.ts');for(const route of ['/tax/provider/webhook','/admin/risk/status','/admin/tax/status','/admin/risk-tax/status','/admin/risk/case','/admin/risk/hold/release','/admin/risk/policy','/admin/tax/registration','/admin/tax/withholding-rule','/admin/tax/publisher-verification','/admin/tax/reconcile','/admin/tax/reporting/refresh'])assert.ok(api.includes(route),`API missing ${route}`);
const ui=read('src/features/fore/Publishing.tsx');for(const token of ['Fraud investigation queue','Active fraud & compliance holds','Publisher tax compliance'])assert.ok(ui.includes(token),`staff investigation UI missing ${token}`);
assert.ok(risk.includes("party_type||\"\")==='publisher'")&&risk.includes('verified:false'),'publisher finance parties must fail closed without a verified publishing tax profile');
assert.ok(!risk.includes('jurisdiction_code,recipient_country_code'),'tax operations snapshot must use real withholding-rule columns');
assert.ok(risk.includes('riskOperationsSnapshot')&&risk.includes('taxOperationsSnapshot'),'fraud and tax operations snapshots must be independently permissionable');
assert.equal(db.prepare("SELECT COUNT(*) n FROM staff_role_permissions WHERE role_id='role_finance_ops' AND permission IN ('tax.compliance.read','tax.compliance.manage')").get().n,2,'finance ops needs dedicated tax-compliance permissions');
for(const f of ['docs/RISK_TAX_COMPLIANCE.md','FORE_SETUP.md','.env.example'])assert.ok(read(f).includes('FORE_TAX_WEBHOOK_SECRET')||f==='FORE_SETUP.md'&&read(f).includes('Fraud, risk, and tax compliance'),`missing risk/tax operations documentation in ${f}`);
console.log(`Fraud risk / customer tax / publisher tax compliance checks passed across ${migrations.length} migrations.`);
