import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
const root=process.cwd(),db=new DatabaseSync(':memory:');
for(const name of fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort()){
  const sql=fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';');db.exec(sql);
}
const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const t of ['preview_policies','preview_derivatives','preview_states','wishlist_profiles','wishlist_events','commerce_notifications','shopping_carts','shopping_cart_items','product_rankings'])assert(tables.has(t),`missing ${t}`);
const wishCols=new Set(db.prepare('pragma table_info(wishlist_items)').all().map(x=>x.name));
for(const c of ['alert_price_drop','alert_sale','alert_release','alert_preorder','currency','source_surface','source_request_id','converted_at','updated_at'])assert(wishCols.has(c),`wishlist missing ${c}`);
const at=new Date().toISOString();
db.prepare("insert into works(id,title,created_at,updated_at) values('w','Retail test',?,?)").run(at,at);
db.prepare("insert into editions(id,work_id,title,language,release_status,created_at,updated_at) values('e','w','Retail test','en','available',?,?)").run(at,at);
db.prepare("insert into products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) values('p','e','SKU','ebook','active','publisher','fore_00000000-0000-0000-0000-000000000001',?,?)").run(at,at);
db.prepare("insert or ignore into territories(code,name) values('US','United States'),('CA','Canada')").run();
db.prepare("insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,drm_requirement,created_at) values('r','e','US','ebook','retail','agency','none',?)").run(at);
db.prepare("insert into offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at) values('o','p','retail','USD',999,1,?,?)").run(at,at);
assert.equal(db.prepare("select count(*) n from rights_grants where edition_id='e' and territory_code='US'").get().n,1);assert.equal(db.prepare("select count(*) n from rights_grants where edition_id='e' and territory_code='CA'").get().n,0);
db.prepare("insert into preview_policies(edition_id,enabled,mode,limit_value,max_percentage,version,updated_by,created_at,updated_at) values('e',1,'percent',10,20,1,'test',?,?)").run(at,at);
assert.equal(db.prepare("select limit_value from preview_policies where edition_id='e'").get().limit_value,10);
db.prepare("insert into wishlist_items(user_id,product_id,added_at,baseline_price_minor,last_seen_price_minor,currency,updated_at) values('u','p',?,999,999,'USD',?)").run(at,at);
assert.equal(db.prepare("select alert_price_drop from wishlist_items where user_id='u'").get().alert_price_drop,1);
const api=fs.readFileSync('src/features/fore/api.server.ts','utf8'),retail=fs.readFileSync('src/features/fore/retail.server.ts','utf8'),book=fs.readFileSync('src/features/fore/Book.tsx','utf8'),reader=fs.readFileSync('src/features/fore/Reader.tsx','utf8'),store=fs.readFileSync('src/features/fore/Store.tsx','utf8');
assert.match(api,/product\.source_name !== "gutenberg"/);assert.match(api,/requires an active purchase, loan, subscription, gift, or publisher entitlement/);assert.match(api,/Customer requests never fetch publisher-controlled URLs/);assert.match(api,/preview_derivatives/);assert.match(api,/Keeping every image\/font from the publisher EPUB would leak future pages/);assert.match(api,/bits\[3\] === "preview" && bits\[4\] === "epub"/);assert.match(api,/getPreviewEpub\(env,id/);
assert.match(retail,/No active|not currently available|offer/);assert.match(retail,/share_token=excluded\.share_token/);assert.match(retail,/stalePrice/);assert.match(retail,/last_seen_price_minor/);assert.match(api,/converted_at/);
assert.match(book,/commerce\.canReadFull/);assert.match(book,/Add to cart/);assert.match(book,/Preview/);assert.match(book,/Currently unavailable/);assert.match(reader,/previewMode/);assert.match(reader,/\/preview\/state/);assert.match(reader,/epubBytes\(id,previewMode,data\.user\?\.id\|\|""\)/);assert.match(store,/if \(!offer\) return "Unavailable"/);
console.log('commercial retail regression checks passed');
