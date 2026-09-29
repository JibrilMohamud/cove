import JSZip from "jszip";
import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";
import { drmSatisfiesRequirement, resolveProductRights } from "./rights.server";
import { recordSyncProjection } from "./sync.server";

type DB=CoveEnv["DB"];
const uid=(p:string)=>`${p}_${crypto.randomUUID()}`;
function parseJson(v:any,f:any){try{return JSON.parse(String(v||""));}catch{return f;}}
async function sha256(v:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}
function token(){const b=crypto.getRandomValues(new Uint8Array(32));let s="";for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function requestMeta(request?:Request){return{country:(request?.headers.get("cf-ipcountry")||"").slice(0,2).toUpperCase(),ua:(request?.headers.get("user-agent")||"").slice(0,240)};}

async function lifecycleForProduct(db:DB,productId:string){return db.prepare(`SELECT l.*,pv.id current_version_id,pv.version_number current_version_number FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications pp ON pp.id=pv.publication_id WHERE pp.product_id=? LIMIT 1`).bind(productId).first<any>();}
async function versionAsset(db:DB,product:any,publicationVersionId:string|null){
  if(publicationVersionId){const pv=await db.prepare("SELECT manifest_json,version_number FROM publishing_publication_versions WHERE id=?").bind(publicationVersionId).first<any>();const manifest=parseJson(pv?.manifest_json,{}),epub=(manifest.catalogAssets||[]).find((a:any)=>a.kind==="epub");if(epub?.catalogAssetVersionId){const a=await db.prepare(`SELECT da.id asset_id,da.downloadable,da.drm_status,av.id asset_version_id,av.object_key,av.mime_type,av.sha256,av.version_number FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id WHERE av.id=? AND da.edition_id=? AND da.kind='epub' LIMIT 1`).bind(epub.catalogAssetVersionId,product.edition_id).first<any>();if(a)return{...a,publicationVersionNumber:Number(pv?.version_number||0)};}}
  const a=await db.prepare(`SELECT da.id asset_id,da.downloadable,da.drm_status,av.id asset_version_id,av.object_key,av.mime_type,av.sha256,av.version_number FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id WHERE da.edition_id=? AND da.kind='epub' LIMIT 1`).bind(product.edition_id).first<any>();if(!a)throw new ApiError(404,"An EPUB is not available for this edition.");return a;
}
async function entitlementFor(db:DB,userId:string,productId:string){const at=now();return db.prepare(`SELECT * FROM entitlements WHERE user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) ORDER BY CASE WHEN entitlement_type='purchase' THEN 0 WHEN entitlement_type='gift' THEN 1 WHEN entitlement_type='publisher' THEN 2 WHEN entitlement_type='subscription' THEN 3 ELSE 4 END,granted_at DESC LIMIT 1`).bind(userId,productId,at,at).first<any>();}
async function deliveryPolicy(db:DB,productId:string){const r=await db.prepare("SELECT * FROM commercial_delivery_policies WHERE product_id=?").bind(productId).first<any>();return r||{product_id:productId,require_device_registration:0,max_active_devices:6,max_downloads_per_entitlement:50,token_ttl_seconds:300,token_max_uses:2,watermark_mode:"none",encryption_mode:"none",allow_browser_read:1,allow_file_download:1};}
async function acquiredContractPolicy(db:DB,ent:any,purpose:string){
  if(!ent?.order_item_id)return {};
  const item=await db.prepare("SELECT rights_snapshot_json FROM commerce_order_items WHERE id=?").bind(ent.order_item_id).first<any>();
  const rights=parseJson(item?.rights_snapshot_json,{}),policy=rights?.contractPolicy||{};
  if(!rights?.contractVersionId)return policy;
  const v=await db.prepare("SELECT rcv.status,rcv.effective_to,rc.status contract_status,rc.effective_to contract_effective_to FROM rights_contract_versions rcv JOIN rights_contracts rc ON rc.id=rcv.contract_id WHERE rcv.id=?").bind(rights.contractVersionId).first<any>();
  const at=now();
  const ended=!v||["terminated","expired","superseded"].includes(String(v.status))||["terminated","expired"].includes(String(v.contract_status))||(v.effective_to&&String(v.effective_to)<=at)||(v.contract_effective_to&&String(v.contract_effective_to)<=at);
  if(ended){
    const post=String(policy.postTerminationAccessPolicy||"preserve_perpetual_purchases");
    if(post==="revoke_all")throw new ApiError(451,"The distribution agreement requires Cove to revoke post-termination access to this purchase.");
    if(post==="preserve_downloaded_only")throw new ApiError(451,"The distribution agreement preserves already-downloaded copies but does not permit new server delivery after termination.");
    if(post==="block_future_downloads"&&purpose!=="read")throw new ApiError(451,"The distribution agreement no longer permits new downloads after termination; browser reading remains available for this purchase.");
  }
  return policy;
}
function stricterLimit(base:number,contract:any){if(contract==null||!Number.isFinite(Number(contract))||Number(contract)<=0)return base;return Math.min(base,Number(contract));}
function applyContractDeliveryPolicy(base:any,contractPolicy:any){
  const out={...base},format=contractPolicy?.formatPolicy||{},rules=contractPolicy?.deliveryRules||{};
  if(Number(format.deviceLimit)===0) out.contract_delivery_blocked=1;
  else if(format.deviceLimit!=null){out.require_device_registration=1;out.max_active_devices=stricterLimit(Number(out.max_active_devices||6),format.deviceLimit);}
  if(Number(format.downloadLimit)===0){out.allow_file_download=0;out.contract_offline_permitted=0;}
  else if(format.downloadLimit!=null)out.max_downloads_per_entitlement=stricterLimit(Number(out.max_downloads_per_entitlement||50),format.downloadLimit);
  if(format.offlinePermitted===false)out.contract_offline_permitted=0;
  if(rules.requireDeviceRegistration===true)out.require_device_registration=1;
  if(Number(rules.maxActiveDevices)===0)out.contract_delivery_blocked=1;
  else if(rules.maxActiveDevices!=null)out.max_active_devices=stricterLimit(Number(out.max_active_devices||6),rules.maxActiveDevices);
  if(Number(rules.maxDownloadsPerEntitlement)===0){out.allow_file_download=0;out.contract_offline_permitted=0;}
  else if(rules.maxDownloadsPerEntitlement!=null)out.max_downloads_per_entitlement=stricterLimit(Number(out.max_downloads_per_entitlement||50),rules.maxDownloadsPerEntitlement);
  if(rules.tokenTtlSeconds!=null)out.token_ttl_seconds=stricterLimit(Number(out.token_ttl_seconds||300),rules.tokenTtlSeconds);
  if(rules.tokenMaxUses!=null)out.token_max_uses=stricterLimit(Number(out.token_max_uses||2),rules.tokenMaxUses);
  if(rules.allowBrowserRead===false)out.allow_browser_read=0;if(rules.allowFileDownload===false)out.allow_file_download=0;
  if(rules.watermarkMode&&String(rules.watermarkMode)!=="none")out.watermark_mode=String(rules.watermarkMode);
  if(rules.encryptionMode&&String(rules.encryptionMode)!=="none")out.encryption_mode=String(rules.encryptionMode);
  out.contract_policy=contractPolicy||{};return out;
}
async function ownershipRecord(db:DB,ent:any,product:any,lifecycle:any){
  const existing=await db.prepare("SELECT * FROM entitlement_ownership_records WHERE entitlement_id=?").bind(ent.id).first<any>();
  if(existing)return existing;
  const at=now(),purchase=["purchase","gift","publisher"].includes(String(ent.entitlement_type)),pin=await db.prepare("SELECT publication_version_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?").bind(ent.id).first<any>(),version=pin?.publication_version_id||lifecycle?.current_publication_version_id||null,policy=String(lifecycle?.owner_update_policy||"auto_update");
  await db.prepare(`INSERT INTO entitlement_ownership_records(entitlement_id,user_id,product_id,work_id,edition_id,ownership_scope,publication_version_id,owner_update_policy,redownload_policy,rights_expiry_policy,removal_policy,annotations_policy,biosync_policy,acquired_at,created_at,updated_at) VALUES(?,?,?,?,?,'exact_edition',?,?,?,?,?,'migrate_or_preserve','version_bound',?,?,?)`)
    .bind(ent.id,ent.user_id,product.id,product.work_id,product.edition_id,version,policy,purchase?"preserve_for_owner":"disabled",purchase?"preserve_for_owner":"block_delivery",purchase?"preserve_for_owner":"block_delivery",ent.granted_at||at,at,at).run();
  return db.prepare("SELECT * FROM entitlement_ownership_records WHERE entitlement_id=?").bind(ent.id).first<any>();
}
async function resolvedPublicationVersion(db:DB,ent:any,ownership:any,lifecycle:any){
  if(!lifecycle?.current_publication_version_id)return null;
  const pin=await db.prepare("SELECT publication_version_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?").bind(ent.id).first<any>();
  if(pin?.publication_version_id)return String(pin.publication_version_id);
  if(String(ownership.owner_update_policy)==="preserve_purchased_version"&&ownership.publication_version_id)return String(ownership.publication_version_id);
  if(String(ownership.owner_update_policy)==="manual_opt_in"&&ownership.publication_version_id)return String(ownership.publication_version_id);
  return String(lifecycle.current_publication_version_id);
}
async function assertDistributionAllowed(db:DB,publicationVersionId:string|null,isPermanentOwner:boolean){
  if(!publicationVersionId)return;
  const c=await db.prepare("SELECT * FROM publication_version_distribution_controls WHERE publication_version_id=?").bind(publicationVersionId).first<any>();if(!c)return;
  const status=String(c.distribution_status||"distributable");
  if(status==="recalled"||status==="blocked")if(!(isPermanentOwner&&Number(c.allow_existing_owners)))throw new ApiError(451,status==="recalled"?"This publication version was recalled and can no longer be delivered.":"This publication version is blocked from delivery.");
  if(status==="owner_only"&&!isPermanentOwner)throw new ApiError(403,"This publication version is available only to existing owners.");
}
async function assertDevice(db:DB,userId:string,entitlementId:string,productId:string,policy:any,deviceId:string|null){
  if(!Number(policy.require_device_registration))return null;
  if(!deviceId)throw new ApiError(428,"This publisher requires a registered device for delivery. Register this device and retry.");
  const d=await db.prepare("SELECT * FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL").bind(deviceId,userId).first<any>();if(!d)throw new ApiError(403,"This device is not registered or has been revoked.");
  const existing=await db.prepare("SELECT 1 ok FROM commercial_entitlement_devices WHERE entitlement_id=? AND device_id=?").bind(entitlementId,deviceId).first<any>(),at=now();
  if(existing){await db.prepare("UPDATE commercial_entitlement_devices SET last_used_at=? WHERE entitlement_id=? AND device_id=?").bind(at,entitlementId,deviceId).run();return d;}
  const count=Number((await db.prepare(`SELECT COUNT(*) c FROM commercial_entitlement_devices ced JOIN devices d ON d.id=ced.device_id WHERE ced.entitlement_id=? AND d.user_id=? AND d.revoked_at IS NULL`).bind(entitlementId,userId).first<any>())?.c||0);
  if(count>=Number(policy.max_active_devices||6))throw new ApiError(403,"This entitlement has reached the publisher's active-device limit. Revoke an old device before adding another.");
  await db.prepare("INSERT INTO commercial_entitlement_devices(entitlement_id,product_id,device_id,activated_at,last_used_at) VALUES(?,?,?,?,?)").bind(entitlementId,productId,deviceId,at,at).run();return d;
}
async function audit(db:DB,x:{grantId?:string|null,userId:string;productId:string;entitlementId:string;assetVersionId:string;publicationVersionId?:string|null;deviceId?:string|null;eventType:string;bytes?:number;request?:Request;reason?:string;metadata?:any}){const m=requestMeta(x.request);await db.prepare("INSERT INTO commercial_download_audit(id,grant_id,user_id,product_id,entitlement_id,asset_version_id,publication_version_id,device_id,event_type,bytes_served,ip_country,user_agent,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(uid("dla"),x.grantId||null,x.userId,x.productId,x.entitlementId,x.assetVersionId,x.publicationVersionId||null,x.deviceId||null,x.eventType,Number(x.bytes||0),m.country,m.ua,x.reason||"",JSON.stringify(x.metadata||{}),now()).run();}

async function reconcileAnnotationAnchors(db:DB,userId:string,productId:string,toPublicationVersionId:string|null,toAssetVersionId:string){
  if(!toPublicationVersionId)return;
  const anchors=(await db.prepare(`SELECT a.*,old.sha256 old_sha,new.sha256 new_sha FROM annotation_version_anchors a JOIN annotations n ON n.id=a.annotation_id AND n.user_id=? AND n.deleted_at IS NULL LEFT JOIN asset_versions old ON old.id=a.asset_version_id LEFT JOIN asset_versions new ON new.id=? WHERE a.product_id=? AND a.publication_version_id IS NOT NULL AND a.publication_version_id<>?`).bind(userId,toAssetVersionId,productId,toPublicationVersionId).all<any>()).results;
  const at=now();
  for(const a of anchors){
    const exact=!!a.old_sha&&!!a.new_sha&&String(a.old_sha)===String(a.new_sha),status=exact?"exact":"manual_required",confidence=exact?10000:0;
    await db.prepare(`INSERT OR IGNORE INTO annotation_cfi_migrations(id,product_id,from_publication_version_id,to_publication_version_id,annotation_id,from_cfi,to_cfi,status,confidence_bps,migration_detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(uid("cfimig"),productId,a.publication_version_id,toPublicationVersionId,a.annotation_id,a.cfi,exact?a.cfi:null,status,confidence,JSON.stringify(exact?{reason:"identical_asset_sha256"}:{reason:"asset_changed",preservedOnSourceVersion:true}),at).run();
    // Only move anchors when byte identity proves the CFI is stable. Changed EPUBs remain anchored to their source version until a quote/CFI migration service proves a destination.
    if(exact)await db.prepare("UPDATE annotation_version_anchors SET publication_version_id=?,asset_version_id=?,updated_at=? WHERE annotation_id=?").bind(toPublicationVersionId,toAssetVersionId,at,a.annotation_id).run();
  }
}

async function reconcileTextBookmarkAnchors(db:DB,userId:string,productId:string,toPublicationVersionId:string|null,toAssetVersionId:string){
  if(!toPublicationVersionId)return;
  const rows=(await db.prepare(`SELECT b.*,old.sha256 old_sha,new.sha256 new_sha FROM text_bookmarks b LEFT JOIN asset_versions old ON old.id=b.asset_version_id LEFT JOIN asset_versions new ON new.id=? WHERE b.user_id=? AND b.product_id=? AND b.deleted_at IS NULL AND b.publication_version_id IS NOT NULL AND b.publication_version_id<>?`).bind(toAssetVersionId,userId,productId,toPublicationVersionId).all<any>()).results;
  const at=now();
  for(const b of rows){
    const exact=!!b.old_sha&&!!b.new_sha&&String(b.old_sha)===String(b.new_sha),status=exact?"exact":"manual_required",confidence=exact?10000:0;
    await db.prepare(`INSERT OR IGNORE INTO text_bookmark_cfi_migrations(id,bookmark_id,from_publication_version_id,to_publication_version_id,old_cfi,new_cfi,status,method,confidence_bps,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(uid("bmcfi"),b.id,b.publication_version_id,toPublicationVersionId,b.cfi,exact?b.cfi:null,status,"asset_hash",confidence,at).run();
    if(exact){const moved=await db.prepare("UPDATE text_bookmarks SET publication_version_id=?,asset_version_id=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? RETURNING version").bind(toPublicationVersionId,toAssetVersionId,at,b.id,userId).first<any>();if(moved)await recordSyncProjection(db,{userId,entityType:"text_bookmark",entityId:String(b.id),payload:{productId:String(b.product_id),externalBookId:String(b.external_book_id),cfi:String(b.cfi),chapter:String(b.chapter||""),label:String(b.label||""),excerpt:String(b.excerpt||""),progress:Number(b.progress||0)},explicitVersion:Number(moved.version)});}
  }
}

export async function ensureOwnershipSnapshot(db:DB,userId:string,productId:string){
  const product=await db.prepare("SELECT p.*,e.work_id,e.release_status,e.downloadable edition_downloadable,e.drm_status FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(productId).first<any>();if(!product)throw new ApiError(404,"Product not found.");
  const ent=await entitlementFor(db,userId,productId);if(!ent)throw new ApiError(403,"An active entitlement is required.");const lifecycle=await lifecycleForProduct(db,productId),ownership=await ownershipRecord(db,ent,product,lifecycle);return{product,entitlement:ent,lifecycle,ownership};
}

async function assertNoBuyerFulfillmentHold(db:DB,entitlement:any){
  if(!entitlement?.order_item_id)return;
  const hold=await db.prepare(`SELECT rh.id,rh.reason_code FROM risk_holds rh JOIN commerce_order_items oi ON oi.order_id=rh.subject_id WHERE rh.domain='buyer' AND rh.subject_type='order' AND rh.status='active' AND rh.hold_scope IN ('checkout','entitlement') AND oi.id=? LIMIT 1`).bind(entitlement.order_item_id).first<any>();
  if(hold)throw new ApiError(403,"This purchase is temporarily held for payment verification. Secure delivery will resume after the hold is released.");
}

export async function issueCommercialEpubGrant(env:CoveEnv,userId:string,raw:unknown,request?:Request){
  const x=z.object({productId:z.string().min(1),purpose:z.enum(["read","download","offline_package"]).default("read"),deviceId:z.string().nullable().optional()}).parse(raw),db=env.DB;
  const {product,entitlement:ent,lifecycle,ownership}=await ensureOwnershipSnapshot(db,userId,x.productId);await assertNoBuyerFulfillmentHold(db,ent);if(["gutenberg","upload"].includes(String(product.source_name)))throw new ApiError(400,"Secure commercial grants are only used for commercial catalog assets.");
  const permanent=["purchase","gift","publisher"].includes(String(ent.entitlement_type)),pvId=await resolvedPublicationVersion(db,ent,ownership,lifecycle);await assertDistributionAllowed(db,pvId,permanent);
  let contractPolicy:any={};
  if(!permanent){
    if(String(product.storefront_status)!=="active")throw new ApiError(403,"This subscription/loan edition is no longer available.");
    const territory=(requestMeta(request).country||env.FORE_DEFAULT_TERRITORY||"US").toUpperCase(),salesChannel=String(ent.entitlement_type)==="subscription"?"subscription":String(ent.entitlement_type).includes("library")||String(ent.entitlement_type).includes("loan")?"library":"retail";
    const rights=await resolveProductRights(db as any,product.id,territory,{salesChannel:salesChannel as any,persist:true,context:{source:"secure-epub-delivery",userId,entitlementType:String(ent.entitlement_type)}});
    if(!rights.allowed)throw new ApiError(451,"The current license no longer permits temporary access to this edition in your territory.");contractPolicy=rights.contractPolicy||{};
  }else contractPolicy=await acquiredContractPolicy(db,ent,x.purpose);
  const asset=await versionAsset(db,product,pvId),policy=applyContractDeliveryPolicy(await deliveryPolicy(db,product.id),contractPolicy);if(policy.contract_delivery_blocked)throw new ApiError(403,"This distribution contract does not permit device delivery for this format.");if(!asset.object_key)throw new ApiError(503,"The commercial asset is not present in Cove-controlled storage.");await reconcileAnnotationAnchors(db,userId,product.id,pvId,asset.asset_version_id);await reconcileTextBookmarkAnchors(db,userId,product.id,pvId,asset.asset_version_id);
  if(x.purpose==="offline_package"&&policy.contract_offline_permitted===0)throw new ApiError(403,"This distribution contract does not permit offline packages.");
  const contractDrm=String(contractPolicy?.formatPolicy?.drmRequirement||"none");if(!drmSatisfiesRequirement(contractDrm,String(asset.drm_status||"none")))throw new ApiError(503,"This title's contract requires a DRM form that is not present on the resolved commercial asset.");
  if(x.purpose==="download"&&(!Number(asset.downloadable)||!Number(policy.allow_file_download)))throw new ApiError(403,"This edition can be read in Cove, but its license does not permit EPUB file download.");
  if(x.purpose==="read"&&!Number(policy.allow_browser_read))throw new ApiError(403,"This publisher does not permit browser reading for this edition.");
  if(String(policy.encryption_mode)!=="none")throw new ApiError(503,"This title requires an external DRM/key-wrapping service that is not configured for direct EPUB delivery.");
  await assertDevice(db,userId,ent.id,product.id,policy,x.deviceId||null);
  if(x.purpose!=="read"){
    const count=Number((await db.prepare("SELECT download_count FROM commercial_entitlement_delivery_usage WHERE entitlement_id=?").bind(ent.id).first<any>())?.download_count||0);if(count>=Number(policy.max_downloads_per_entitlement||50))throw new ApiError(403,"This entitlement has reached its licensed download limit.");
  }
  const rawToken=token(),hash=await sha256(rawToken),grantId=uid("grant"),issued=now(),expires=new Date(Date.now()+Number(policy.token_ttl_seconds||300)*1000).toISOString(),watermarkId=String(policy.watermark_mode)==="license_marker"?uid("wm"):null,policySnapshot={requireDeviceRegistration:!!policy.require_device_registration,maxActiveDevices:Number(policy.max_active_devices||6),maxDownloads:Number(policy.max_downloads_per_entitlement||50),ttlSeconds:Number(policy.token_ttl_seconds||300),maxUses:Number(policy.token_max_uses||2),watermarkMode:String(policy.watermark_mode||"none"),encryptionMode:String(policy.encryption_mode||"none"),ownershipScope:ownership.ownership_scope,ownerUpdatePolicy:ownership.owner_update_policy,redownloadPolicy:ownership.redownload_policy,rightsExpiryPolicy:ownership.rights_expiry_policy,removalPolicy:ownership.removal_policy,contractPolicy};
  await db.prepare("INSERT INTO commercial_delivery_grants(id,token_hash,user_id,product_id,entitlement_id,ownership_record_id,publication_version_id,asset_version_id,device_id,purpose,watermark_id,wrapped_key,policy_snapshot_json,issued_at,expires_at,max_uses,uses,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'active')").bind(grantId,hash,userId,product.id,ent.id,ent.id,pvId,asset.asset_version_id,x.deviceId||null,x.purpose,watermarkId,null,JSON.stringify(policySnapshot),issued,expires,Number(policy.token_max_uses||2)).run();
  await audit(db,{grantId,userId,productId:product.id,entitlementId:ent.id,assetVersionId:asset.asset_version_id,publicationVersionId:pvId,deviceId:x.deviceId||null,eventType:"grant_issued",request,metadata:{purpose:x.purpose,policy:policySnapshot}});
  return{grantId,url:`/api/fore/delivery/epub/${rawToken}`,expiresAt:expires,purpose:x.purpose,assetVersionId:asset.asset_version_id,publicationVersionId:pvId,watermarked:!!watermarkId};
}

async function watermarkEpub(bytes:Uint8Array,grant:any,asset:any){
  const zip=await JSZip.loadAsync(bytes);const marker={schema:"fore-license-marker",version:1,licenseId:grant.watermark_id,grantId:grant.id,productId:grant.product_id,assetVersionId:grant.asset_version_id,publicationVersionId:grant.publication_version_id||null,issuedAt:grant.issued_at,notice:"This copy is licensed for use under the purchaser's Cove entitlement. The marker contains no email address or payment information."};zip.file("META-INF/fore-license.json",JSON.stringify(marker,null,2));zip.file("mimetype","application/epub+zip",{compression:"STORE"});return new Uint8Array(await zip.generateAsync({type:"uint8array",compression:"DEFLATE",compressionOptions:{level:6},mimeType:"application/epub+zip"}));
}

export async function serveCommercialEpubGrant(env:CoveEnv,rawToken:string,request:Request){
  if(!/^[A-Za-z0-9_-]{32,200}$/.test(rawToken))throw new ApiError(404,"Delivery grant not found.");
  const db=env.DB,hash=await sha256(rawToken),grant=await db.prepare("SELECT * FROM commercial_delivery_grants WHERE token_hash=?").bind(hash).first<any>();
  if(!grant)throw new ApiError(404,"Delivery grant not found.");
  const fail=async(status:number,msg:string,reason:string)=>{await audit(db,{grantId:grant.id,userId:grant.user_id,productId:grant.product_id,entitlementId:grant.entitlement_id,assetVersionId:grant.asset_version_id,publicationVersionId:grant.publication_version_id,deviceId:grant.device_id,eventType:"denied",request,reason});throw new ApiError(status,msg);};
  if(grant.status!=="active")return fail(410,"This delivery grant is no longer active.",`grant_${grant.status}`);
  if(new Date(String(grant.expires_at)).getTime()<=Date.now()){
    await db.prepare("UPDATE commercial_delivery_grants SET status='expired' WHERE id=? AND status='active'").bind(grant.id).run();
    return fail(410,"This delivery grant expired. Request a new one.","grant_expired");
  }
  if(Number(grant.uses)>=Number(grant.max_uses)){
    await db.prepare("UPDATE commercial_delivery_grants SET status='exhausted' WHERE id=? AND status='active'").bind(grant.id).run();
    return fail(410,"This delivery grant has already been used. Request a new one.","grant_exhausted");
  }
  const ent=await db.prepare("SELECT * FROM entitlements WHERE id=?").bind(grant.entitlement_id).first<any>(),accessAt=now();
  if(ent)await assertNoBuyerFulfillmentHold(db,ent);
  if(!ent||ent.status!=="active"||(ent.starts_at&&String(ent.starts_at)>accessAt)||(ent.ends_at&&String(ent.ends_at)<=accessAt))return fail(403,"The entitlement backing this delivery is no longer active.","entitlement_inactive");
  const ownership=await db.prepare("SELECT * FROM entitlement_ownership_records WHERE entitlement_id=?").bind(ent.id).first<any>(),permanent=["purchase","gift","publisher"].includes(String(ent.entitlement_type));
  await assertDistributionAllowed(db,grant.publication_version_id,permanent);
  if(!permanent){
    const territory=(requestMeta(request).country||env.FORE_DEFAULT_TERRITORY||"US").toUpperCase(),salesChannel=String(ent.entitlement_type)==="subscription"?"subscription":String(ent.entitlement_type).includes("library")||String(ent.entitlement_type).includes("loan")?"library":"retail",rights=await resolveProductRights(db as any,grant.product_id,territory,{salesChannel:salesChannel as any,persist:true,context:{source:"secure-epub-token-use",userId:grant.user_id,entitlementType:String(ent.entitlement_type)}});
    if(!rights.allowed)return fail(451,"The current license no longer permits temporary access to this edition in your territory.","temporary_rights_expired");
  }
  if(grant.device_id){
    const sent=request.headers.get("x-fore-device-id")||"";
    if(sent!==grant.device_id)return fail(403,"This delivery grant is bound to a different registered device.","device_mismatch");
    const d=await db.prepare("SELECT 1 ok FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL").bind(grant.device_id,grant.user_id).first<any>();
    if(!d)return fail(403,"The device bound to this delivery has been revoked.","device_revoked");
  }
  const asset=await db.prepare("SELECT av.*,da.downloadable,da.drm_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id WHERE av.id=?").bind(grant.asset_version_id).first<any>();
  if(!asset?.object_key)return fail(503,"The licensed asset is unavailable from secure storage.","asset_missing");
  const obj=await env.BUCKET?.get(String(asset.object_key));
  if(!obj)return fail(503,"The licensed asset is unavailable from secure storage.","object_missing");
  const snap=parseJson(grant.policy_snapshot_json,{});
  if(grant.purpose!=="read"){
    const maxDownloads=Math.max(1,Number(snap.maxDownloads||50)),usageAt=now(),claim=await db.prepare(`INSERT INTO commercial_entitlement_delivery_usage(entitlement_id,download_count,last_download_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(entitlement_id) DO UPDATE SET download_count=download_count+1,last_download_at=excluded.last_download_at,updated_at=excluded.updated_at WHERE commercial_entitlement_delivery_usage.download_count<?`).bind(ent.id,usageAt,usageAt,maxDownloads).run();
    if(Number((claim as any)?.meta?.changes??0)!==1)return fail(403,"This entitlement has reached its licensed download limit.","download_limit_reached");
  }
  const watermark=snap.watermarkMode==="license_marker"&&!!grant.watermark_id;
  let body:any=(obj as any).body,contentLength=Number((obj as any).size||asset.size_bytes||0);
  if(watermark||!body){
    let bytes=new Uint8Array(await obj.arrayBuffer());
    if(watermark)bytes=await watermarkEpub(bytes,grant,asset);
    body=bytes;contentLength=bytes.byteLength;
  }
  // The use claim is conditional and atomic. Concurrent requests sharing the same bearer token cannot both exceed max_uses.
  const at=now(),consume=await db.prepare("UPDATE commercial_delivery_grants SET uses=uses+1,status=CASE WHEN uses+1>=max_uses THEN 'exhausted' ELSE 'active' END,last_used_at=? WHERE id=? AND status='active' AND uses<max_uses").bind(at,grant.id).run();
  if(Number((consume as any)?.meta?.changes??0)!==1)return fail(410,"This delivery grant has already been used. Request a new one.","grant_race_exhausted");
  const eventType=grant.purpose==="read"?"stream_started":"download_started";
  await audit(db,{grantId:grant.id,userId:grant.user_id,productId:grant.product_id,entitlementId:grant.entitlement_id,assetVersionId:grant.asset_version_id,publicationVersionId:grant.publication_version_id,deviceId:grant.device_id,eventType,bytes:contentLength,request,metadata:{purpose:grant.purpose,ownershipScope:ownership?.ownership_scope||"",streamedFromR2:!watermark}});
  const headers:Record<string,string>={
    "Content-Type":asset.mime_type||"application/epub+zip",
    "Cache-Control":"private, no-store",
    "Content-Disposition":`${grant.purpose==="read"?"inline":"attachment"}; filename="fore-${grant.product_id}.epub"`,
    "X-Content-Type-Options":"nosniff",
    "X-Cove-Delivery-Grant":grant.id,
    "X-Cove-Asset-Version":String(asset.version_number||1),
    "X-Cove-Publication-Version":String(grant.publication_version_id||"unversioned"),
    "X-Cove-Watermark":grant.watermark_id?"license-marker":"none",
    "Referrer-Policy":"no-referrer",
  };
  if(contentLength>0)headers["Content-Length"]=String(contentLength);
  return new Response(body,{headers});
}

export async function revokeDeliveryGrant(db:DB,userId:string,grantId:string){const r=await db.prepare("SELECT * FROM commercial_delivery_grants WHERE id=? AND user_id=?").bind(grantId,userId).first<any>();if(!r)throw new ApiError(404,"Delivery grant not found.");if(r.status==="active")await db.prepare("UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason='customer_revoked' WHERE id=?").bind(now(),grantId).run();return{revoked:true};}

export async function ownershipStatus(db:DB,userId:string,productId:string){
  const {product,entitlement,lifecycle,ownership}=await ensureOwnershipSnapshot(db,userId,productId),resolved=await resolvedPublicationVersion(db,entitlement,ownership,lifecycle),asset=await versionAsset(db,product,resolved),control=resolved?await db.prepare("SELECT * FROM publication_version_distribution_controls WHERE publication_version_id=?").bind(resolved).first<any>():null;
  const biosync=await db.prepare("SELECT id,audiobook_product_id,verification_status,verified_at FROM commercial_biosync_links WHERE ebook_product_id=? AND ebook_asset_version_id=? AND verification_status='verified' ORDER BY verified_at DESC LIMIT 1").bind(productId,asset.asset_version_id).first<any>();
  return{productId,entitlement:{id:entitlement.id,type:entitlement.entitlement_type,status:entitlement.status,grantedAt:entitlement.granted_at,endsAt:entitlement.ends_at},ownership:{scope:ownership.ownership_scope,editionId:ownership.edition_id,workId:ownership.work_id,acquiredPublicationVersionId:ownership.publication_version_id,ownerUpdatePolicy:ownership.owner_update_policy,redownloadPolicy:ownership.redownload_policy,rightsExpiryPolicy:ownership.rights_expiry_policy,removalPolicy:ownership.removal_policy,annotationsPolicy:ownership.annotations_policy,biosyncPolicy:ownership.biosync_policy},resolvedPublicationVersionId:resolved,assetVersionId:asset.asset_version_id,distribution:control||{distribution_status:"distributable",allow_existing_owners:1},biosync:{validForResolvedVersion:!!biosync,linkId:biosync?.id||null,audiobookProductId:biosync?.audiobook_product_id||null}};
}

export async function setCommercialDeliveryPolicy(db:DB,actorUserId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1),requireDeviceRegistration:z.boolean().default(false),maxActiveDevices:z.number().int().min(1).max(100).default(6),maxDownloadsPerEntitlement:z.number().int().min(1).max(100000).default(50),tokenTtlSeconds:z.number().int().min(30).max(3600).default(300),tokenMaxUses:z.number().int().min(1).max(20).default(2),watermarkMode:z.enum(["none","license_marker"]).default("none"),encryptionMode:z.enum(["none","external_wrapped_key"]).default("none"),allowBrowserRead:z.boolean().default(true),allowFileDownload:z.boolean().default(true)}).parse(raw),at=now();
  const product=await db.prepare("SELECT id FROM products WHERE id=?").bind(x.productId).first<any>();if(!product)throw new ApiError(404,"Product not found.");
  await db.prepare(`INSERT INTO commercial_delivery_policies(product_id,require_device_registration,max_active_devices,max_downloads_per_entitlement,token_ttl_seconds,token_max_uses,watermark_mode,encryption_mode,allow_browser_read,allow_file_download,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET require_device_registration=excluded.require_device_registration,max_active_devices=excluded.max_active_devices,max_downloads_per_entitlement=excluded.max_downloads_per_entitlement,token_ttl_seconds=excluded.token_ttl_seconds,token_max_uses=excluded.token_max_uses,watermark_mode=excluded.watermark_mode,encryption_mode=excluded.encryption_mode,allow_browser_read=excluded.allow_browser_read,allow_file_download=excluded.allow_file_download,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(x.productId,Number(x.requireDeviceRegistration),x.maxActiveDevices,x.maxDownloadsPerEntitlement,x.tokenTtlSeconds,x.tokenMaxUses,x.watermarkMode,x.encryptionMode,Number(x.allowBrowserRead),Number(x.allowFileDownload),actorUserId,at,at).run();
  // Policy changes affect newly issued grants only. Existing grants retain their immutable policy snapshot.
  return{saved:true,productId:x.productId,policy:x};
}

export async function setDistributionControl(db:DB,actorUserId:string,raw:unknown){
  const x=z.object({publicationVersionId:z.string().min(1),status:z.enum(["distributable","owner_only","blocked","recalled"]),allowExistingOwners:z.boolean().default(true),reasonCode:z.string().max(120).default(""),reasonDetail:z.string().max(2000).default("")}).parse(raw),at=now(),prev=await db.prepare("SELECT * FROM publication_version_distribution_controls WHERE publication_version_id=?").bind(x.publicationVersionId).first<any>();
  await db.prepare(`INSERT INTO publication_version_distribution_controls(publication_version_id,distribution_status,allow_existing_owners,reason_code,reason_detail,effective_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(publication_version_id) DO UPDATE SET distribution_status=excluded.distribution_status,allow_existing_owners=excluded.allow_existing_owners,reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,effective_at=excluded.effective_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(x.publicationVersionId,x.status,Number(x.allowExistingOwners),x.reasonCode,x.reasonDetail,at,actorUserId,at).run();
  await db.prepare("INSERT INTO publication_version_distribution_events(id,publication_version_id,from_status,to_status,allow_existing_owners,reason_code,reason_detail,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(uid("dist"),x.publicationVersionId,prev?.distribution_status||null,x.status,Number(x.allowExistingOwners),x.reasonCode,x.reasonDetail,actorUserId,at).run();
  if(["blocked","recalled"].includes(x.status)&&!x.allowExistingOwners)await db.prepare("UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason=? WHERE publication_version_id=? AND status='active'").bind(at,`distribution_${x.status}`,x.publicationVersionId).run();return{saved:true};
}

export async function snapshotAnnotationAnchor(db:DB,userId:string,raw:unknown){
  const x=z.object({annotationId:z.string().min(1),productId:z.string().min(1),publicationVersionId:z.string().nullable().optional(),assetVersionId:z.string().nullable().optional(),prefixText:z.string().max(256).default(""),suffixText:z.string().max(256).default("")}).parse(raw),a=await db.prepare("SELECT * FROM annotations WHERE id=? AND user_id=? AND deleted_at IS NULL").bind(x.annotationId,userId).first<any>();if(!a)throw new ApiError(404,"Annotation not found.");const qh=await sha256(String(a.quote||"")),at=now();await db.prepare(`INSERT INTO annotation_version_anchors(annotation_id,product_id,publication_version_id,asset_version_id,cfi,quote_hash,prefix_text,suffix_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(annotation_id) DO UPDATE SET product_id=excluded.product_id,publication_version_id=excluded.publication_version_id,asset_version_id=excluded.asset_version_id,cfi=excluded.cfi,quote_hash=excluded.quote_hash,prefix_text=excluded.prefix_text,suffix_text=excluded.suffix_text,updated_at=excluded.updated_at`).bind(a.id,x.productId,x.publicationVersionId||null,x.assetVersionId||null,a.cfi,qh,x.prefixText,x.suffixText,at,at).run();return{saved:true,quoteHash:qh};
}
