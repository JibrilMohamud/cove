import { z } from "zod";
import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";
import { emitNotification } from "./notifications.server";

const now=()=>new Date().toISOString();
const uid=(p:string)=>`${p}_${crypto.randomUUID()}`;
async function sha256(value:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,"0")).join("");}
function csvEscape(v:unknown){return `"${String(v??"").replaceAll('"','""')}"`;}

async function accountForUser(db:CatalogDB,userId:string,accountId:string){
  const row=await db.prepare(`SELECT a.*,m.role member_role FROM publishing_accounts a JOIN publishing_account_members m ON m.account_id=a.id WHERE a.id=? AND m.user_id=? AND m.status='active' LIMIT 1`).bind(accountId,userId).first<any>();
  if(!row)throw new ApiError(403,"You do not have access to this publishing account.");return row;
}
function period(rawFrom:string|null,rawTo:string|null){
  const to=rawTo&&Number.isFinite(Date.parse(rawTo))?new Date(rawTo):new Date();
  const from=rawFrom&&Number.isFinite(Date.parse(rawFrom))?new Date(rawFrom):new Date(to.getTime()-30*86400000);
  if(from>=to)throw new ApiError(400,"Reporting start must be before end.");
  if(to.getTime()-from.getTime()>370*86400000)throw new ApiError(400,"Interactive creator reports are limited to 370 days per request.");
  return{from:from.toISOString(),to:to.toISOString()};
}

export async function creatorDashboard(db:CatalogDB,userId:string,accountId:string,rawFrom:string|null,rawTo:string|null){
  const account=await accountForUser(db,userId,accountId),p=period(rawFrom,rawTo),partyId=account.finance_party_id||"";
  const [currencySummary,byTitle,byTerritory,preorders,usage,wishlist,promotions,payouts,statements,taxDocuments]=await Promise.all([
    db.prepare(`SELECT rc.currency,
      SUM(CASE WHEN rc.source_type='sale' THEN 1 ELSE 0 END) sales_units,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.customer_price_minor ELSE 0 END) gross_revenue_minor,
      SUM(CASE WHEN rc.source_type='refund' THEN ABS(rc.customer_price_minor) ELSE 0 END) refunds_minor,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.promotion_discount_minor ELSE 0 END) discounts_minor,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.tax_minor ELSE 0 END) tax_minor,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.net_receipts_minor ELSE 0 END) net_revenue_minor,
      COALESCE((SELECT SUM(ra.royalty_minor) FROM finance_royalty_allocations ra JOIN finance_royalty_calculations c2 ON c2.id=ra.calculation_id WHERE ra.party_id=? AND c2.currency=rc.currency AND c2.calculated_at>=? AND c2.calculated_at<?),0) royalties_minor
      FROM finance_royalty_calculations rc LEFT JOIN commerce_orders o ON o.id=rc.order_id
      WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=? AND rc.calculated_at<? GROUP BY rc.currency ORDER BY rc.currency`).bind(partyId,p.from,p.to,accountId,p.from,p.to).all<any>(),
    db.prepare(`SELECT rc.product_id,COALESCE(e.title,t.title,'Untitled') title,p.format,
      SUM(CASE WHEN rc.source_type='sale' THEN 1 ELSE 0 END) sales_units,
      SUM(CASE WHEN rc.source_type='refund' THEN 1 ELSE 0 END) refund_events,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.customer_price_minor ELSE 0 END) gross_revenue_minor,
      SUM(CASE WHEN rc.source_type='refund' THEN ABS(rc.customer_price_minor) ELSE 0 END) refunds_minor,
      COALESCE((SELECT SUM(ra.royalty_minor) FROM finance_royalty_allocations ra JOIN finance_royalty_calculations c2 ON c2.id=ra.calculation_id WHERE ra.party_id=? AND c2.product_id=rc.product_id AND c2.calculated_at>=? AND c2.calculated_at<?),0) royalties_minor,
      MAX(rc.currency) currency
      FROM finance_royalty_calculations rc JOIN products p ON p.id=rc.product_id JOIN editions e ON e.id=p.edition_id LEFT JOIN publishing_titles t ON t.id=(SELECT ped.title_id FROM publishing_edition_drafts ped WHERE ped.catalog_product_id=p.id LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=? AND rc.calculated_at<? GROUP BY rc.product_id,e.title,t.title,p.format ORDER BY gross_revenue_minor DESC LIMIT 500`).bind(partyId,p.from,p.to,accountId,p.from,p.to).all<any>(),
    db.prepare(`SELECT COALESCE(rc.territory_code,'') territory_code,rc.currency,SUM(CASE WHEN rc.source_type='sale' THEN 1 ELSE 0 END) units,SUM(CASE WHEN rc.source_type='sale' THEN rc.customer_price_minor ELSE 0 END) gross_revenue_minor,SUM(CASE WHEN rc.source_type='refund' THEN ABS(rc.customer_price_minor) ELSE 0 END) refunds_minor FROM finance_royalty_calculations rc WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=? AND rc.calculated_at<? GROUP BY rc.territory_code,rc.currency ORDER BY gross_revenue_minor DESC LIMIT 300`).bind(accountId,p.from,p.to).all<any>(),
    db.prepare(`SELECT pr.status,COUNT(*) units,COALESCE(SUM(pr.guaranteed_price_minor),0) value_minor,pr.currency FROM preorders pr JOIN preorder_release_plans rp ON rp.id=pr.release_plan_id JOIN publishing_edition_drafts ped ON ped.id=rp.publishing_edition_id JOIN publishing_titles pt ON pt.id=ped.title_id WHERE pt.account_id=? AND pr.created_at>=? AND pr.created_at<? GROUP BY pr.status,pr.currency ORDER BY pr.status`).bind(accountId,p.from,p.to).all<any>(),
    db.prepare(`SELECT u.source_type,SUM(u.units) units,SUM(u.pages_read) pages_read,SUM(u.seconds_consumed) seconds_consumed,COUNT(*) events FROM finance_usage_events u WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=u.product_id AND pp.publishing_account_id=?) AND u.occurred_at>=? AND u.occurred_at<? GROUP BY u.source_type ORDER BY u.source_type`).bind(accountId,p.from,p.to).all<any>(),
    db.prepare(`SELECT COUNT(*) wishlist_adds,COUNT(DISTINCT we.user_id) unique_users FROM wishlist_events we WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=we.product_id AND pp.publishing_account_id=?) AND we.event_type IN ('add','saved','wishlist_add') AND we.created_at>=? AND we.created_at<?`).bind(accountId,p.from,p.to).first<any>(),
    db.prepare(`SELECT pc.id,pc.name,pc.campaign_type,pc.status,pc.starts_at,pc.ends_at,COUNT(DISTINCT pcp.product_id) product_count,SUM(CASE WHEN pae.event_type='impression' THEN 1 ELSE 0 END) impressions,SUM(CASE WHEN pae.event_type='click' THEN 1 ELSE 0 END) clicks,SUM(CASE WHEN pae.event_type='wishlist' THEN 1 ELSE 0 END) wishlist_adds,SUM(CASE WHEN pae.event_type='order' THEN 1 ELSE 0 END) orders,COALESCE(SUM(CASE WHEN pae.event_type='order' THEN pae.amount_minor ELSE 0 END),0) attributed_revenue_minor,pc.currency FROM promotion_campaigns pc LEFT JOIN promotion_campaign_products pcp ON pcp.campaign_id=pc.id LEFT JOIN promotion_attribution_events pae ON pae.campaign_id=pc.id AND pae.created_at>=? AND pae.created_at<? WHERE pc.publishing_account_id=? GROUP BY pc.id ORDER BY pc.created_at DESC LIMIT 100`).bind(p.from,p.to,accountId).all<any>(),
    partyId?db.prepare(`SELECT pi.id,pi.currency,pi.gross_minor,pi.withholding_minor,pi.net_minor,pi.status,pi.external_payout_id,pi.created_at,pb.period_start,pb.period_end,pb.paid_at FROM payout_items pi JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pi.party_id=? ORDER BY pi.created_at DESC LIMIT 100`).bind(partyId).all<any>():Promise.resolve({results:[]}),
    partyId?db.prepare(`SELECT fs.*,COALESCE((SELECT MAX(revision) FROM finance_statement_revisions r WHERE r.statement_id=fs.id),0) revision FROM finance_statements fs WHERE fs.party_id=? ORDER BY fs.period_end DESC LIMIT 36`).bind(partyId).all<any>():Promise.resolve({results:[]}),
    db.prepare("SELECT id,tax_year,jurisdiction,document_type,status,available_at,created_at FROM creator_tax_documents WHERE publishing_account_id=? ORDER BY tax_year DESC,document_type").bind(accountId).all<any>(),
  ]);
  const todayStart=`${new Date().toISOString().slice(0,10)}T00:00:00.000Z`;
  const todayRows=await db.prepare(`SELECT rc.currency,
      SUM(CASE WHEN rc.source_type='sale' THEN 1 ELSE 0 END) sales_units,
      SUM(CASE WHEN rc.source_type='sale' THEN rc.customer_price_minor ELSE 0 END) gross_revenue_minor,
      SUM(CASE WHEN rc.source_type='refund' THEN ABS(rc.customer_price_minor) ELSE 0 END) refunds_minor,
      COALESCE((SELECT SUM(ra.royalty_minor) FROM finance_royalty_allocations ra JOIN finance_royalty_calculations c2 ON c2.id=ra.calculation_id WHERE ra.party_id=? AND c2.currency=rc.currency AND c2.calculated_at>=?),0) royalties_minor
    FROM finance_royalty_calculations rc
    WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=?
    GROUP BY rc.currency ORDER BY rc.currency`).bind(partyId,todayStart,accountId,todayStart).all<any>();
  const totalSales=(currencySummary.results as any[]).reduce((n,r)=>n+Number(r.sales_units||0),0),wishlistAdds=Number(wishlist?.wishlist_adds||0);
  return{period:p,today:{startsAt:todayStart,currencies:todayRows.results},currencies:currencySummary.results,byTitle:byTitle.results,byTerritory:byTerritory.results,preorders:preorders.results,consumption:usage.results,wishlist:{adds:wishlistAdds,uniqueUsers:Number(wishlist?.unique_users||0),wishlistToSaleConversion:wishlistAdds?Math.min(1,totalSales/wishlistAdds):null},promotions:promotions.results,payouts:payouts.results,statements:statements.results,taxDocuments:taxDocuments.results};
}

export async function creatorSalesCsv(db:CatalogDB,userId:string,accountId:string,rawFrom:string|null,rawTo:string|null){
  await accountForUser(db,userId,accountId);const p=period(rawFrom,rawTo);
  const rows=await db.prepare(`SELECT rc.calculated_at,rc.source_type,rc.product_id,e.title,p.format,rc.territory_code,rc.sales_channel,rc.currency,rc.list_price_minor,rc.customer_price_minor,rc.promotion_discount_minor,rc.tax_minor,rc.processor_fee_minor,rc.net_receipts_minor,rc.fore_commission_minor,rc.royalty_pool_minor,rc.contract_version_id,rc.contract_version_hash,rr.rule_key FROM finance_royalty_calculations rc JOIN products p ON p.id=rc.product_id JOIN editions e ON e.id=p.edition_id LEFT JOIN finance_royalty_rules rr ON rr.id=rc.rule_id WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=? AND rc.calculated_at<? ORDER BY rc.calculated_at,rc.id`).bind(accountId,p.from,p.to).all<any>();
  const headers=["calculated_at","source_type","product_id","title","format","territory_code","sales_channel","currency","list_price_minor","customer_price_minor","promotion_discount_minor","tax_minor","processor_fee_minor","net_receipts_minor","fore_commission_minor","royalty_pool_minor","contract_version_id","contract_version_hash","rule_key"];
  return[headers.join(","),...rows.results.map((r:any)=>headers.map(h=>csvEscape(r[h])).join(","))].join("\n");
}

export async function creatorRoyaltyCsv(db:CatalogDB,userId:string,accountId:string,rawFrom:string|null,rawTo:string|null){
  const account=await accountForUser(db,userId,accountId),p=period(rawFrom,rawTo);if(!account.finance_party_id)return "calculated_at,product_id,title,currency,royalty_minor,withholding_minor,reserve_minor,payable_minor,status,available_at,contract_version_id\n";
  const rows=await db.prepare(`SELECT c.calculated_at,c.product_id,e.title,a.currency,a.royalty_minor,a.withholding_minor,a.reserve_minor,a.payable_minor,a.status,a.available_at,c.contract_version_id FROM finance_royalty_allocations a JOIN finance_royalty_calculations c ON c.id=a.calculation_id JOIN products p ON p.id=c.product_id JOIN editions e ON e.id=p.edition_id WHERE a.party_id=? AND c.calculated_at>=? AND c.calculated_at<? ORDER BY c.calculated_at,a.id`).bind(account.finance_party_id,p.from,p.to).all<any>();
  const headers=["calculated_at","product_id","title","currency","royalty_minor","withholding_minor","reserve_minor","payable_minor","status","available_at","contract_version_id"];
  return[headers.join(","),...rows.results.map((r:any)=>headers.map(h=>csvEscape(r[h])).join(","))].join("\n");
}

export async function creatorStatementCsv(db:CatalogDB,userId:string,accountId:string,statementId:string){
  const account=await accountForUser(db,userId,accountId);
  if(!account.finance_party_id)throw new ApiError(409,"Publishing account has no finance party.");
  const statement=await db.prepare("SELECT * FROM finance_statements WHERE id=? AND party_id=?").bind(statementId,account.finance_party_id).first<any>();
  if(!statement)throw new ApiError(404,"Statement not found.");
  const revision=await db.prepare("SELECT * FROM finance_statement_revisions WHERE statement_id=? ORDER BY revision DESC LIMIT 1").bind(statementId).first<any>();
  if(!revision)throw new ApiError(409,"This statement has not been finalized yet.");
  let snapshot:any={};try{snapshot=JSON.parse(String(revision.snapshot_json||"{}"));}catch{throw new ApiError(500,"Statement snapshot is unreadable.");}
  const cutoff=String(snapshot.calculationCutoffAt||statement.calculation_cutoff_at||revision.generated_at);
  const rows=await db.prepare(`SELECT c.calculated_at,c.source_type,c.product_id,e.title,p.format,c.territory_code,c.sales_channel,c.currency,c.customer_price_minor,c.tax_minor,c.processor_fee_minor,c.publisher_funded_discount_minor,c.fore_funded_discount_minor,c.net_receipts_minor,c.fore_commission_minor,c.royalty_pool_minor,a.royalty_minor,a.withholding_minor,a.reserve_minor,a.payable_minor,c.contract_version_id,c.contract_version_hash,rr.rule_key
    FROM finance_royalty_allocations a
    JOIN finance_royalty_calculations c ON c.id=a.calculation_id
    JOIN products p ON p.id=c.product_id JOIN editions e ON e.id=p.edition_id
    LEFT JOIN finance_royalty_rules rr ON rr.id=c.rule_id
    WHERE a.party_id=? AND c.currency=? AND c.calculated_at>=? AND c.calculated_at<? AND a.created_at<=?
    ORDER BY c.calculated_at,c.id,a.id`).bind(account.finance_party_id,statement.currency,statement.period_start,statement.period_end,cutoff).all<any>();
  const headers=["row_type","statement_id","revision","snapshot_sha256","period_start","period_end","calculation_cutoff_at","summary_sales_minor","summary_refunds_minor","summary_royalties_minor","summary_withholding_minor","summary_reserve_minor","summary_payable_minor","calculated_at","source_type","product_id","title","format","territory_code","sales_channel","currency","customer_price_minor","tax_minor","processor_fee_minor","publisher_funded_discount_minor","fore_funded_discount_minor","net_receipts_minor","fore_commission_minor","royalty_pool_minor","royalty_minor","withholding_minor","reserve_minor","payable_minor","contract_version_id","contract_version_hash","rule_key"];
  const summary:any={row_type:"statement_summary",statement_id:statementId,revision:revision.revision,snapshot_sha256:revision.snapshot_sha256,period_start:statement.period_start,period_end:statement.period_end,calculation_cutoff_at:cutoff,summary_sales_minor:snapshot.salesMinor??statement.sales_minor,summary_refunds_minor:snapshot.refundsMinor??statement.refunds_minor,summary_royalties_minor:snapshot.royaltiesMinor??statement.royalties_minor,summary_withholding_minor:snapshot.withholdingMinor??statement.withholding_minor,summary_reserve_minor:snapshot.reserveMinor??statement.reserve_minor,summary_payable_minor:snapshot.payableMinor??statement.payable_minor,currency:statement.currency};
  const detail=rows.results.map((r:any)=>({row_type:"royalty_line",statement_id:statementId,revision:revision.revision,snapshot_sha256:revision.snapshot_sha256,period_start:statement.period_start,period_end:statement.period_end,calculation_cutoff_at:cutoff,...r}));
  const csv=[headers.join(","),...[summary,...detail].map((r:any)=>headers.map(h=>csvEscape(r[h])).join(","))].join("\n");
  const hash=await sha256(csv),at=now();
  await db.prepare("INSERT INTO creator_statement_exports(id,publishing_account_id,statement_id,export_type,period_start,period_end,object_key,sha256,status,generated_at) VALUES(?,?,?,'monthly_statement_csv',?,?,NULL,?,'ready',?)").bind(uid("export"),accountId,statementId,statement.period_start,statement.period_end,hash,at).run();
  return{csv,revision:Number(revision.revision),snapshotSha256:String(revision.snapshot_sha256),exportSha256:hash};
}

export async function generateMonthlyStatement(db:CatalogDB,raw:unknown){
  const x=z.object({publishingAccountId:z.string().min(1),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),currency:z.string().regex(/^[A-Za-z]{3}$/),finalize:z.boolean().default(true)}).parse(raw);if(x.periodEnd<=x.periodStart)throw new ApiError(400,"Statement end must be after start.");
  const account=await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(x.publishingAccountId).first<any>();if(!account?.finance_party_id)throw new ApiError(409,"Publishing account has no finance party.");const currency=x.currency.toUpperCase(),at=now();
  const economics=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN c.source_type='sale' THEN c.customer_price_minor ELSE 0 END),0) sales_minor,COALESCE(SUM(CASE WHEN c.source_type IN ('refund','chargeback') THEN ABS(c.customer_price_minor) ELSE 0 END),0) refunds_minor FROM finance_royalty_calculations c JOIN finance_royalty_allocations a ON a.calculation_id=c.id WHERE a.party_id=? AND c.currency=? AND c.calculated_at>=? AND c.calculated_at<?`).bind(account.finance_party_id,currency,x.periodStart,x.periodEnd).first<any>();
  const royalties=await db.prepare(`SELECT COALESCE(SUM(royalty_minor),0) royalties_minor,COALESCE(SUM(withholding_minor),0) withholding_minor,COALESCE(SUM(reserve_minor),0) reserve_minor,COALESCE(SUM(payable_minor),0) payable_minor,COUNT(*) event_count FROM finance_royalty_allocations WHERE party_id=? AND currency=? AND created_at>=? AND created_at<?`).bind(account.finance_party_id,currency,x.periodStart,x.periodEnd).first<any>();
  let statement=await db.prepare("SELECT * FROM finance_statements WHERE party_id=? AND period_start=? AND period_end=? AND currency=?").bind(account.finance_party_id,x.periodStart,x.periodEnd,currency).first<any>();const statementId=statement?.id||uid("stmt");
  const snapshot={publishingAccountId:x.publishingAccountId,partyId:account.finance_party_id,periodStart:x.periodStart,periodEnd:x.periodEnd,currency,salesMinor:Number(economics?.sales_minor||0),refundsMinor:Number(economics?.refunds_minor||0),royaltiesMinor:Number(royalties?.royalties_minor||0),withholdingMinor:Number(royalties?.withholding_minor||0),reserveMinor:Number(royalties?.reserve_minor||0),payableMinor:Number(royalties?.payable_minor||0),eventCount:Number(royalties?.event_count||0),calculationCutoffAt:at};const hash=await sha256(JSON.stringify(snapshot));
  if(!statement)await db.prepare(`INSERT INTO finance_statements(id,party_id,period_start,period_end,currency,sales_minor,refunds_minor,royalties_minor,withholding_minor,reserve_minor,payable_minor,generated_at,status,finalized_at,calculation_cutoff_at,snapshot_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(statementId,account.finance_party_id,x.periodStart,x.periodEnd,currency,snapshot.salesMinor,snapshot.refundsMinor,snapshot.royaltiesMinor,snapshot.withholdingMinor,snapshot.reserveMinor,snapshot.payableMinor,at,x.finalize?"final":"draft",x.finalize?at:null,at,hash).run();
  else await db.prepare(`UPDATE finance_statements SET sales_minor=?,refunds_minor=?,royalties_minor=?,withholding_minor=?,reserve_minor=?,payable_minor=?,generated_at=?,status=?,finalized_at=CASE WHEN ? THEN ? ELSE finalized_at END,calculation_cutoff_at=?,snapshot_sha256=? WHERE id=?`).bind(snapshot.salesMinor,snapshot.refundsMinor,snapshot.royaltiesMinor,snapshot.withholdingMinor,snapshot.reserveMinor,snapshot.payableMinor,at,x.finalize?"final":"draft",x.finalize?1:0,at,at,hash,statementId).run();
  if(x.finalize){const revision=Number((await db.prepare("SELECT COALESCE(MAX(revision),0)+1 n FROM finance_statement_revisions WHERE statement_id=?").bind(statementId).first<any>())?.n||1);await db.prepare("INSERT INTO finance_statement_revisions(id,statement_id,revision,status,snapshot_json,snapshot_sha256,generated_at) VALUES(?,?,?,?,?,?,?)").bind(uid("stmtrev"),statementId,revision,revision===1?"final":"corrected",JSON.stringify(snapshot),hash,at).run();try{const members=(await db.prepare("SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','analyst')").bind(x.publishingAccountId).all<any>()).results;for(const m of members)await emitNotification(db,{userId:String(m.user_id),eventType:"royalty_statement_ready",dedupeKey:`royalty-statement:${statementId}:${revision}:${m.user_id}`,title:"Royalty statement ready",body:`Your ${currency} royalty statement for ${x.periodStart.slice(0,10)} through ${x.periodEnd.slice(0,10)} is ready.`,subjectType:"finance_statement",subjectId:statementId,actionUrl:"/publishing",payload:{statementId,revision,currency,periodStart:x.periodStart,periodEnd:x.periodEnd,payableMinor:snapshot.payableMinor}});}catch(e){console.error("Royalty statement notification enqueue failed",e);}}
  return{statementId,snapshotSha256:hash,...snapshot};
}

export async function refreshCreatorDailyMetrics(db:CatalogDB,raw:unknown){
  const x=z.object({from:z.string().datetime(),to:z.string().datetime()}).parse(raw);if(x.to<=x.from)throw new ApiError(400,"Metrics end must be after start.");
  const accounts=(await db.prepare("SELECT id FROM publishing_accounts WHERE publisher_id IS NOT NULL").all<any>()).results;let rows=0;
  for(const a of accounts){const d=new Date(x.from);while(d.toISOString()<x.to){const day=d.toISOString().slice(0,10),next=new Date(d.getTime()+86400000).toISOString(),items=(await db.prepare(`SELECT rc.product_id,COALESCE(rc.territory_code,'') territory_code,COALESCE(rc.format,'') format,rc.currency,SUM(CASE WHEN rc.source_type='sale' THEN 1 ELSE 0 END) sales_units,SUM(CASE WHEN rc.source_type='refund' THEN 1 ELSE 0 END) refund_units,SUM(CASE WHEN rc.source_type='sale' THEN rc.customer_price_minor ELSE 0 END) gross_revenue_minor,SUM(CASE WHEN rc.source_type='sale' THEN rc.promotion_discount_minor ELSE 0 END) discounts_minor,SUM(CASE WHEN rc.source_type IN ('refund','chargeback') THEN ABS(rc.customer_price_minor) ELSE 0 END) refunds_minor,SUM(CASE WHEN rc.source_type='sale' THEN rc.tax_minor ELSE 0 END) tax_minor,SUM(CASE WHEN rc.source_type='sale' THEN rc.net_receipts_minor ELSE 0 END) net_revenue_minor FROM finance_royalty_calculations rc WHERE EXISTS (SELECT 1 FROM publishing_publications pp WHERE pp.product_id=rc.product_id AND pp.publishing_account_id=?) AND rc.calculated_at>=? AND rc.calculated_at<? GROUP BY rc.product_id,rc.territory_code,rc.format,rc.currency`).bind(a.id,d.toISOString(),next).all<any>()).results;
      for(const r of items){const royalties=Number((await db.prepare(`SELECT COALESCE(SUM(ra.royalty_minor),0) n FROM finance_royalty_allocations ra JOIN finance_royalty_calculations rc ON rc.id=ra.calculation_id JOIN publishing_accounts pa ON pa.finance_party_id=ra.party_id WHERE pa.id=? AND rc.product_id=? AND rc.calculated_at>=? AND rc.calculated_at<?`).bind(a.id,r.product_id,d.toISOString(),next).first<any>())?.n||0);const preorderUnits=Number((await db.prepare(`SELECT COUNT(*) n FROM preorders pr JOIN preorder_release_plans rp ON rp.id=pr.release_plan_id JOIN publishing_edition_drafts ped ON ped.id=rp.publishing_edition_id JOIN publishing_titles pt ON pt.id=ped.title_id WHERE pt.account_id=? AND pr.product_id=? AND pr.created_at>=? AND pr.created_at<?`).bind(a.id,r.product_id,d.toISOString(),next).first<any>())?.n||0);const usage=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN source_type LIKE 'subscription_%' THEN units ELSE 0 END),0) subscription_units,COALESCE(SUM(CASE WHEN source_type='subscription_read' THEN pages_read ELSE 0 END),0) subscription_pages,COALESCE(SUM(CASE WHEN source_type IN ('subscription_listen','library_listen') THEN seconds_consumed ELSE 0 END),0) audiobook_seconds,COALESCE(SUM(CASE WHEN source_type LIKE 'library_%' THEN units ELSE 0 END),0) library_units FROM finance_usage_events WHERE product_id=? AND occurred_at>=? AND occurred_at<?`).bind(r.product_id,d.toISOString(),next).first<any>();const wish=Number((await db.prepare("SELECT COUNT(*) n FROM wishlist_events WHERE product_id=? AND event_type IN ('add','saved','wishlist_add') AND created_at>=? AND created_at<?").bind(r.product_id,d.toISOString(),next).first<any>())?.n||0);const promo=await db.prepare(`SELECT SUM(CASE WHEN event_type='impression' THEN 1 ELSE 0 END) impressions,SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) clicks,SUM(CASE WHEN event_type='order' THEN 1 ELSE 0 END) orders FROM promotion_attribution_events WHERE product_id=? AND created_at>=? AND created_at<?`).bind(r.product_id,d.toISOString(),next).first<any>();await db.prepare(`INSERT INTO creator_daily_metrics(publishing_account_id,metric_date,product_id,territory_code,format,currency,sales_units,preorder_units,refund_units,gross_revenue_minor,discounts_minor,refunds_minor,tax_minor,net_revenue_minor,royalties_minor,subscription_units,subscription_pages,audiobook_seconds,library_units,wishlist_adds,promotion_impressions,promotion_clicks,promotion_orders,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(publishing_account_id,metric_date,product_id,territory_code,format,currency) DO UPDATE SET sales_units=excluded.sales_units,preorder_units=excluded.preorder_units,refund_units=excluded.refund_units,gross_revenue_minor=excluded.gross_revenue_minor,discounts_minor=excluded.discounts_minor,refunds_minor=excluded.refunds_minor,tax_minor=excluded.tax_minor,net_revenue_minor=excluded.net_revenue_minor,royalties_minor=excluded.royalties_minor,subscription_units=excluded.subscription_units,subscription_pages=excluded.subscription_pages,audiobook_seconds=excluded.audiobook_seconds,library_units=excluded.library_units,wishlist_adds=excluded.wishlist_adds,promotion_impressions=excluded.promotion_impressions,promotion_clicks=excluded.promotion_clicks,promotion_orders=excluded.promotion_orders,updated_at=excluded.updated_at`).bind(a.id,day,r.product_id,r.territory_code,r.format,r.currency,r.sales_units||0,preorderUnits,r.refund_units||0,r.gross_revenue_minor||0,r.discounts_minor||0,r.refunds_minor||0,r.tax_minor||0,r.net_revenue_minor||0,royalties,usage?.subscription_units||0,usage?.subscription_pages||0,usage?.audiobook_seconds||0,usage?.library_units||0,wish,promo?.impressions||0,promo?.clicks||0,promo?.orders||0,now()).run();rows++;}d.setUTCDate(d.getUTCDate()+1);}}
  return{rows,accounts:accounts.length,from:x.from,to:x.to};
}


export async function creatorTaxDocumentRecord(db:CatalogDB,userId:string,accountId:string,documentId:string){await accountForUser(db,userId,accountId);const row=await db.prepare("SELECT * FROM creator_tax_documents WHERE id=? AND publishing_account_id=?").bind(documentId,accountId).first<any>();if(!row)throw new ApiError(404,"Tax document not found.");if(row.status!=="available"&&row.status!=="corrected")throw new ApiError(409,"Tax document is not available for download.");if(!row.object_key)throw new ApiError(409,"Tax document file is not available.");return row;}


export async function registerCreatorTaxDocument(db:CatalogDB,raw:unknown){
  const x=z.object({
    publishingAccountId:z.string().min(1),
    taxYear:z.number().int().min(2000).max(2200),
    jurisdiction:z.string().trim().min(2).max(80),
    documentType:z.string().trim().min(1).max(80),
    status:z.enum(["pending","available","corrected","void"]).default("available"),
    objectKey:z.string().trim().min(1).max(500),
    sourceProvider:z.string().trim().min(1).max(120),
    sourceReference:z.string().trim().min(1).max(240),
    sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),
    mimeType:z.string().trim().min(3).max(120).default("application/pdf"),
    availableAt:z.string().datetime().nullable().optional(),
  }).parse(raw);
  const account=await db.prepare("SELECT id FROM publishing_accounts WHERE id=?").bind(x.publishingAccountId).first<any>();
  if(!account)throw new ApiError(404,"Publishing account not found.");
  const at=now(),id=uid("taxdoc");
  await db.prepare(`INSERT INTO creator_tax_documents(id,publishing_account_id,tax_year,jurisdiction,document_type,status,object_key,available_at,created_at,source_provider,source_reference,sha256,mime_type)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_provider,source_reference) WHERE source_provider<>'' AND source_reference<>''
    DO NOTHING`).bind(id,x.publishingAccountId,x.taxYear,x.jurisdiction,x.documentType,x.status,x.objectKey,x.availableAt||at,at,x.sourceProvider,x.sourceReference,x.sha256.toLowerCase(),x.mimeType).run();
  const row=await db.prepare("SELECT id,status,available_at FROM creator_tax_documents WHERE source_provider=? AND source_reference=?").bind(x.sourceProvider,x.sourceReference).first<any>();
  return{documentId:row?.id||id,status:row?.status||x.status,availableAt:row?.available_at||x.availableAt||at};
}
