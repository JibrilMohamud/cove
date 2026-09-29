import { z } from "zod";
import { ApiError } from "./service";
import { canonicalBooksByProductIds, getCanonicalBook, resolveProduct, type CatalogDB } from "./catalog-model.server";
import { resolvePricingDecision } from "./pricing.server";
import { resolveProductRights, resolveRightsDecision } from "./rights.server";
import { assertPreorderPurchaseAllowed, preorderPurchaseState } from "./preorder.server";
import { recordRetailEvent } from "./retail-intelligence.server";
import { emitNotification } from "./notifications.server";
import { recordSyncProjection } from "./sync.server";

const now = () => new Date().toISOString();
const territorySchema = z.string().regex(/^[A-Z]{2}$/).default("US");

export type EffectiveOffer = {
  id:string; type:string; currency:string; amountMinor:number; listAmountMinor:number; taxBehavior:string; taxCode:string;
  promotion:null|{id:string;campaignId:string|null;name:string;type:string;endsAt:string};
};

export async function hasRetailRights(db:CatalogDB, editionId:string, format:string, territory:string) {
  return (await resolveRightsDecision(db,{editionId,format,territory:territory.toUpperCase(),salesChannel:"retail"})).allowed;
}

export async function effectiveOffer(db:CatalogDB, productId:string, territory="US"):Promise<EffectiveOffer|null>{
  const d=await resolvePricingDecision(db,productId,territory);if(!d)return null;
  return{id:d.offerId,type:"retail",currency:d.currency,amountMinor:d.amountMinor,listAmountMinor:d.listAmountMinor,taxBehavior:d.taxBehavior,taxCode:d.taxCode,promotion:d.promotion?{id:d.promotion.id,campaignId:d.promotion.campaignId||null,name:d.promotion.name,type:d.promotion.type,endsAt:d.promotion.endsAt}:null};
}

export async function activeEntitlement(db:CatalogDB,userId:string|null,productId:string){
  if(!userId)return false;const at=now();
  return !!(await db.prepare(`SELECT 1 ok FROM entitlements WHERE user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1`).bind(userId,productId,at,at).first<any>());
}

async function territorialChannelFlags(db:CatalogDB,productId:string,territory:string){
  const rows=await db.prepare(`SELECT sales_channel FROM product_channel_availability WHERE product_id=? AND territory_code=upper(?) AND sales_channel IN ('subscription','library')`).bind(productId,territory).all<any>();
  const channels=new Set(rows.results.map((r:any)=>String(r.sales_channel)));
  return{subscriptionEligible:channels.has('subscription'),libraryEligible:channels.has('library')};
}

export async function productDetail(db:CatalogDB,externalId:string,userId:string|null,territory="US"){
  const book=await getCanonicalBook(db,externalId,userId||undefined);if(!book||!book.productId||!book.editionId)throw new ApiError(404,"This edition is unavailable.");
  const product=await resolveProduct(db,externalId,userId||undefined),at=now();
  const [offer,entitled,ratings,rankingRows,taxonomyRows,policy,wishlist]=await Promise.all([
    effectiveOffer(db,product.id,territory),activeEntitlement(db,userId,product.id),
    db.prepare(`SELECT COUNT(*) review_count,AVG(rating_steps)/2.0 average_rating,SUM(CASE WHEN rating_steps=10 THEN 1 ELSE 0 END) five_star,SUM(CASE WHEN rating_steps=8 THEN 1 ELSE 0 END) four_star,SUM(CASE WHEN rating_steps=6 THEN 1 ELSE 0 END) three_star,SUM(CASE WHEN rating_steps=4 THEN 1 ELSE 0 END) two_star,SUM(CASE WHEN rating_steps=2 THEN 1 ELSE 0 END) one_star FROM reviews WHERE book_id=? AND visibility='public' AND moderation='visible' AND rating_steps IS NOT NULL`).bind(String(book.sourceExternalId || book.id)).first<any>(),
    db.prepare("SELECT ranking_scope,ranking_key,rank,window,updated_at FROM product_rankings WHERE product_id=? ORDER BY ranking_scope,rank LIMIT 12").bind(product.id).all<any>(),
    db.prepare(`SELECT n.id,n.name,n.path,n.depth,etn.is_primary FROM edition_taxonomy_nodes etn JOIN storefront_taxonomy_nodes n ON n.id=etn.taxonomy_node_id WHERE etn.edition_id=? AND n.visible=1 ORDER BY etn.is_primary DESC,n.depth DESC LIMIT 20`).bind(book.editionId).all<any>(),
    db.prepare(`SELECT * FROM preview_policies WHERE edition_id=? AND enabled=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`).bind(book.editionId,at,at).first<any>(),
    userId?db.prepare("SELECT * FROM wishlist_items WHERE user_id=? AND product_id=?").bind(userId,product.id).first<any>():Promise.resolve(null),
  ]);
  const source=String(product.source_name),publicDomain=source==="gutenberg";
  const [rights,channelFlags,preorder]=await Promise.all([
    source==="upload"?Promise.resolve(null):resolveProductRights(db,product.id,territory,{salesChannel:"retail"}),
    source==="upload"?Promise.resolve({subscriptionEligible:false,libraryEligible:false}):territorialChannelFlags(db,product.id,territory),
    source==="upload"?Promise.resolve({isPreorder:false,accepting:true,reason:null,plan:null,existing:null}):preorderPurchaseState(db,userId,product.id),
  ]);
  book.subscriptionEligible=channelFlags.subscriptionEligible;book.libraryEligible=channelFlags.libraryEligible;
  const canReadFull=source==="upload"||entitled||(publicDomain&&!!rights?.allowed);
  const distribution=await db.prepare(`SELECT da.drm_status,da.downloadable,av.size_bytes,av.epub_version,av.version_number FROM digital_assets da LEFT JOIN asset_versions av ON av.id=da.current_version_id WHERE da.edition_id=? AND da.kind='epub' LIMIT 1`).bind(book.editionId).first<any>();
  const editionRows=await db.prepare(`SELECT p.id product_id,p.public_id product_public_id,p.source_external_id,e.id edition_id,e.public_id edition_public_id,e.language,e.edition_number,e.publication_date,e.release_date,p.format,pub.name publisher,imp.name imprint
    FROM editions e JOIN products p ON p.edition_id=e.id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN imprints imp ON imp.id=e.imprint_id
    WHERE e.work_id=? AND p.storefront_status='active' ORDER BY CASE WHEN e.id=? THEN 0 ELSE 1 END,COALESCE(e.release_date,e.publication_date,'9999') DESC LIMIT 25`).bind(book.workId,book.editionId).all<any>();
  const editionOffers=await Promise.all(editionRows.results.map((r:any)=>effectiveOffer(db,String(r.product_id),territory)));
  const editions=editionRows.results.map((r:any,i:number)=>({editionId:String(r.edition_public_id||r.edition_id),internalEditionId:String(r.edition_id),externalBookId:String(r.source_external_id),productId:String(r.product_id),publicProductId:String(r.product_public_id||r.product_id),language:String(r.language||'en'),editionNumber:String(r.edition_number||''),publicationDate:r.publication_date||null,releaseDate:r.release_date||null,format:String(r.format||'ebook'),publisher:String(r.publisher||''),imprint:String(r.imprint||''),offer:editionOffers[i],current:String(r.edition_id)===String(book.editionId)}));
  const disclosure=await db.prepare(`SELECT d.* FROM publishing_publications pp JOIN publishing_publication_versions pv ON pv.publication_id=pp.id JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id AND l.current_publication_version_id=pv.id JOIN publishing_publication_disclosures d ON d.publication_version_id=pv.id WHERE pp.product_id=? ORDER BY d.created_at DESC LIMIT 1`).bind(product.id).first<any>();
  let publicBadges:any[]=[];try{publicBadges=disclosure?JSON.parse(String(disclosure.public_badges_json||"[]")):[];}catch{publicBadges=[];}
  return{
    book,
    commerce:{territory:territory.toUpperCase(),offer,available:!!offer&&(!preorder.isPreorder||preorder.accepting),entitled,canReadFull,publicDomain,source,rights:rights?{allowed:rights.allowed,reasonCode:rights.reasonCode,grantId:rights.grantId,licenseType:rights.licenseType,drmRequirement:rights.drmRequirement}:null,preorder:preorder.isPreorder?{accepting:preorder.accepting,reason:preorder.reason,opensAt:preorder.plan?.opens_at||book.preorderDate||null,releaseAt:preorder.plan?.release_at||book.releaseDate||null,manuscriptDeadlineAt:preorder.plan?.manuscript_deadline_at||null,paymentTiming:preorder.plan?.payment_timing||"charge_now",priceGuaranteePolicy:preorder.plan?.price_guarantee_policy||"none",cancellationPolicy:preorder.plan?.cancellation_policy||"customer_until_release",status:preorder.plan?.status||"unconfigured",existing:preorder.existing?{id:preorder.existing.id,status:preorder.existing.status,guaranteedPriceMinor:Number(preorder.existing.guaranteed_price_minor||0),currency:String(preorder.existing.currency||offer?.currency||"USD"),createdAt:preorder.existing.created_at}:null}:null},
    ratings:{average:Number(ratings?.average_rating||0),count:Number(ratings?.review_count||0),distribution:{5:Number(ratings?.five_star||0),4:Number(ratings?.four_star||0),3:Number(ratings?.three_star||0),2:Number(ratings?.two_star||0),1:Number(ratings?.one_star||0)}},
    rankings:rankingRows.results,
    taxonomy:taxonomyRows.results,
    preview:{available:!!rights?.allowed&&(publicDomain||!!policy),policy:policy?{mode:policy.mode,limitValue:Number(policy.limit_value),maxPercentage:Number(policy.max_percentage),version:Number(policy.version)}:publicDomain?{mode:"percent",limitValue:15,maxPercentage:20,version:1}:null},
    wishlist:wishlist?{saved:true,alerts:{priceDrop:!!wishlist.alert_price_drop,sale:!!wishlist.alert_sale,release:!!wishlist.alert_release,preorder:!!wishlist.alert_preorder}}:{saved:false,alerts:null},
    distribution:{drmStatus:distribution?.drm_status||book.drmStatus||"none",downloadable:distribution?!!distribution.downloadable:!!book.downloadable,fileSizeBytes:distribution?.size_bytes??book.fileSizeBytes??null,epubVersion:distribution?.epub_version||book.epubVersion||null,assetVersion:distribution?.version_number??null},
    contentDisclosure:disclosure?{policyVersion:String(disclosure.policy_version||""),textOrigin:String(disclosure.text_origin||"human"),coverOrigin:String(disclosure.cover_origin||"human"),narrationOrigin:String(disclosure.narration_origin||"human"),translationOrigin:String(disclosure.translation_origin||"human"),syntheticVoiceLabel:String(disclosure.synthetic_voice_label||""),publicBadges}:null,
    editions,
  };
}

export async function previewPolicy(db:CatalogDB,productId:string){
  const p=await db.prepare("SELECT p.id,p.edition_id,p.source_name FROM products p WHERE p.id=? AND p.storefront_status='active'").bind(productId).first<any>();if(!p)throw new ApiError(404,"Product not found.");
  const at=now(),row=await db.prepare(`SELECT * FROM preview_policies WHERE edition_id=? AND enabled=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`).bind(p.edition_id,at,at).first<any>();
  if(!row&&p.source_name!=="gutenberg")throw new ApiError(404,"A preview is not available for this edition.");
  return{product:p,policy:row||{edition_id:p.edition_id,mode:"percent",limit_value:15,max_percentage:20,version:1}};
}

export async function savePreviewState(db:CatalogDB,userId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1).max(180),cfi:z.string().max(3000).default(""),progress:z.number().min(0).max(1).default(0),expectedVersion:z.number().int().min(0).optional()}).parse(raw),at=now();
  const p=await db.prepare("SELECT id,source_external_id FROM products WHERE id=? AND storefront_status='active'").bind(x.productId).first<any>();if(!p)throw new ApiError(404,"Product not found.");
  const previous=await db.prepare("SELECT * FROM preview_states WHERE user_id=? AND product_id=?").bind(userId,x.productId).first<any>(),currentVersion=Number(previous?.version||0);
  if(x.expectedVersion!==undefined&&x.expectedVersion!==currentVersion)throw Object.assign(new ApiError(409,"This sample position changed on another device."),{syncConflict:{serverVersion:currentVersion,server:previous?{cfi:previous.cfi,progress:Number(previous.sample_progress),updatedAt:previous.updated_at}:null}});
  let saved:any;if(previous)saved=await db.prepare("UPDATE preview_states SET cfi=?,sample_progress=?,updated_at=?,version=version+1 WHERE user_id=? AND product_id=? AND version=? RETURNING version").bind(x.cfi,x.progress,at,userId,x.productId,currentVersion).first<any>();
  else saved=await db.prepare("INSERT INTO preview_states(user_id,product_id,cfi,sample_progress,started_at,updated_at,version) VALUES(?,?,?,?,?,?,1) ON CONFLICT(user_id,product_id) DO NOTHING RETURNING version").bind(userId,x.productId,x.cfi,x.progress,at,at).first<any>();
  if(!saved)throw new ApiError(409,"This sample position changed on another device.");
  const version=Number(saved.version);await recordSyncProjection(db,{userId,entityType:"sample",entityId:x.productId,payload:{productId:x.productId,cfi:x.cfi,progress:x.progress},explicitVersion:version});
  if(!previous) await recordRetailEvent(db,userId,{eventType:"sample_started",productId:x.productId,externalBookId:p.source_external_id,sourceSurface:"reader-preview",dedupeKey:`sample-start:${userId}:${x.productId}`});
  if(x.progress>=.95&&Number(previous?.sample_progress||0)<.95) await recordRetailEvent(db,userId,{eventType:"sample_completed",productId:x.productId,externalBookId:p.source_external_id,sourceSurface:"reader-preview",properties:{progress:x.progress},dedupeKey:`sample-complete:${userId}:${x.productId}`});
  return{saved:true,version};
}

const wishlistInput=z.object({productId:z.string().min(1).max(180),saved:z.boolean().default(true),alerts:z.object({priceDrop:z.boolean().default(true),sale:z.boolean().default(true),release:z.boolean().default(true),preorder:z.boolean().default(true)}).optional(),sourceSurface:z.string().max(100).default("product"),sourceRequestId:z.string().max(180).nullable().optional(),territory:z.string().regex(/^[A-Z]{2}$/).default("US")});
export async function setWishlistItem(db:CatalogDB,userId:string,raw:unknown){
  const x=wishlistInput.parse(raw),at=now(),existing=await db.prepare("SELECT 1 ok FROM wishlist_items WHERE user_id=? AND product_id=?").bind(userId,x.productId).first<any>();
  if(!x.saved){await db.batch([db.prepare("DELETE FROM wishlist_items WHERE user_id=? AND product_id=?").bind(userId,x.productId),db.prepare("INSERT INTO wishlist_events(id,user_id,product_id,event_type,source_surface,source_request_id,created_at) VALUES(?,?,?,'remove',?,?,?)").bind(crypto.randomUUID(),userId,x.productId,x.sourceSurface,x.sourceRequestId||null,at)]);await recordSyncProjection(db,{userId,entityType:"wishlist",entityId:x.productId,payload:{productId:x.productId,saved:false,alerts:x.alerts||{}},tombstone:true});if(existing)await recordRetailEvent(db,userId,{eventType:"wishlist_removed",productId:x.productId,sourceSurface:x.sourceSurface,sourceRequestId:x.sourceRequestId,territory:x.territory});return{saved:false};}
  const p=await db.prepare("SELECT id FROM products WHERE id=? AND storefront_status='active'").bind(x.productId).first<any>();if(!p)throw new ApiError(404,"Product not found.");
  const offer=await effectiveOffer(db,x.productId,x.territory),a=x.alerts||{priceDrop:true,sale:true,release:true,preorder:true};
  await db.batch([
    db.prepare(`INSERT INTO wishlist_items(user_id,product_id,added_at,baseline_price_minor,last_seen_price_minor,currency,alert_price_drop,alert_sale,alert_release,alert_preorder,source_surface,source_request_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET alert_price_drop=excluded.alert_price_drop,alert_sale=excluded.alert_sale,alert_release=excluded.alert_release,alert_preorder=excluded.alert_preorder,source_surface=CASE WHEN wishlist_items.source_surface='' THEN excluded.source_surface ELSE wishlist_items.source_surface END,source_request_id=COALESCE(wishlist_items.source_request_id,excluded.source_request_id),last_seen_price_minor=COALESCE(excluded.last_seen_price_minor,wishlist_items.last_seen_price_minor),currency=COALESCE(excluded.currency,wishlist_items.currency),updated_at=excluded.updated_at`).bind(userId,x.productId,at,offer?.amountMinor??null,offer?.amountMinor??null,offer?.currency??null,a.priceDrop?1:0,a.sale?1:0,a.release?1:0,a.preorder?1:0,x.sourceSurface,x.sourceRequestId||null,at),
    db.prepare("INSERT INTO wishlist_events(id,user_id,product_id,event_type,source_surface,source_request_id,metadata_json,created_at) VALUES(?,?,?,'add',?,?,?,?)").bind(crypto.randomUUID(),userId,x.productId,x.sourceSurface,x.sourceRequestId||null,JSON.stringify({territory:x.territory}),at)
  ]);
  await recordSyncProjection(db,{userId,entityType:"wishlist",entityId:x.productId,payload:{productId:x.productId,saved:true,alerts:a}});
  if(!existing) await recordRetailEvent(db,userId,{eventType:"wishlist_added",productId:x.productId,sourceSurface:x.sourceSurface,sourceRequestId:x.sourceRequestId,territory:x.territory,currency:offer?.currency||null,amountMinor:offer?.amountMinor??null,dedupeKey:`wishlist-add:${userId}:${x.productId}:${at}`});
  return{saved:true,offer};
}

export async function wishlistSnapshot(db:CatalogDB,userId:string,territory="US"){
  const rows=await db.prepare("SELECT * FROM wishlist_items WHERE user_id=? ORDER BY added_at DESC").bind(userId).all<any>(),ids=rows.results.map(r=>String(r.product_id)),books=await canonicalBooksByProductIds(db,ids),byId=new Map(books.map(b=>[String(b.productId),b]));
  const items=[] as any[];for(const row of rows.results){const book=byId.get(String(row.product_id));if(!book)continue;const offer=await effectiveOffer(db,String(row.product_id),territory);items.push({book,offer,addedAt:row.added_at,alerts:{priceDrop:!!row.alert_price_drop,sale:!!row.alert_sale,release:!!row.alert_release,preorder:!!row.alert_preorder},available:!!offer||book.uploaded});}
  const profile=await db.prepare("SELECT share_enabled,share_token,title FROM wishlist_profiles WHERE user_id=?").bind(userId).first<any>();
  const notifications=await db.prepare("SELECT * FROM commerce_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(userId).all<any>();
  return{items,profile:profile||{share_enabled:0,share_token:null,title:"My wishlist"},notifications:notifications.results};
}

export async function updateWishlistSharing(db:CatalogDB,userId:string,raw:unknown){
  const x=z.object({enabled:z.boolean(),rotate:z.boolean().default(false),title:z.string().trim().min(1).max(80).default("My wishlist")}).parse(raw),at=now();
  const existing=await db.prepare("SELECT share_token FROM wishlist_profiles WHERE user_id=?").bind(userId).first<any>();
  // Rotation always creates a brand-new token; disabling removes the token entirely so old links are revoked.
  const token=x.enabled?(x.rotate||!existing?.share_token?crypto.randomUUID().replaceAll("-",""):String(existing.share_token)):null;
  await db.prepare(`INSERT INTO wishlist_profiles(user_id,share_enabled,share_token,title,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET share_enabled=excluded.share_enabled,share_token=excluded.share_token,title=excluded.title,updated_at=excluded.updated_at`).bind(userId,x.enabled?1:0,token,x.title,at,at).run();
  return{enabled:x.enabled,token};
}

export async function sharedWishlist(db:CatalogDB,token:string,territory="US"){
  if(!/^[a-f0-9]{32}$/.test(token))throw new ApiError(404,"Wishlist not found.");
  const p=await db.prepare("SELECT user_id,title FROM wishlist_profiles WHERE share_enabled=1 AND share_token=?").bind(token).first<any>();if(!p)throw new ApiError(404,"Wishlist not found.");
  const snap=await wishlistSnapshot(db,String(p.user_id),territory);return{title:p.title,items:snap.items.map(({book,offer,available}:any)=>({book,offer,available}))};
}

export async function cartSnapshot(db:CatalogDB,userId:string,territory="US"){
  const cart=await db.prepare("SELECT * FROM shopping_carts WHERE user_id=?").bind(userId).first<any>();if(!cart)return{items:[],currency:null,subtotalMinor:0};
  const rows=await db.prepare("SELECT * FROM shopping_cart_items WHERE cart_id=? ORDER BY added_at").bind(cart.id).all<any>(),books=await canonicalBooksByProductIds(db,rows.results.map(r=>String(r.product_id))),byId=new Map(books.map(b=>[String(b.productId),b]));let subtotal=0;const items=[] as any[];
  for(const row of rows.results){const offer=await effectiveOffer(db,String(row.product_id),territory),available=!!offer&&(!cart.currency||offer.currency===cart.currency);if(available)subtotal+=offer!.amountMinor;items.push({book:byId.get(String(row.product_id)),offer,available,addedAt:row.added_at,stalePrice:!!offer&&(offer.amountMinor!==Number(row.price_snapshot_minor)||offer.currency!==row.currency)});}
  return{items,currency:cart.currency,subtotalMinor:subtotal};
}

export async function addToCart(db:CatalogDB,userId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1).max(180),territory:z.string().regex(/^[A-Z]{2}$/).default("US"),sourceSurface:z.string().max(100).default("product"),sourceRequestId:z.string().max(180).nullable().optional(),removeFromWishlist:z.boolean().default(false)}).parse(raw),offer=await effectiveOffer(db,x.productId,x.territory);if(!offer)throw new ApiError(409,"This title is not currently available for purchase in your storefront.");if(offer.amountMinor<=0)throw new ApiError(409,"This title does not require checkout.");
  await assertPreorderPurchaseAllowed(db,userId,x.productId);
  const at=now();let cart=await db.prepare("SELECT * FROM shopping_carts WHERE user_id=?").bind(userId).first<any>();if(cart?.currency&&cart.currency!==offer.currency)throw new ApiError(409,`Your cart is in ${cart.currency}. Complete or clear it before adding a ${offer.currency} title.`);
  const existingCartItem=cart?await db.prepare("SELECT 1 ok FROM shopping_cart_items WHERE cart_id=? AND product_id=?").bind(cart.id,x.productId).first<any>():null;
  if(!cart){const id=`cart_${crypto.randomUUID()}`;await db.prepare("INSERT INTO shopping_carts(id,user_id,currency,created_at,updated_at) VALUES(?,?,?,?,?)").bind(id,userId,offer.currency,at,at).run();cart={id,currency:offer.currency};}
  await db.prepare(`INSERT INTO shopping_cart_items(cart_id,product_id,offer_id,price_snapshot_minor,currency,source_surface,source_request_id,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cart_id,product_id) DO UPDATE SET offer_id=excluded.offer_id,price_snapshot_minor=excluded.price_snapshot_minor,currency=excluded.currency,updated_at=excluded.updated_at`).bind(cart.id,x.productId,offer.id,offer.amountMinor,offer.currency,x.sourceSurface,x.sourceRequestId||null,at,at).run();
  if(x.removeFromWishlist){await db.prepare("DELETE FROM wishlist_items WHERE user_id=? AND product_id=?").bind(userId,x.productId).run();await db.prepare("INSERT INTO wishlist_events(id,user_id,product_id,event_type,source_surface,source_request_id,metadata_json,created_at) VALUES(?,?,?,'move_to_cart',?,?,?,?)").bind(crypto.randomUUID(),userId,x.productId,x.sourceSurface,x.sourceRequestId||null,JSON.stringify({currency:offer.currency,amountMinor:offer.amountMinor}),at).run();await recordSyncProjection(db,{userId,entityType:"wishlist",entityId:x.productId,payload:{productId:x.productId,saved:false,alerts:{}},tombstone:true});}
  if(!existingCartItem) await recordRetailEvent(db,userId,{eventType:"cart_added",productId:x.productId,sourceSurface:x.sourceSurface,sourceRequestId:x.sourceRequestId,territory:x.territory,currency:offer.currency,amountMinor:offer.amountMinor,dedupeKey:`cart-add:${userId}:${x.productId}:${at}`});
  return cartSnapshot(db,userId,x.territory);
}

export async function removeFromCart(db:CatalogDB,userId:string,productId:string){const cart=await db.prepare("SELECT id FROM shopping_carts WHERE user_id=?").bind(userId).first<any>();let existed:any=null;if(cart){existed=await db.prepare("SELECT 1 ok FROM shopping_cart_items WHERE cart_id=? AND product_id=?").bind(cart.id,productId).first<any>();await db.prepare("DELETE FROM shopping_cart_items WHERE cart_id=? AND product_id=?").bind(cart.id,productId).run();}if(existed)await recordRetailEvent(db,userId,{eventType:"cart_removed",productId,sourceSurface:"cart"});return{removed:true};}

export async function runWishlistAlerts(db:CatalogDB,territory="US",limit=250,after=""){
  const rows=await db.prepare(`SELECT w.*,p.edition_id,p.source_external_id,e.title,e.release_date,e.preorder_date,e.release_status FROM wishlist_items w JOIN products p ON p.id=w.product_id JOIN editions e ON e.id=p.edition_id WHERE (w.user_id||':'||w.product_id)>? ORDER BY w.user_id,w.product_id LIMIT ?`).bind(after,limit).all<any>();let notifications=0,last=after;
  for(const row of rows.results){last=`${row.user_id}:${row.product_id}`;const offer=await effectiveOffer(db,String(row.product_id),territory),prev=row.last_seen_price_minor==null?null:Number(row.last_seen_price_minor),current=offer?.amountMinor??null,events:{type:string,key:string,title:string,body:string,payload:any}[]=[];
    if(offer&&prev!==null&&current!==null&&current<prev&&row.alert_price_drop)events.push({type:"price_drop",key:`price:${row.product_id}:${current}`,title:`Price drop: ${row.title}`,body:`A title on your wishlist dropped in price.`,payload:{currency:offer.currency,amountMinor:current,previousMinor:prev}});
    if(offer?.promotion&&row.alert_sale)events.push({type:"sale",key:`sale:${row.product_id}:${offer.promotion.id}`,title:`On sale: ${row.title}`,body:`A wishlist title is currently on sale.`,payload:{promotion:offer.promotion,currency:offer.currency,amountMinor:offer.amountMinor}});
    if(row.alert_release&&row.release_date&&row.added_at<row.release_date&&row.release_date<=now()&&row.release_status==="available")events.push({type:"release",key:`release:${row.product_id}:${String(row.release_date).slice(0,10)}`,title:`Now available: ${row.title}`,body:`A wishlist title has been released.`,payload:{releaseDate:row.release_date}});
    if(row.alert_preorder&&row.preorder_date&&row.added_at<row.preorder_date&&row.release_status==="preorder"&&offer)events.push({type:"preorder",key:`preorder:${row.product_id}:${String(row.preorder_date).slice(0,10)}`,title:`Preorder available: ${row.title}`,body:`A wishlist title can now be preordered.`,payload:{preorderDate:row.preorder_date}});
    for(const e of events){const r=await db.prepare("INSERT OR IGNORE INTO commerce_notifications(id,user_id,product_id,notification_type,dedupe_key,title,body,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),row.user_id,row.product_id,e.type,e.key,e.title,e.body,JSON.stringify(e.payload),now()).run();notifications+=Number((r as any)?.meta?.changes??0);if(e.type==="price_drop")try{await emitNotification(db,{userId:String(row.user_id),eventType:"wishlist_price_drop",dedupeKey:`wishlist:${e.key}`,title:e.title,body:e.body,productId:String(row.product_id),subjectType:"wishlist_item",subjectId:String(row.product_id),actionUrl:row.source_external_id?`/book/${encodeURIComponent(String(row.source_external_id))}`:"/store",payload:e.payload});}catch(err){console.error("Wishlist notification enqueue failed",err);}}
    await db.prepare("UPDATE wishlist_items SET last_seen_price_minor=?,currency=COALESCE(?,currency),updated_at=? WHERE user_id=? AND product_id=?").bind(current,offer?.currency??null,now(),row.user_id,row.product_id).run();
  }
  return{processed:rows.results.length,notifications,nextCursor:last,done:rows.results.length<limit};
}

export async function upsertPreviewPolicy(db:CatalogDB,raw:unknown){
  const x=z.object({editionId:z.string().min(1).max(180),enabled:z.boolean().default(true),mode:z.enum(["percent","chapters"]),limitValue:z.number().int().min(1).max(50),maxPercentage:z.number().int().min(1).max(50).default(20),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional()}).parse(raw),at=now();
  const e=await db.prepare("SELECT id FROM editions WHERE id=?").bind(x.editionId).first<any>();if(!e)throw new ApiError(404,"Edition not found.");
  await db.prepare(`INSERT INTO preview_policies(edition_id,enabled,mode,limit_value,max_percentage,version,starts_at,ends_at,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?, 'operator',?,?) ON CONFLICT(edition_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,limit_value=excluded.limit_value,max_percentage=excluded.max_percentage,version=preview_policies.version+1,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_by='operator',updated_at=excluded.updated_at`).bind(x.editionId,x.enabled?1:0,x.mode,x.limitValue,x.maxPercentage,x.startsAt||null,x.endsAt||null,at,at).run();
  return db.prepare("SELECT * FROM preview_policies WHERE edition_id=?").bind(x.editionId).first<any>();
}
