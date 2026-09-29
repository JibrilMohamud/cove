import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const root=process.cwd(), db=new DatabaseSync(':memory:');
for(const f of fs.readdirSync(path.join(root,'drizzle')).filter(x=>x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(root,'drizzle',f),'utf8'));
const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const t of ['pricing_policies','pricing_region_rules','fx_rates','pricing_decisions','preorder_price_guarantees','finance_parties','finance_royalty_contracts','finance_royalty_contract_versions','finance_royalty_splits','finance_royalty_events','payout_batches','payout_items','finance_statements']) if(!tables.has(t)) throw new Error('missing table '+t);
const commerce=fs.readFileSync('src/features/fore/commerce.server.ts','utf8'),pricing=fs.readFileSync('src/features/fore/pricing.server.ts','utf8'),finance=fs.readFileSync('src/features/fore/finance.server.ts','utf8'),api=fs.readFileSync('src/features/fore/api.server.ts','utf8');
for(const needle of ['resolvePricingDecision','pricingDecisionId','accrueRoyaltiesForOrder','reverseRoyaltiesForRefund']) if(!commerce.includes(needle)) throw new Error('commerce missing '+needle);
for(const needle of ['preorder_price_guarantees','pricing_decisions','publisher_floor_minor','fx_rates','fundingSource']) if(!pricing.includes(needle)) throw new Error('pricing missing '+needle);
for(const needle of ['finance_royalty_events','withholding_minor','reserve_minor','createPayoutBatch','approvePayoutBatch']) if(!finance.includes(needle)) throw new Error('finance missing '+needle);
for(const route of ['/admin/commerce/finance-party','/admin/commerce/royalty-contract','/admin/commerce/payout-batch','/admin/commerce/payout-approve','/admin/commerce/payout-settle','/admin/commerce/fx-rate','/admin/commerce/price-schedule']) if(!api.includes(route)) throw new Error('API missing '+route);
// Verify append-only commerce ledger survived this migration.
let blocked=false; try { db.exec("INSERT INTO commerce_ledger_entries(id,entry_type,account_code,amount_minor,currency,created_at) VALUES('x','t','a',0,'USD','2026-01-01'); UPDATE commerce_ledger_entries SET amount_minor=1 WHERE id='x'"); } catch { blocked=true; }
if(!blocked) throw new Error('commerce ledger is no longer append-only');
console.log('commercial finance + pricing regression checks passed ('+tables.size+' tables)');
