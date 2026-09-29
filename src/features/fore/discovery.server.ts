import { ApiError } from "./service";
import { canonicalBooksByProductIds, type CatalogDB } from "./catalog-model.server";
import { effectiveOffer } from "./retail.server";
import { resolveProductRights } from "./rights.server";

function now(){return new Date().toISOString();}
function placeholders(n:number){return Array.from({length:n},()=>"?").join(",");}

export async function resolveEntityId(db:CatalogDB,type:"author"|"publisher"|"imprint"|"series",ref:string){
  const table=type==="author"?"contributors":type==="publisher"?"publishers":type==="imprint"?"imprints":"series";
  const direct=await db.prepare(`SELECT id FROM ${table} WHERE id=? LIMIT 1`).bind(ref).first<any>();
  if(direct)return String(direct.id);
  const alias=await db.prepare("SELECT entity_id FROM catalog_entity_slugs WHERE entity_type=? AND slug=? LIMIT 1").bind(type,ref.toLowerCase()).first<any>();
  if(alias)return String(alias.entity_id);
  const row=await db.prepare(`SELECT id FROM ${table} WHERE lower(slug)=lower(?) AND slug<>'' LIMIT 1`).bind(ref).first<any>();
  if(row)return String(row.id);
  throw new ApiError(404,`This ${type} does not exist.`);
}

export async function canonicalEntitySlug(db:CatalogDB,type:"author"|"publisher"|"imprint"|"series",entityId:string){
  const alias=await db.prepare("SELECT slug FROM catalog_entity_slugs WHERE entity_type=? AND entity_id=? AND canonical=1 LIMIT 1").bind(type,entityId).first<any>();
  if(alias?.slug)return String(alias.slug);
  const table=type==="author"?"contributors":type==="publisher"?"publishers":type==="imprint"?"imprints":"series";
  const row=await db.prepare(`SELECT slug FROM ${table} WHERE id=? LIMIT 1`).bind(entityId).first<any>();
  return String(row?.slug||entityId);
}

export async function editionResolve(db:CatalogDB,editionId:string){
  const resolved=await db.prepare(`SELECT e.id FROM editions e WHERE e.public_id=? OR e.id=?
      UNION SELECT a.entity_id FROM catalog_public_aliases a WHERE a.entity_type='edition' AND a.alias=?
      UNION SELECT x.entity_id FROM external_identifiers x WHERE x.entity_type='edition' AND x.value=?
      LIMIT 1`).bind(editionId,editionId,editionId,editionId).first<any>();
  const internalEditionId=resolved?String(resolved.id):editionId;
  const row=await db.prepare(`SELECT p.id product_id,p.public_id product_public_id,p.source_external_id,p.format,e.id edition_id,e.public_id edition_public_id,e.work_id,w.public_id work_public_id,e.title,e.subtitle,e.language,e.edition_number,e.isbn13,e.publication_date,e.release_date,e.edition_type,e.differentiation_status,e.differentiation_summary,e.canonical_public_domain,
      pub.id publisher_id,pub.name publisher_name,pub.slug publisher_slug,imp.id imprint_id,imp.name imprint_name,imp.slug imprint_slug
    FROM editions e JOIN products p ON p.edition_id=e.id JOIN works w ON w.id=e.work_id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id
    WHERE e.id=? AND p.storefront_status IN ('active','private') ORDER BY CASE p.storefront_status WHEN 'active' THEN 0 ELSE 1 END,p.created_at LIMIT 1`).bind(internalEditionId).first<any>();
  if(!row)throw new ApiError(404,"This edition does not exist.");
  const others=await db.prepare("SELECT e.id edition_id,e.public_id edition_public_id,p.source_external_id,p.id product_id,p.public_id product_public_id,e.language,e.edition_number,e.publication_date,e.release_date,e.edition_type,e.differentiation_status,e.differentiation_summary,e.canonical_public_domain,p.format,pub.name publisher,imp.name imprint FROM editions e JOIN products p ON p.edition_id=e.id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id WHERE e.work_id=? AND p.storefront_status='active' ORDER BY COALESCE(e.release_date,e.publication_date,'9999') DESC,e.id LIMIT 50").bind(row.work_id).all<any>();
  const contributors=await db.prepare("SELECT c.id,c.name,c.slug,ec.role,ec.position FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=? ORDER BY ec.position LIMIT 50").bind(row.edition_id).all<any>();
  return{editionId:String(row.edition_public_id||row.edition_id),internalEditionId:String(row.edition_id),productId:String(row.product_id),publicProductId:String(row.product_public_id||row.product_id),externalBookId:String(row.source_external_id),workId:String(row.work_public_id||row.work_id),internalWorkId:String(row.work_id),edition:{title:String(row.title||"Untitled"),subtitle:String(row.subtitle||""),format:String(row.format||"ebook"),language:String(row.language||"en"),editionNumber:String(row.edition_number||""),isbn13:String(row.isbn13||""),publicationDate:row.publication_date||null,releaseDate:row.release_date||null,editionType:String(row.edition_type||"original"),differentiationStatus:String(row.differentiation_status||"not_required"),differentiationSummary:String(row.differentiation_summary||""),canonicalPublicDomain:!!row.canonical_public_domain,publisher:row.publisher_id?{id:String(row.publisher_id),name:String(row.publisher_name||""),slug:String(row.publisher_slug||row.publisher_id)}:null,imprint:row.imprint_id?{id:String(row.imprint_id),name:String(row.imprint_name||""),slug:String(row.imprint_slug||row.imprint_id)}:null,contributors:contributors.results.map((c:any)=>({id:String(c.id),name:String(c.name),slug:String(c.slug||c.id),role:String(c.role||"author"),position:Number(c.position||0)}))},otherEditions:others.results.map((r:any)=>({...r,editionId:String(r.edition_public_id||r.edition_id),productId:String(r.product_id),publicProductId:String(r.product_public_id||r.product_id)}))};
}

export async function workDetail(db:CatalogDB,workRef:string,userId:string|null,territory="US") {
  const resolved=await db.prepare(`SELECT id FROM works WHERE public_id=? OR id=?
      UNION SELECT entity_id id FROM catalog_public_aliases WHERE entity_type='work' AND alias=?
      UNION SELECT entity_id id FROM external_identifiers WHERE entity_type='work' AND value=?
      LIMIT 1`).bind(workRef,workRef,workRef,workRef).first<any>();
  let workId=resolved?String(resolved.id):workRef;
  const redirect=await db.prepare("SELECT canonical_work_id FROM work_redirects WHERE old_work_id=?").bind(workId).first<any>();
  if(redirect?.canonical_work_id)workId=String(redirect.canonical_work_id);
  const work=await db.prepare("SELECT * FROM works WHERE id=? AND canonical_status<>'redirected'").bind(workId).first<any>();
  if(!work)throw new ApiError(404,"This work does not exist.");
  const workContributors=(await db.prepare(`SELECT c.id,c.name,c.slug,wc.role,wc.position FROM work_contributors wc JOIN contributors c ON c.id=wc.contributor_id WHERE wc.work_id=? ORDER BY wc.position,c.name LIMIT 100`).bind(workId).all<any>()).results;
  const rows=(await db.prepare(`SELECT e.id edition_id,e.public_id edition_public_id,e.title,e.subtitle,e.edition_number,e.language,e.publication_date,e.release_date,e.isbn13,e.edition_type,e.differentiation_status,e.differentiation_summary,e.canonical_public_domain,p.id product_id,p.public_id product_public_id,p.source_external_id,p.format,p.source_name,pub.name publisher_name,imp.name imprint_name
    FROM editions e JOIN products p ON p.edition_id=e.id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id
    WHERE e.work_id=? AND p.storefront_status='active' ORDER BY e.canonical_public_domain DESC,CASE e.edition_type WHEN 'canonical_public_domain' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,COALESCE(e.release_date,e.publication_date,'9999') DESC,e.created_at`).bind(workId).all<any>()).results;
  const productIds=rows.map((r:any)=>String(r.product_id));
  const [offers,rights]=await Promise.all([Promise.all(productIds.map(pid=>effectiveOffer(db,pid,territory))),Promise.all(productIds.map(pid=>resolveProductRights(db,pid,territory,{salesChannel:"retail"})))]);
  const at=now();let owned=new Set<string>();
  if(userId&&productIds.length){const q=placeholders(productIds.length),ents=await db.prepare(`SELECT DISTINCT product_id FROM entitlements WHERE user_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) AND product_id IN (${q})`).bind(userId,at,at,...productIds).all<any>();owned=new Set(ents.results.map((r:any)=>String(r.product_id)));}
  const editionIds=rows.map((r:any)=>String(r.edition_id));
  const contributors=editionIds.length?(await db.prepare(`SELECT ec.edition_id,c.id,c.name,c.slug,ec.role,ec.position FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id IN (${placeholders(editionIds.length)}) ORDER BY ec.edition_id,ec.position`).bind(...editionIds).all<any>()).results:[];
  const byEdition=new Map<string,any[]>();for(const c of contributors){const a=byEdition.get(String(c.edition_id))||[];a.push({id:String(c.id),name:String(c.name),slug:String(c.slug||c.id),role:String(c.role),position:Number(c.position||0)});byEdition.set(String(c.edition_id),a);}
  const editions=rows.map((r:any,i:number)=>({editionId:String(r.edition_public_id||r.edition_id),internalEditionId:String(r.edition_id),productId:String(r.product_id),publicProductId:String(r.product_public_id||r.product_id),externalBookId:String(r.source_external_id),title:String(r.title||work.title),subtitle:String(r.subtitle||""),editionNumber:String(r.edition_number||""),language:String(r.language||"en"),format:String(r.format||"ebook"),sourceName:String(r.source_name||""),publicationDate:r.publication_date||null,releaseDate:r.release_date||null,isbn13:r.isbn13?String(r.isbn13):null,editionType:String(r.edition_type||"original"),differentiationStatus:String(r.differentiation_status||"not_required"),differentiationSummary:String(r.differentiation_summary||""),canonicalPublicDomain:!!r.canonical_public_domain,publisher:String(r.publisher_name||""),imprint:String(r.imprint_name||""),contributors:byEdition.get(String(r.edition_id))||[],offer:rights[i]?.allowed?(offers[i]||null):null,availableInTerritory:!!rights[i]?.allowed,rightsReason:String(rights[i]?.reasonCode||""),owned:owned.has(String(r.product_id))}));
  // Legacy Gutenberg/Librivox recordings are an edition family of the same Work, not a
  // separate top-level title. Keep their US-only public-domain policy explicit until
  // each source has jurisdiction-specific rights evidence like commercial audio does.
  const audioBookIds=[...new Set(rows.filter((r:any)=>String(r.source_name||"")==="gutenberg"&&String(r.source_external_id||"")).map((r:any)=>String(r.source_external_id)))];
  const legacyAudio=territory.toUpperCase()==="US"&&audioBookIds.length
    ?(await db.prepare(`SELECT id,gutenberg_id,book_id,title,authors_json,language,narration,narrator,rights,updated_at FROM audio_editions WHERE book_id IN (${placeholders(audioBookIds.length)}) ORDER BY CASE narration WHEN 'human' THEN 0 ELSE 1 END,title,id LIMIT 100`).bind(...audioBookIds).all<any>()).results
    :[];
  const audioEditions=legacyAudio.map((r:any)=>({id:String(r.id),gutenbergId:String(r.gutenberg_id||""),bookId:String(r.book_id||""),title:String(r.title||work.title),authors:(()=>{try{return JSON.parse(String(r.authors_json||"[]"));}catch{return[];}})(),language:String(r.language||"en"),narration:String(r.narration||"human"),narrator:String(r.narrator||""),rights:String(r.rights||""),updatedAt:String(r.updated_at||"")}));
  return {work:{id:String(work.public_id||work.id),internalId:String(work.id),title:String(work.title||"Untitled"),subtitle:String(work.subtitle||""),description:String(work.description||""),originalLanguage:String(work.original_language||""),workType:String(work.work_type||"original"),canonicalStatus:String(work.canonical_status||"canonical"),contributors:workContributors.map((c:any)=>({id:String(c.id),name:String(c.name),slug:String(c.slug||c.id),role:String(c.role||"author"),position:Number(c.position||0)}))},editions,audioEditions,canonicalEditionId:editions.find((e:any)=>e.canonicalPublicDomain)?.editionId||editions[0]?.editionId||null,redirectedFrom:workRef===String(work.public_id||work.id)||workRef===workId?null:workRef,generatedAt:now()};
}

export async function seriesDetail(db:CatalogDB,ref:string,userId:string|null,territory="US"){
  const id=await resolveEntityId(db,"series",ref);
  const series=await db.prepare("SELECT s.*,p.name publisher_name,p.slug publisher_slug FROM series s LEFT JOIN publishers p ON p.id=s.publisher_id WHERE s.id=? AND s.status<>'archived' LIMIT 1").bind(id).first<any>();
  if(!series)throw new ApiError(404,"This series does not exist.");
  const rows=await db.prepare(`SELECT sm.*,e.work_id,p.id product_id,p.source_external_id,p.format,e.release_status,e.release_date,e.publication_date
    FROM series_memberships sm JOIN editions e ON e.id=sm.edition_id JOIN products p ON p.edition_id=e.id
    WHERE sm.series_id=? AND p.storefront_status='active'
    ORDER BY CASE sm.relationship WHEN 'main' THEN 0 WHEN 'prequel' THEN 1 WHEN 'novella' THEN 2 WHEN 'companion' THEN 3 WHEN 'boxset' THEN 4 ELSE 5 END,
      COALESCE(sm.reading_order,sm.position,999999),sm.display_order,COALESCE(e.release_date,e.publication_date,'9999'),e.title LIMIT 100`).bind(id).all<any>();
  const productIds=rows.results.map((r:any)=>String(r.product_id));
  const books=await canonicalBooksByProductIds(db,productIds),bookByProduct=new Map(books.map(b=>[String(b.productId),b]));
  let states=new Map<string,any>(),wish=new Set<string>(),ownedProducts=new Set<string>(),channels=new Map<string,Set<string>>();
  if(productIds.length){
    const p=placeholders(productIds.length);
    const channelRows=await db.prepare(`SELECT product_id,sales_channel FROM product_channel_availability WHERE territory_code=upper(?) AND product_id IN (${p}) AND sales_channel IN ('subscription','library')`).bind(territory,...productIds).all<any>();
    for(const r of channelRows.results){const key=String(r.product_id),set=channels.get(key)||new Set<string>();set.add(String(r.sales_channel));channels.set(key,set);}
    if(userId){
      const at=now();
      const [stateRows,wishRows,entitlementRows]=await Promise.all([
        db.prepare(`SELECT product_id,status,progress,cfi,in_library,updated_at FROM reading_states WHERE user_id=? AND product_id IN (${p})`).bind(userId,...productIds).all<any>(),
        db.prepare(`SELECT product_id FROM wishlist_items WHERE user_id=? AND product_id IN (${p}) AND converted_at IS NULL`).bind(userId,...productIds).all<any>(),
        db.prepare(`SELECT DISTINCT product_id FROM entitlements WHERE user_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) AND product_id IN (${p})`).bind(userId,at,at,...productIds).all<any>(),
      ]);
      states=new Map(stateRows.results.map((r:any)=>[String(r.product_id),r]));wish=new Set(wishRows.results.map((r:any)=>String(r.product_id)));ownedProducts=new Set(entitlementRows.results.map((r:any)=>String(r.product_id)));
    }
  }
  const offers=await Promise.all(productIds.map(pid=>effectiveOffer(db,pid,territory)));
  const members=rows.results.map((r:any,i:number)=>{
    const productId=String(r.product_id),state=states.get(productId),channel=channels.get(productId)||new Set<string>();
    return{book:bookByProduct.get(productId),productId,editionId:String(r.edition_id),workId:String(r.work_id),relationship:String(r.relationship||"main"),position:r.position==null?null:Number(r.position),readingOrder:r.reading_order==null?(r.position==null?null:Number(r.position)):Number(r.reading_order),label:String(r.label||""),displayOrder:Number(r.display_order||0),owned:ownedProducts.has(productId)||!!state?.in_library,readingStatus:state?.status||null,progress:Number(state?.progress||0),unread:!state||state.status!=="finished",wishlist:wish.has(productId),offer:offers[i],subscriptionAvailable:channel.has("subscription"),libraryAvailable:channel.has("library"),releaseStatus:String(r.release_status||"available")};
  }).filter((m:any)=>m.book);
  const main=members.filter((m:any)=>m.relationship==="main");
  const nextUnread=main.find((m:any)=>m.unread&&(m.offer||m.owned||m.subscriptionAvailable||m.libraryAvailable))||null;
  const missing=main.filter((m:any)=>!m.owned);
  const purchasable=missing.filter((m:any)=>m.offer&&Number(m.offer.amountMinor)>0&&m.releaseStatus!=="preorder");
  const currencies=new Set(purchasable.map((m:any)=>m.offer.currency));
  const uniqueWorks=new Set(main.map((m:any)=>m.workId));
  const bulkEligible=missing.length>=1&&main.length<=25&&purchasable.length===missing.length&&uniqueWorks.size===main.length&&currencies.size===1;
  return{
    series:{id:String(series.id),name:String(series.name),slug:String(series.slug||""),canonicalPath:`/series/${encodeURIComponent(String(series.slug||series.id))}`,description:String(series.description||""),seriesType:String(series.series_type||"ordered"),heroImageUrl:String(series.hero_image_url||""),publisherId:series.publisher_id?String(series.publisher_id):null,publisherSlug:series.publisher_slug?String(series.publisher_slug):null,publisherName:String(series.publisher_name||"")},
    members,nextUnread,
    groups:{main:main.length,prequels:members.filter((m:any)=>m.relationship==="prequel").length,novellas:members.filter((m:any)=>m.relationship==="novella").length,related:members.filter((m:any)=>!["main","prequel","novella"].includes(m.relationship)).length},
    bulkPurchase:{eligible:bulkEligible,productIds:bulkEligible?missing.map((m:any)=>m.productId):[],currency:bulkEligible?[...currencies][0]:null,totalMinor:bulkEligible?missing.reduce((n:number,m:any)=>n+Number(m.offer.amountMinor),0):0,reason:bulkEligible?null:missing.length===0?"You already own every main title.":main.length>25?"Series has more than 25 main titles.":uniqueWorks.size!==main.length?"Series contains multiple editions of the same work.":purchasable.length!==missing.length?"Every unowned main title must currently be individually purchasable.":currencies.size>1?"Series titles resolve to different currencies.":"No eligible titles are available for bulk purchase."},
    generatedAt:now(),
  };
}

export async function addSeriesToCart(db:CatalogDB,ref:string,userId:string,territory="US"){
  const detail=await seriesDetail(db,ref,userId,territory);
  if(!detail.bulkPurchase.eligible)throw new ApiError(409,detail.bulkPurchase.reason||"This series is not eligible for bulk purchase.");
  const at=now(),currency=String(detail.bulkPurchase.currency),ids=detail.bulkPurchase.productIds;
  let cart=await db.prepare("SELECT id,currency FROM shopping_carts WHERE user_id=?").bind(userId).first<any>();
  if(cart?.currency&&String(cart.currency)!==currency)throw new ApiError(409,`Your cart is in ${cart.currency}. Complete or clear it before adding this ${currency} series.`);
  const cartId=cart?.id?String(cart.id):`cart_${crypto.randomUUID()}`;
  const byId=new Map(detail.members.map((m:any)=>[m.productId,m]));
  const statements:any[]=[];
  if(!cart)statements.push(db.prepare("INSERT INTO shopping_carts(id,user_id,currency,created_at,updated_at) VALUES(?,?,?,?,?)").bind(cartId,userId,currency,at,at));
  else statements.push(db.prepare("UPDATE shopping_carts SET currency=COALESCE(currency,?),updated_at=? WHERE id=?").bind(currency,at,cartId));
  for(const productId of ids){const m:any=byId.get(productId);if(!m?.offer)throw new ApiError(409,"Series pricing changed. Refresh and try again.");statements.push(db.prepare(`INSERT INTO shopping_cart_items(cart_id,product_id,offer_id,price_snapshot_minor,currency,source_surface,source_request_id,added_at,updated_at) VALUES(?,?,?,?,?,'series-page',?,?,?) ON CONFLICT(cart_id,product_id) DO UPDATE SET offer_id=excluded.offer_id,price_snapshot_minor=excluded.price_snapshot_minor,currency=excluded.currency,source_surface='series-page',updated_at=excluded.updated_at`).bind(cartId,productId,m.offer.id,m.offer.amountMinor,m.offer.currency,detail.series.id,at,at));}
  await db.batch(statements);
  return{added:ids.length,cartId,currency,totalMinor:detail.bulkPurchase.totalMinor,seriesId:detail.series.id};
}

export async function readingDataExport(db:CatalogDB,userId:string,externalBookId:string,exportKind:"reading-data"|"private-backup"="reading-data"){
  const product=await db.prepare("SELECT id,edition_id FROM products WHERE source_external_id=? LIMIT 1").bind(externalBookId).first<any>();
  if(!product)throw new ApiError(404,"This edition does not exist.");
  const [state,annotations,definitions,sessions,completions,preview,biosync]=await Promise.all([
    db.prepare("SELECT external_book_id,status,progress,cfi,legacy_shelves_json,updated_at FROM reading_states WHERE user_id=? AND product_id=?").bind(userId,product.id).first<any>(),
    db.prepare("SELECT id,book_id,book_title,author,quote,cfi,chapter,color,note,version,created_at,updated_at FROM annotations WHERE user_id=? AND book_id=? AND deleted_at IS NULL ORDER BY created_at").bind(userId,externalBookId).all<any>(),
    db.prepare("SELECT id,word,phonetic,meaning,part_of_speech,book_id,book_title,cfi,context,source,created_at FROM definitions WHERE user_id=? AND book_id=? ORDER BY created_at").bind(userId,externalBookId).all<any>(),
    db.prepare("SELECT id,book_id,mode,started_at,ended_at,active_seconds,words_read FROM reading_sessions WHERE user_id=? AND book_id=? ORDER BY started_at").bind(userId,externalBookId).all<any>(),
    db.prepare("SELECT id,finished_at FROM completion_events WHERE user_id=? AND product_id=? ORDER BY finished_at").bind(userId,product.id).all<any>(),
    db.prepare("SELECT cfi,sample_progress,started_at,updated_at,converted_at FROM preview_states WHERE user_id=? AND product_id=?").bind(userId,product.id).first<any>(),
    db.prepare("SELECT mode,cfi,track_id,seconds,updated_at FROM biosync_positions WHERE user_id=? AND book_id=?").bind(userId,externalBookId).first<any>(),
  ]);
  const exportedAt=now();
  await db.prepare("INSERT INTO personal_export_events(id,user_id,product_id,external_book_id,export_kind,requested_at) VALUES(?,?,?,?,?,?)").bind(`pexp_${crypto.randomUUID()}`,userId,product.id,externalBookId,exportKind,exportedAt).run();
  return{format:"fore-reading-data",version:2,exportedAt,bookId:externalBookId,editionId:String(product.edition_id),readingState:state||null,annotations:annotations.results,definitions:definitions.results,sessions:sessions.results,completionHistory:completions.results,previewState:preview||null,biosync:biosync||null,privacy:{containsPersonalData:true,containsBookContent:false,sharingWarning:"This export can contain private highlights, notes, vocabulary, reading history, and reading positions. Review it before sharing."}};
}
