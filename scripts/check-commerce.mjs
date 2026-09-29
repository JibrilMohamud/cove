import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(),db=new DatabaseSync(':memory:');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
for(const name of migrations){const sql=fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';');db.exec(sql);}

const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const t of ['commerce_customers','commerce_checkout_quotes','commerce_orders','commerce_order_items','commerce_payment_attempts','commerce_promo_codes','commerce_promo_redemptions','commerce_gift_cards','commerce_gift_card_ledger','commerce_store_credit_ledger','commerce_balance_reservations','commerce_refunds','commerce_disputes','commerce_webhook_events','commerce_ledger_entries','commerce_reconciliation_runs'])assert(tables.has(t),`missing ${t}`);
const offerCols=new Set(db.prepare('pragma table_info(offers)').all().map(x=>x.name));
for(const c of ['tax_behavior','tax_code'])assert(offerCols.has(c),`offers missing ${c}`);
const refundCols=new Set(db.prepare('pragma table_info(commerce_refunds)').all().map(x=>x.name));
for(const c of ['stripe_amount_minor','gift_card_amount_minor','store_credit_amount_minor','tax_reversal_id'])assert(refundCols.has(c),`refunds missing ${c}`);
const orderIndexes=new Set(db.prepare("pragma index_list('commerce_orders')").all().map(x=>x.name));
assert(orderIndexes.has('idx_commerce_orders_quote_unique'),'quote-to-order uniqueness missing');
const ledgerIndexes=new Set(db.prepare("pragma index_list('commerce_ledger_entries')").all().map(x=>x.name));
assert(ledgerIndexes.has('idx_commerce_ledger_idempotent'),'ledger idempotency index missing');

// Append-only + database-level accounting idempotency.
const at=new Date().toISOString();
db.exec("PRAGMA foreign_keys=ON");
db.prepare("insert into commerce_orders(id,user_id,invoice_number,status,currency,territory_code,subtotal_minor,total_minor,stripe_due_minor,billing_address_json,idempotency_key,created_at,updated_at) values('ord-test','u','FORE-TEST','paid','USD','US',1000,1000,1000,'{}','idem-test',?,?)").run(at,at);
db.prepare("insert into commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,created_at) values('l1','ord-test','u','sale_tender','stripe_receivable',1000,'USD','pi_test',?)").run(at);
db.prepare("insert into commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,created_at) values('l2','ord-test','u','sale','ebook_sales',-1000,'USD','pi_test',?)").run(at);
assert.equal(db.prepare("select sum(amount_minor) n from commerce_ledger_entries where order_id='ord-test'").get().n,0,'sale ledger is not balanced');
assert.throws(()=>db.prepare("update commerce_ledger_entries set amount_minor=1 where id='l1'").run(),/append-only/);
assert.throws(()=>db.prepare("delete from commerce_ledger_entries where id='l1'").run(),/append-only/);
assert.throws(()=>db.prepare("insert into commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,created_at) values('l3','ord-test','u','sale','ebook_sales',-1000,'USD','pi_test',?)").run(at),/UNIQUE/);

const commerce=fs.readFileSync('src/features/fore/commerce.server.ts','utf8');
const api=fs.readFileSync('src/features/fore/api.server.ts','utf8');
const ui=fs.readFileSync('src/features/fore/Commerce.tsx','utf8');
const book=fs.readFileSync('src/features/fore/Book.tsx','utf8');
const staff=fs.readFileSync('src/features/fore/StorefrontAdmin.tsx','utf8');
const app=fs.readFileSync('src/features/fore/App.tsx','utf8');
const env=fs.readFileSync('.env.example','utf8');

assert.match(commerce,/pk_live_51U2mLeI83hMSbuqG7AlyoMIwkMiRnXAOzhu1xUWHQmgIyHIQ5CQbulG18lclVtV5taR9LFAecdJ0OQYt57028FdQ00UwZsetPA/);
assert.match(env,/STRIPE_SECRET_KEY=sk_live_REPLACE_WITH_YOUR_SECRET_KEY/);
assert.match(commerce,/placeholder secret key/);
assert.match(commerce,/payment_intents/);
assert.match(commerce,/automatic_payment_methods/);
assert.match(commerce,/Idempotency-Key/);
assert.match(commerce,/tax\/calculations/);
assert.match(commerce,/txcd_10302000/);
assert.match(commerce,/tax\/transactions\/create_from_calculation/);
assert.match(commerce,/tax\/transactions\/create_reversal/);
assert.match(commerce,/flat_amount:-refundAmount/);
assert.match(commerce,/refunds/);
assert.match(commerce,/charge\.dispute/);
assert.match(commerce,/risk_score/);
assert.match(commerce,/stripe_fee_expense/);
assert.match(commerce,/chargeback_loss/);
assert.match(commerce,/ledgerImbalances/);
assert.match(commerce,/STRIPE_WEBHOOK_SECRET/);
assert.match(commerce,/stripe-signature/);
assert.match(commerce,/Boolean\(event\.livemode\)!==expectedLive/);
assert.match(commerce,/releaseOrderReservations/);
assert.match(commerce,/expired_stale_checkout/);
assert.match(commerce,/invoiceHtml/);
assert.match(api,/\/stripe\/webhook/);
assert.match(api,/requireCommerceAdmin/);
assert.doesNotMatch(api,/FORE_COMMERCE_ADMIN_TOKEN/);
assert.match(api,/invoice\.html/);
assert.match(api,/script-src 'none'/);
assert.match(ui,/https:\/\/js\.stripe\.com\/v3\//);
assert.match(ui,/confirmPayment/);
assert.match(ui,/Printable invoice/);
assert.match(ui,/Resume payment/);
assert.match(ui,/Cancel order/);
assert.match(book,/Buy now/);
assert.match(app,/Cart/);
assert.match(app,/Orders/);
assert.match(staff,/Commerce operations/);
assert.match(staff,/Ledger balance warnings/);
assert.match(staff,/Download accounting CSV/);
console.log(`commercial Stripe checkout regression checks passed (${migrations.length} migrations)`);
