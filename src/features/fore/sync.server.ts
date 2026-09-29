import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";

type DB = CoveEnv["DB"];
const id = (p: string) => `${p}_${crypto.randomUUID()}`;

const entityTypeSchema = z.enum([
  "reading_position",
  "annotation",
  "text_bookmark",
  "reader_setting",
  "audio_location",
  "biosync_location",
  "shelf",
  "wishlist",
  "sample",
  "download_metadata",
  "device_state",
]);

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hashPayload(payload: unknown) {
  return sha256(JSON.stringify(canonical(payload)));
}
async function clientKeyHash(key: string) {
  return sha256(`fore-sync-client-v1:${key}`);
}
function parseJson(value: unknown, fallback: any = {}) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export async function registerSyncClient(db: DB, userId: string, raw: unknown) {
  const x = z.object({
    clientKey: z.string().min(24).max(512),
    name: z.string().trim().max(120).default(""),
    platform: z.string().trim().max(80).default("web"),
    appVersion: z.string().trim().max(80).default(""),
    capabilities: z.record(z.any()).optional(),
  }).parse(raw);
  const hash = await clientKeyHash(x.clientKey), at = now();
  let row = await db.prepare("SELECT * FROM sync_clients WHERE user_id=? AND client_key_hash=?").bind(userId, hash).first<any>();
  if (row?.status === "revoked") throw new ApiError(403, "This sync client has been revoked. Register a new device identity.");
  if (!row) {
    const clientId = id("syncdev");
    await db.prepare("INSERT INTO sync_clients(id,user_id,client_key_hash,name,platform,app_version,capabilities_json,status,last_cursor,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,'active',0,?,?)")
      .bind(clientId, userId, hash, x.name, x.platform, x.appVersion, JSON.stringify(x.capabilities||{}), at, at).run();
    row = await db.prepare("SELECT * FROM sync_clients WHERE id=?").bind(clientId).first<any>();
  } else {
    const capabilities=x.capabilities??parseJson(row.capabilities_json,{});
    await db.prepare("UPDATE sync_clients SET name=?,platform=?,app_version=?,capabilities_json=?,last_seen_at=? WHERE id=?").bind(x.name || row.name, x.platform || row.platform, x.appVersion || row.app_version, JSON.stringify(capabilities), at, row.id).run();
    row = { ...row, name: x.name || row.name, platform: x.platform || row.platform, app_version: x.appVersion || row.app_version, capabilities_json: JSON.stringify(capabilities), last_seen_at: at };
  }
  await recordSyncProjection(db,{userId,entityType:"device_state",entityId:String(row.id),payload:{clientId:String(row.id),capabilities:parseJson(row.capabilities_json,{}),lastSeenAt:row.last_seen_at}});
  return { clientId: row.id, cursor: Number(row.last_cursor || 0), name: row.name, platform: row.platform, capabilities: parseJson(row.capabilities_json,{}) };
}

export async function listSyncClients(db:DB,userId:string){const rows=(await db.prepare("SELECT id,name,platform,app_version,capabilities_json,status,last_cursor,last_seen_at,created_at,revoked_at FROM sync_clients WHERE user_id=? ORDER BY last_seen_at DESC").bind(userId).all<any>()).results;return{clients:rows.map((r:any)=>({clientId:r.id,name:r.name,platform:r.platform,appVersion:r.app_version,capabilities:parseJson(r.capabilities_json,{}),status:r.status,cursor:Number(r.last_cursor||0),lastSeenAt:r.last_seen_at,createdAt:r.created_at,revokedAt:r.revoked_at||null}))};}

export async function revokeSyncClient(db:DB,userId:string,raw:unknown){const x=z.object({clientId:z.string().min(1)}).parse(raw),at=now();const r=await db.prepare("UPDATE sync_clients SET status='revoked',revoked_at=?,last_seen_at=? WHERE id=? AND user_id=? AND status='active' RETURNING id").bind(at,at,x.clientId,userId).first<any>();if(!r)throw new ApiError(404,"Active sync client not found.");await recordSyncProjection(db,{userId,entityType:"device_state",entityId:x.clientId,payload:{clientId:x.clientId,capabilities:{syncRevoked:true},lastSeenAt:at},tombstone:true});return{revoked:true,clientId:x.clientId};}

async function requireSyncClient(db: DB, userId: string, clientId: string) {
  const row = await db.prepare("SELECT * FROM sync_clients WHERE id=? AND user_id=? AND status='active'").bind(clientId, userId).first<any>();
  if (!row) throw new ApiError(403, "This sync client is not registered or has been revoked.");
  await db.prepare("UPDATE sync_clients SET last_seen_at=? WHERE id=?").bind(now(), clientId).run();
  return row;
}

async function appendMutation(db: DB, input: { userId: string; entityType: string; entityId: string; version: number; operation: "upsert"|"delete"; payload: unknown; contentSha256: string; clientId?: string | null; mutationId?: string | null }) {
  const at = now();
  const row = await db.prepare(`INSERT INTO sync_mutations(user_id,entity_type,entity_id,version,operation,payload_json,content_sha256,client_id,mutation_id,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING sequence`).bind(input.userId,input.entityType,input.entityId,input.version,input.operation,JSON.stringify(input.payload ?? {}),input.contentSha256,input.clientId||null,input.mutationId||null,at).first<any>();
  return Number(row?.sequence || 0);
}

export async function recordSyncProjection(db: DB, input: { userId: string; entityType: z.infer<typeof entityTypeSchema>; entityId: string; payload: unknown; tombstone?: boolean; clientId?: string | null; mutationId?: string | null; explicitVersion?: number }) {
  const at=now(), payload=input.payload ?? {}, hash=await hashPayload(payload), current=await db.prepare("SELECT * FROM sync_records WHERE user_id=? AND entity_type=? AND entity_id=?").bind(input.userId,input.entityType,input.entityId).first<any>();
  if(current && current.content_sha256===hash && Number(current.tombstone)===Number(!!input.tombstone) && (input.explicitVersion==null || input.explicitVersion===Number(current.version))) return {version:Number(current.version),unchanged:true};
  const version=input.explicitVersion ?? (Number(current?.version||0)+1);
  if(current && version < Number(current.version)) return {version:Number(current.version),unchanged:true};
  await db.prepare(`INSERT INTO sync_records(user_id,entity_type,entity_id,version,payload_json,tombstone,content_sha256,updated_by_client_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET version=excluded.version,payload_json=excluded.payload_json,tombstone=excluded.tombstone,content_sha256=excluded.content_sha256,updated_by_client_id=excluded.updated_by_client_id,updated_at=excluded.updated_at`)
    .bind(input.userId,input.entityType,input.entityId,version,JSON.stringify(payload),input.tombstone?1:0,hash,input.clientId||null,current?.created_at||at,at).run();
  const sequence=await appendMutation(db,{userId:input.userId,entityType:input.entityType,entityId:input.entityId,version,operation:input.tombstone?"delete":"upsert",payload,contentSha256:hash,clientId:input.clientId,mutationId:input.mutationId});
  return {version,sequence,unchanged:false};
}

const mutationSchema = z.object({
  mutationId: z.string().min(8).max(180),
  entityType: entityTypeSchema,
  entityId: z.string().min(1).max(300),
  expectedVersion: z.number().int().min(0),
  operation: z.enum(["upsert","delete"]),
  payload: z.record(z.any()).default({}),
});

function validatePayload(entityType: z.infer<typeof entityTypeSchema>, payload: Record<string, any>, clientId: string) {
  const commonString=(v:any,max=4000)=>typeof v==="string"&&v.length<=max;
  if(entityType==="reading_position") z.object({productId:z.string().min(1),externalBookId:z.string().min(1),cfi:z.string().max(4000),progress:z.number().min(0).max(1),status:z.enum(["want-to-read","reading","finished"]).optional()}).parse(payload);
  else if(entityType==="annotation") z.object({bookId:z.string().min(1),bookTitle:z.string().max(500).optional(),author:z.string().max(500).optional(),cfi:z.string().max(4000),quote:z.string().max(12000),chapter:z.string().max(500),color:z.string().max(40),note:z.string().max(12000),progress:z.number().min(0).max(1).nullable().optional()}).parse(payload);
  else if(entityType==="text_bookmark") z.object({productId:z.string().min(1),externalBookId:z.string().min(1),cfi:z.string().max(4000),chapter:z.string().max(500),label:z.string().max(300),excerpt:z.string().max(1000),progress:z.number().min(0).max(1)}).parse(payload);
  else if(entityType==="reader_setting") z.object({key:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),value:z.any()}).parse(payload);
  else if(entityType==="audio_location") z.object({productId:z.string().min(1),trackId:z.string().min(1),seconds:z.number().min(0),speed:z.number().min(.5).max(3)}).parse(payload);
  else if(entityType==="biosync_location") z.object({bookId:z.string().min(1),editionId:z.string().min(1),trackId:z.string().min(1),seconds:z.number().min(0),cfi:z.string().max(4000),mode:z.enum(["text","audio"]),epubSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),audioSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(payload);
  else if(entityType==="shelf") z.object({name:z.string().max(160).optional(),visibility:z.enum(["public","private"]).optional(),productIds:z.array(z.string()).max(5000).optional()}).parse(payload);
  else if(entityType==="wishlist") z.object({productId:z.string().min(1),saved:z.boolean(),alerts:z.record(z.boolean()).optional()}).parse(payload);
  else if(entityType==="sample") z.object({productId:z.string().min(1),cfi:z.string().max(4000),progress:z.number().min(0).max(1)}).parse(payload);
  else if(entityType==="download_metadata") {
    const x=z.object({clientId:z.string().min(1),productId:z.string().min(1),state:z.enum(["queued","downloading","available","stale","removed","failed"]),assetSha256:z.string().max(64).default(""),bytesDownloaded:z.number().int().min(0).default(0),totalBytes:z.number().int().min(0).nullable().optional(),offlineLicenseExpiresAt:z.string().datetime().nullable().optional()}).parse(payload);
    if(x.clientId!==clientId) throw new ApiError(403,"Download metadata is device scoped and cannot be written for another sync client.");
  } else if(entityType==="device_state") {
    const x=z.object({clientId:z.string().min(1),capabilities:z.record(z.any()).default({}),lastSeenAt:z.string().datetime().optional()}).parse(payload);
    if(x.clientId!==clientId) throw new ApiError(403,"Device state is scoped to the authenticated sync client.");
  }
  if(JSON.stringify(payload).length>100_000 || !commonString(JSON.stringify(payload),100_000)) throw new ApiError(413,"Sync record is too large.");
}

async function applyDomainMutation(db:DB,userId:string,clientId:string,m:z.infer<typeof mutationSchema>,nextVersion:number){
  const p=m.payload as Record<string,any>,at=now(),deleting=m.operation==="delete";
  if(m.entityType==="reading_position"){
    const product=await db.prepare("SELECT id FROM products WHERE id=?").bind(p.productId).first<any>();if(!product)throw new ApiError(404,"Sync product not found.");
    const access=await db.prepare("SELECT 1 ok FROM entitlements WHERE user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1").bind(userId,p.productId,at,at).first<any>();if(!access)throw new ApiError(403,"Active access is required to synchronize this reading position.");
    const current=await db.prepare("SELECT version FROM reading_states WHERE user_id=? AND product_id=?").bind(userId,p.productId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"The reading position changed while this sync mutation was being applied.");
    if(current){const r=await db.prepare("UPDATE reading_states SET external_book_id=?,in_library=?,status=?,progress=?,cfi=?,updated_at=?,version=? WHERE user_id=? AND product_id=? AND version=? RETURNING version").bind(p.externalBookId,deleting?0:1,p.status||"reading",p.progress,p.cfi,at,nextVersion,userId,p.productId,m.expectedVersion).first<any>();if(!r)throw new ApiError(409,"Reading state concurrency conflict.");}
    else if(!deleting){const r=await db.prepare("INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,legacy_shelves_json,legacy_review,review_migrated,updated_at,version) VALUES(?,?,?,1,?,?,?,'[]','',0,?,?) ON CONFLICT(user_id,product_id) DO NOTHING RETURNING version").bind(userId,p.productId,p.externalBookId,p.status||"reading",p.progress,p.cfi,at,nextVersion).first<any>();if(!r)throw new ApiError(409,"Reading state concurrency conflict.");}
  }else if(m.entityType==="annotation"){
    const current=await db.prepare("SELECT * FROM annotations WHERE id=? AND user_id=?").bind(m.entityId,userId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Annotation concurrency conflict.");
    if(deleting){if(current)await db.prepare("UPDATE annotations SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?").bind(at,at,nextVersion,m.entityId,userId,m.expectedVersion).run();}
    else if(current){await db.prepare("UPDATE annotations SET cfi=?,quote=?,chapter=?,color=?,note=?,progress=?,deleted_at=NULL,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?").bind(p.cfi,p.quote,p.chapter,p.color,p.note,p.progress??current.progress??null,at,nextVersion,m.entityId,userId,m.expectedVersion).run();}
    else{await db.prepare("INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at,version,deleted_at,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").bind(m.entityId,userId,p.bookId,p.bookTitle||"",p.author||"",p.quote,p.cfi,p.chapter,p.color,p.note,at,at,nextVersion,p.progress??null).run();}
  }else if(m.entityType==="text_bookmark"){
    const current=await db.prepare("SELECT * FROM text_bookmarks WHERE id=? AND user_id=?").bind(m.entityId,userId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Bookmark concurrency conflict.");
    if(deleting){if(current)await db.prepare("UPDATE text_bookmarks SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?").bind(at,at,nextVersion,m.entityId,userId,m.expectedVersion).run();}
    else if(current){await db.prepare("UPDATE text_bookmarks SET cfi=?,chapter=?,label=?,excerpt=?,progress=?,deleted_at=NULL,updated_at=?,version=?,created_by_client_id=? WHERE id=? AND user_id=? AND version=?").bind(p.cfi,p.chapter,p.label,p.excerpt,p.progress,at,nextVersion,clientId,m.entityId,userId,m.expectedVersion).run();}
    else{const access=await db.prepare("SELECT 1 ok FROM entitlements WHERE user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1").bind(userId,p.productId,at,at).first<any>();if(!access)throw new ApiError(403,"Active access is required to synchronize this bookmark.");await db.prepare("INSERT INTO text_bookmarks(id,user_id,product_id,external_book_id,cfi,chapter,label,excerpt,progress,version,created_by_client_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(m.entityId,userId,p.productId,p.externalBookId,p.cfi,p.chapter,p.label,p.excerpt,p.progress,nextVersion,clientId,at,at).run();}
  }else if(m.entityType==="reader_setting"){
    if(deleting)await db.prepare("DELETE FROM reader_settings WHERE user_id=? AND setting_key=? AND version=?").bind(userId,p.key,m.expectedVersion).run();
    else await db.prepare("INSERT INTO reader_settings(user_id,setting_key,value_json,version,updated_by_client_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,setting_key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,updated_by_client_id=excluded.updated_by_client_id,updated_at=excluded.updated_at WHERE reader_settings.version=?").bind(userId,p.key,JSON.stringify(p.value),nextVersion,clientId,at,m.expectedVersion).run();
  }else if(m.entityType==="sample"){
    const current=await db.prepare("SELECT version FROM preview_states WHERE user_id=? AND product_id=?").bind(userId,p.productId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Sample concurrency conflict.");
    if(deleting){if(current)await db.prepare("DELETE FROM preview_states WHERE user_id=? AND product_id=? AND version=?").bind(userId,p.productId,m.expectedVersion).run();}
    else if(current)await db.prepare("UPDATE preview_states SET cfi=?,sample_progress=?,updated_at=?,version=? WHERE user_id=? AND product_id=? AND version=?").bind(p.cfi,p.progress,at,nextVersion,userId,p.productId,m.expectedVersion).run();
    else await db.prepare("INSERT INTO preview_states(user_id,product_id,cfi,sample_progress,started_at,updated_at,version) VALUES(?,?,?,?,?,?,?)").bind(userId,p.productId,p.cfi,p.progress,at,at,nextVersion).run();
  }else if(m.entityType==="wishlist"){
    if(deleting||!p.saved)await db.prepare("DELETE FROM wishlist_items WHERE user_id=? AND product_id=?").bind(userId,p.productId).run();
    else{const a=p.alerts||{};await db.prepare(`INSERT INTO wishlist_items(user_id,product_id,added_at,alert_price_drop,alert_sale,alert_release,alert_preorder,source_surface,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET alert_price_drop=excluded.alert_price_drop,alert_sale=excluded.alert_sale,alert_release=excluded.alert_release,alert_preorder=excluded.alert_preorder,updated_at=excluded.updated_at`).bind(userId,p.productId,at,a.priceDrop===false?0:1,a.sale===false?0:1,a.release===false?0:1,a.preorder===false?0:1,"sync",at).run();}
  }else if(m.entityType==="shelf"){
    const current=await db.prepare("SELECT version FROM shelves WHERE id=? AND user_id=?").bind(m.entityId,userId).first<any>();
    if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Shelf concurrency conflict.");
    if(deleting){if(current){const removed=await db.prepare("DELETE FROM shelves WHERE id=? AND user_id=? AND version=? RETURNING id").bind(m.entityId,userId,m.expectedVersion).first<any>();if(!removed)throw new ApiError(409,"Shelf concurrency conflict.");}}
    else if(current){const changed=await db.prepare("UPDATE shelves SET name=?,visibility=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=? RETURNING version").bind(p.name||"Shelf",p.visibility||"private",at,nextVersion,m.entityId,userId,m.expectedVersion).first<any>();if(!changed)throw new ApiError(409,"Shelf concurrency conflict.");await db.prepare("DELETE FROM shelf_items WHERE shelf_id=?").bind(m.entityId).run();let pos=0;for(const productId of (p.productIds||[])){const product=await db.prepare("SELECT source_external_id FROM products WHERE id=?").bind(productId).first<any>();if(product)await db.prepare("INSERT OR IGNORE INTO shelf_items(shelf_id,product_id,external_book_id,position,note,added_at) VALUES(?,?,?,?,?,?)").bind(m.entityId,productId,product.source_external_id,pos++,"",at).run();}}
    else{await db.prepare("INSERT INTO shelves(id,user_id,name,description,visibility,created_at,updated_at,version) VALUES(?,?,?,'',?,?,?,?)").bind(m.entityId,userId,p.name||"Shelf",p.visibility||"private",at,at,nextVersion).run();let pos=0;for(const productId of (p.productIds||[])){const product=await db.prepare("SELECT source_external_id FROM products WHERE id=?").bind(productId).first<any>();if(product)await db.prepare("INSERT OR IGNORE INTO shelf_items(shelf_id,product_id,external_book_id,position,note,added_at) VALUES(?,?,?,?,?,?)").bind(m.entityId,productId,product.source_external_id,pos++,"",at).run();}}
  }else if(m.entityType==="download_metadata"){
    if(deleting)await db.prepare("DELETE FROM sync_download_metadata WHERE user_id=? AND client_id=? AND product_id=?").bind(userId,clientId,p.productId).run();
    else await db.prepare(`INSERT INTO sync_download_metadata(user_id,client_id,product_id,asset_sha256,state,bytes_downloaded,total_bytes,offline_license_expires_at,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,client_id,product_id) DO UPDATE SET asset_sha256=excluded.asset_sha256,state=excluded.state,bytes_downloaded=excluded.bytes_downloaded,total_bytes=excluded.total_bytes,offline_license_expires_at=excluded.offline_license_expires_at,version=excluded.version,updated_at=excluded.updated_at`).bind(userId,clientId,p.productId,p.assetSha256||"",p.state,p.bytesDownloaded||0,p.totalBytes??null,p.offlineLicenseExpiresAt||null,nextVersion,at).run();
  }else if(m.entityType==="device_state"){
    if(deleting) throw new ApiError(409,"Device-state records are revoked through the sync-client revocation endpoint, not generic sync deletion.");
    if(m.entityId!==clientId||p.clientId!==clientId) throw new ApiError(403,"A sync client may update only its own device-state record.");
    const current=await db.prepare("SELECT capabilities_json,status FROM sync_clients WHERE id=? AND user_id=?").bind(clientId,userId).first<any>();
    if(!current||current.status!=="active")throw new ApiError(403,"This sync client is not active.");
    await db.prepare("UPDATE sync_clients SET capabilities_json=?,last_seen_at=? WHERE id=? AND user_id=? AND status='active'").bind(JSON.stringify(p.capabilities||{}),at,clientId,userId).run();
  }else if(m.entityType==="audio_location"){
    const current=await db.prepare("SELECT version FROM commercial_audio_playback WHERE user_id=? AND product_id=?").bind(userId,p.productId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Audiobook position concurrency conflict.");
    if(deleting){if(current)await db.prepare("DELETE FROM commercial_audio_playback WHERE user_id=? AND product_id=? AND version=?").bind(userId,p.productId,m.expectedVersion).run();}
    else if(current)await db.prepare("UPDATE commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=?,updated_at=? WHERE user_id=? AND product_id=? AND version=?").bind(p.trackId,p.seconds,p.speed,nextVersion,at,userId,p.productId,m.expectedVersion).run();
    else await db.prepare("INSERT INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,?,?)").bind(userId,p.productId,p.trackId,p.seconds,p.speed,nextVersion,at).run();
  }else if(m.entityType==="biosync_location"){
    const commercial=await db.prepare("SELECT id FROM commercial_biosync_links WHERE id=?").bind(m.entityId).first<any>();
    if(commercial){const current=await db.prepare("SELECT version FROM commercial_biosync_positions WHERE user_id=? AND biosync_link_id=?").bind(userId,m.entityId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Biosync concurrency conflict.");if(deleting){if(current)await db.prepare("DELETE FROM commercial_biosync_positions WHERE user_id=? AND biosync_link_id=? AND version=?").bind(userId,m.entityId,m.expectedVersion).run();}else await db.prepare(`INSERT INTO commercial_biosync_positions(user_id,biosync_link_id,mode,cfi,chapter_id,audio_ms,version,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,biosync_link_id) DO UPDATE SET mode=excluded.mode,cfi=excluded.cfi,chapter_id=excluded.chapter_id,audio_ms=excluded.audio_ms,version=excluded.version,updated_at=excluded.updated_at WHERE commercial_biosync_positions.version=?`).bind(userId,m.entityId,p.mode,p.cfi,p.trackId,Math.round(Number(p.seconds)*1000),nextVersion,at,m.expectedVersion).run();}
    else if(p.epubSha256&&p.audioSha256){const current=await db.prepare("SELECT version FROM biosync_positions WHERE user_id=? AND book_id=?").bind(userId,p.bookId).first<any>();if(Number(current?.version||0)!==m.expectedVersion)throw new ApiError(409,"Biosync concurrency conflict.");if(deleting){if(current)await db.prepare("DELETE FROM biosync_positions WHERE user_id=? AND book_id=? AND version=?").bind(userId,p.bookId,m.expectedVersion).run();}else await db.prepare(`INSERT INTO biosync_positions(user_id,book_id,edition_id,mode,cfi,track_id,seconds,epub_sha256,audio_sha256,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET edition_id=excluded.edition_id,mode=excluded.mode,cfi=excluded.cfi,track_id=excluded.track_id,seconds=excluded.seconds,epub_sha256=excluded.epub_sha256,audio_sha256=excluded.audio_sha256,version=excluded.version,updated_at=excluded.updated_at WHERE biosync_positions.version=?`).bind(userId,p.bookId,p.editionId,p.mode,p.cfi,p.trackId,p.seconds,p.epubSha256,p.audioSha256,nextVersion,at,m.expectedVersion).run();}
  }
}

export async function pushSyncBatch(db: DB, userId: string, raw: unknown) {
  const x=z.object({clientId:z.string().min(1),mutations:z.array(mutationSchema).min(1).max(100)}).parse(raw);
  await requireSyncClient(db,userId,x.clientId);
  const results:any[]=[];
  for(const m of x.mutations){
    validatePayload(m.entityType,m.payload,x.clientId);
    const duplicate=await db.prepare("SELECT sequence,version FROM sync_mutations WHERE user_id=? AND client_id=? AND mutation_id=?").bind(userId,x.clientId,m.mutationId).first<any>();
    if(duplicate){results.push({mutationId:m.mutationId,status:"duplicate",sequence:Number(duplicate.sequence),version:Number(duplicate.version)});continue;}
    const current=await db.prepare("SELECT * FROM sync_records WHERE user_id=? AND entity_type=? AND entity_id=?").bind(userId,m.entityType,m.entityId).first<any>(), serverVersion=Number(current?.version||0);
    if(serverVersion!==m.expectedVersion){
      const conflictId=id("syncconf"),at=now();
      await db.prepare(`INSERT INTO sync_conflicts(id,user_id,entity_type,entity_id,client_id,mutation_id,expected_version,server_version,incoming_operation,incoming_payload_json,server_payload_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?)`).bind(conflictId,userId,m.entityType,m.entityId,x.clientId,m.mutationId,m.expectedVersion,serverVersion,m.operation,JSON.stringify(m.payload),current?.payload_json||"{}",at).run();
      results.push({mutationId:m.mutationId,status:"conflict",conflictId,expectedVersion:m.expectedVersion,serverVersion,server:current?{version:serverVersion,payload:parseJson(current.payload_json,{}),tombstone:!!current.tombstone}:null});continue;
    }
    await applyDomainMutation(db,userId,x.clientId,m,serverVersion+1);
    const saved=await recordSyncProjection(db,{userId,entityType:m.entityType,entityId:m.entityId,payload:m.payload,tombstone:m.operation==="delete",clientId:x.clientId,mutationId:m.mutationId,explicitVersion:serverVersion+1});
    results.push({mutationId:m.mutationId,status:"applied",version:saved.version,sequence:saved.sequence});
  }
  return {results};
}

export async function pullSyncChanges(db: DB, userId: string, raw: unknown) {
  const x=z.object({clientId:z.string().min(1),cursor:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(1000).default(250)}).parse(raw);
  await requireSyncClient(db,userId,x.clientId);
  const rows=(await db.prepare(`SELECT sequence,entity_type,entity_id,version,operation,payload_json,content_sha256,client_id,occurred_at FROM sync_mutations WHERE user_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?`).bind(userId,x.cursor,x.limit).all<any>()).results;
  const nextCursor=rows.length?Number(rows[rows.length-1].sequence):x.cursor;
  await db.prepare("UPDATE sync_clients SET last_cursor=?,last_seen_at=? WHERE id=? AND user_id=?").bind(nextCursor,now(),x.clientId,userId).run();
  return {cursor:x.cursor,nextCursor,hasMore:rows.length===x.limit,changes:rows.map((r:any)=>({sequence:Number(r.sequence),entityType:r.entity_type,entityId:r.entity_id,version:Number(r.version),operation:r.operation,payload:parseJson(r.payload_json,{}),contentSha256:r.content_sha256,sourceClientId:r.client_id,occurredAt:r.occurred_at}))};
}

export async function resolveSyncConflict(db:DB,userId:string,raw:unknown){
  const x=z.object({clientId:z.string().min(1),conflictId:z.string().min(1),resolution:z.enum(["keep_server","accept_client","merged"]),payload:z.record(z.any()).optional()}).parse(raw);await requireSyncClient(db,userId,x.clientId);
  const c=await db.prepare("SELECT * FROM sync_conflicts WHERE id=? AND user_id=? AND status='open'").bind(x.conflictId,userId).first<any>();if(!c)throw new ApiError(404,"Open sync conflict not found.");
  const current=await db.prepare("SELECT * FROM sync_records WHERE user_id=? AND entity_type=? AND entity_id=?").bind(userId,c.entity_type,c.entity_id).first<any>();if(!current)throw new ApiError(409,"The conflicted record no longer exists. Pull changes and retry.");
  let resolutionPayload=parseJson(current.payload_json,{}),status="resolved_keep_server";
  if(x.resolution!=="keep_server"){
    resolutionPayload=x.resolution==="accept_client"?parseJson(c.incoming_payload_json,{}):(x.payload||{});
    const resolvedType=entityTypeSchema.parse(c.entity_type), operation=(x.resolution==="accept_client"&&c.incoming_operation==="delete")?"delete":"upsert";
    validatePayload(resolvedType,resolutionPayload,x.clientId);
    const domainMutation=mutationSchema.parse({mutationId:`resolve:${c.id}:${crypto.randomUUID()}`,entityType:resolvedType,entityId:c.entity_id,expectedVersion:Number(current.version),operation,payload:resolutionPayload});
    await applyDomainMutation(db,userId,x.clientId,domainMutation,Number(current.version)+1);
    await recordSyncProjection(db,{userId,entityType:resolvedType,entityId:c.entity_id,payload:resolutionPayload,tombstone:operation==="delete",clientId:x.clientId,mutationId:domainMutation.mutationId,explicitVersion:Number(current.version)+1});
    status=x.resolution==="accept_client"?"resolved_accept_client":"resolved_merged";
  }
  await db.prepare("UPDATE sync_conflicts SET status=?,resolution_payload_json=?,resolved_by_client_id=?,resolved_at=? WHERE id=?").bind(status,JSON.stringify(resolutionPayload),x.clientId,now(),c.id).run();
  return{resolved:true,status,payload:resolutionPayload};
}

export async function syncConflicts(db:DB,userId:string){const rows=(await db.prepare("SELECT * FROM sync_conflicts WHERE user_id=? AND status='open' ORDER BY created_at DESC LIMIT 250").bind(userId).all<any>()).results;return{conflicts:rows.map((r:any)=>({...r,incoming:parseJson(r.incoming_payload_json,{}),server:parseJson(r.server_payload_json,{})}))};}

export async function saveReaderSetting(db:DB,userId:string,raw:unknown){
  const x=z.object({clientId:z.string().min(1),key:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),value:z.any(),expectedVersion:z.number().int().min(0)}).parse(raw);await requireSyncClient(db,userId,x.clientId);
  const current=await db.prepare("SELECT * FROM reader_settings WHERE user_id=? AND setting_key=?").bind(userId,x.key).first<any>(),version=Number(current?.version||0);if(version!==x.expectedVersion)throw Object.assign(new ApiError(409,"This reader setting changed on another device."),{syncConflict:{serverVersion:version,serverValue:parseJson(current?.value_json,null)}});
  const next=version+1,at=now();await db.prepare(`INSERT INTO reader_settings(user_id,setting_key,value_json,version,updated_by_client_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,setting_key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,updated_by_client_id=excluded.updated_by_client_id,updated_at=excluded.updated_at`).bind(userId,x.key,JSON.stringify(x.value),next,x.clientId,at).run();
  await recordSyncProjection(db,{userId,entityType:"reader_setting",entityId:x.key,payload:{key:x.key,value:x.value},clientId:x.clientId,explicitVersion:next});return{saved:true,version:next,updatedAt:at};
}
export async function readerSettings(db:DB,userId:string){const rows=(await db.prepare("SELECT setting_key,value_json,version,updated_at FROM reader_settings WHERE user_id=? ORDER BY setting_key").bind(userId).all<any>()).results;return{settings:Object.fromEntries(rows.map((r:any)=>[r.setting_key,{value:parseJson(r.value_json,null),version:Number(r.version),updatedAt:r.updated_at}]))};}

export async function listTextBookmarks(db:DB,userId:string,externalBookId?:string){const rows=(await db.prepare(`SELECT * FROM text_bookmarks WHERE user_id=? AND deleted_at IS NULL ${externalBookId?"AND external_book_id=?":""} ORDER BY created_at DESC`).bind(userId,...(externalBookId?[externalBookId]:[])).all<any>()).results;return{bookmarks:rows.map((r:any)=>({id:r.id,bookId:r.external_book_id,productId:r.product_id,cfi:r.cfi,chapter:r.chapter,label:r.label,excerpt:r.excerpt,progress:Number(r.progress),publicationVersionId:r.publication_version_id,assetVersionId:r.asset_version_id,version:Number(r.version),createdAt:r.created_at,updatedAt:r.updated_at}))};}

export async function createTextBookmark(db:DB,userId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1),externalBookId:z.string().min(1),cfi:z.string().min(1).max(4000),chapter:z.string().max(500).default(""),label:z.string().max(300).default(""),excerpt:z.string().max(1000).default(""),progress:z.number().min(0).max(1).default(0),clientId:z.string().nullable().optional()}).parse(raw),at=now(),bookmarkId=id("bm");
  if(x.clientId)await requireSyncClient(db,userId,x.clientId);
  const access=await db.prepare(`SELECT e.id entitlement_id FROM entitlements e WHERE e.user_id=? AND e.product_id=? AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?) LIMIT 1`).bind(userId,x.productId,at,at).first<any>();if(!access)throw new ApiError(403,"An active entitlement is required to bookmark this edition.");
  const ownership=await db.prepare(`SELECT o.publication_version_id FROM entitlement_ownership_records o WHERE o.user_id=? AND o.product_id=? ORDER BY o.acquired_at DESC LIMIT 1`).bind(userId,x.productId).first<any>();
  let assetVersionId:null|string=null;if(ownership?.publication_version_id){const pv=await db.prepare("SELECT manifest_json FROM publishing_publication_versions WHERE id=?").bind(ownership.publication_version_id).first<any>();const manifest=parseJson(pv?.manifest_json,{}),epub=(manifest.catalogAssets||[]).find((a:any)=>a.kind==="epub");assetVersionId=epub?.catalogAssetVersionId||null;}
  await db.prepare(`INSERT INTO text_bookmarks(id,user_id,product_id,external_book_id,cfi,chapter,label,excerpt,progress,publication_version_id,asset_version_id,version,created_by_client_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(bookmarkId,userId,x.productId,x.externalBookId,x.cfi,x.chapter,x.label,x.excerpt,x.progress,ownership?.publication_version_id||null,assetVersionId,1,x.clientId||null,at,at).run();
  await recordSyncProjection(db,{userId,entityType:"text_bookmark",entityId:bookmarkId,payload:{productId:x.productId,externalBookId:x.externalBookId,cfi:x.cfi,chapter:x.chapter,label:x.label,excerpt:x.excerpt,progress:x.progress},clientId:x.clientId||null,explicitVersion:1});
  return{id:bookmarkId,version:1,createdAt:at};
}
export async function updateTextBookmark(db:DB,userId:string,bookmarkId:string,raw:unknown){const x=z.object({label:z.string().max(300).optional(),cfi:z.string().min(1).max(4000).optional(),chapter:z.string().max(500).optional(),excerpt:z.string().max(1000).optional(),progress:z.number().min(0).max(1).optional(),expectedVersion:z.number().int().min(1),clientId:z.string().nullable().optional()}).parse(raw);if(x.clientId)await requireSyncClient(db,userId,x.clientId);const b=await db.prepare("SELECT * FROM text_bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL").bind(bookmarkId,userId).first<any>();if(!b)throw new ApiError(404,"Bookmark not found.");if(Number(b.version)!==x.expectedVersion)throw new ApiError(409,"This bookmark changed on another device. Reload before editing it.");const next=Number(b.version)+1,at=now(),payload={productId:b.product_id,externalBookId:b.external_book_id,cfi:x.cfi??b.cfi,chapter:x.chapter??b.chapter,label:x.label??b.label,excerpt:x.excerpt??b.excerpt,progress:x.progress??Number(b.progress)};await db.prepare("UPDATE text_bookmarks SET cfi=?,chapter=?,label=?,excerpt=?,progress=?,version=?,updated_at=? WHERE id=? AND user_id=? AND version=?").bind(payload.cfi,payload.chapter,payload.label,payload.excerpt,payload.progress,next,at,bookmarkId,userId,b.version).run();await recordSyncProjection(db,{userId,entityType:"text_bookmark",entityId:bookmarkId,payload,clientId:x.clientId||null,explicitVersion:next});return{saved:true,version:next,updatedAt:at};}
export async function deleteTextBookmark(db:DB,userId:string,bookmarkId:string,raw:unknown={}){const x=z.object({expectedVersion:z.number().int().min(1),clientId:z.string().nullable().optional()}).parse(raw);if(x.clientId)await requireSyncClient(db,userId,x.clientId);const b=await db.prepare("SELECT * FROM text_bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL").bind(bookmarkId,userId).first<any>();if(!b)return{deleted:true};if(Number(b.version)!==x.expectedVersion)throw new ApiError(409,"This bookmark changed on another device. Reload before deleting it.");const next=Number(b.version)+1,at=now(),payload={productId:b.product_id,externalBookId:b.external_book_id,cfi:b.cfi,chapter:b.chapter,label:b.label,excerpt:b.excerpt,progress:Number(b.progress)};await db.prepare("UPDATE text_bookmarks SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=?").bind(at,at,next,bookmarkId,userId).run();await recordSyncProjection(db,{userId,entityType:"text_bookmark",entityId:bookmarkId,payload,tombstone:true,clientId:x.clientId||null,explicitVersion:next});return{deleted:true,version:next};}

export async function syncBootstrapSnapshot(db:DB,userId:string){
  const [positions,annotations,bookmarks,settings,audio,biosync,commercialBiosync,shelves,wishlist,samples,downloads,devices]=await Promise.all([
    db.prepare("SELECT user_id,product_id,external_book_id,status,progress,cfi,version,updated_at,in_library FROM reading_states WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT id,book_id,book_title,author,cfi,quote,chapter,color,note,version,updated_at,deleted_at FROM annotations WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT * FROM text_bookmarks WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT setting_key,value_json,version,updated_at FROM reader_settings WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT product_id,chapter_id,seconds,speed,version,updated_at FROM commercial_audio_playback WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT book_id,edition_id,track_id,seconds,cfi,mode,epub_sha256,audio_sha256,version,updated_at FROM biosync_positions WHERE user_id=?").bind(userId).all<any>(),
    db.prepare(`SELECT p.biosync_link_id,p.mode,p.cfi,p.chapter_id,p.audio_ms,p.version,p.updated_at,l.ebook_product_id FROM commercial_biosync_positions p JOIN commercial_biosync_links l ON l.id=p.biosync_link_id WHERE p.user_id=?`).bind(userId).all<any>(),
    db.prepare("SELECT * FROM shelves WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT * FROM wishlist_items WHERE user_id=? ORDER BY added_at DESC").bind(userId).all<any>(),
    db.prepare("SELECT * FROM preview_states WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT * FROM sync_download_metadata WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT id,name,platform,app_version,capabilities_json,status,last_seen_at,created_at,revoked_at FROM sync_clients WHERE user_id=?").bind(userId).all<any>(),
  ]);
  // Backfill the mutation projection for legacy/current domain rows. recordSyncProjection is
  // content-addressed, so a bootstrap only emits a mutation when the domain state was not yet represented.
  for(const r of positions.results)await recordSyncProjection(db,{userId,entityType:"reading_position",entityId:String(r.product_id),payload:{productId:String(r.product_id),externalBookId:String(r.external_book_id),status:String(r.status),progress:Number(r.progress),cfi:String(r.cfi)},tombstone:!Number(r.in_library),explicitVersion:Number(r.version)});
  for(const r of annotations.results)await recordSyncProjection(db,{userId,entityType:"annotation",entityId:String(r.id),payload:{bookId:String(r.book_id),bookTitle:String(r.book_title||""),author:String(r.author||""),cfi:String(r.cfi),quote:String(r.quote),chapter:String(r.chapter),color:String(r.color),note:String(r.note)},tombstone:!!r.deleted_at,explicitVersion:Number(r.version)});
  for(const r of bookmarks.results)await recordSyncProjection(db,{userId,entityType:"text_bookmark",entityId:String(r.id),payload:{productId:String(r.product_id),externalBookId:String(r.external_book_id),cfi:String(r.cfi),chapter:String(r.chapter),label:String(r.label),excerpt:String(r.excerpt),progress:Number(r.progress)},tombstone:!!r.deleted_at,explicitVersion:Number(r.version)});
  for(const r of settings.results)await recordSyncProjection(db,{userId,entityType:"reader_setting",entityId:String(r.setting_key),payload:{key:String(r.setting_key),value:parseJson(r.value_json,null)},explicitVersion:Number(r.version)});
  for(const r of audio.results)await recordSyncProjection(db,{userId,entityType:"audio_location",entityId:String(r.product_id),payload:{productId:String(r.product_id),trackId:String(r.chapter_id),seconds:Number(r.seconds),speed:Number(r.speed)},explicitVersion:Number(r.version)});
  for(const r of biosync.results)await recordSyncProjection(db,{userId,entityType:"biosync_location",entityId:String(r.book_id),payload:{bookId:String(r.book_id),editionId:String(r.edition_id),trackId:String(r.track_id),seconds:Number(r.seconds),cfi:String(r.cfi),mode:r.mode,epubSha256:String(r.epub_sha256),audioSha256:String(r.audio_sha256)},explicitVersion:Number(r.version)});
  for(const r of commercialBiosync.results)await recordSyncProjection(db,{userId,entityType:"biosync_location",entityId:String(r.biosync_link_id),payload:{bookId:String(r.ebook_product_id),editionId:String(r.biosync_link_id),trackId:String(r.chapter_id||"current"),seconds:Number(r.audio_ms)/1000,cfi:String(r.cfi),mode:r.mode},explicitVersion:Number(r.version)});
  for(const r of shelves.results){const items=(await db.prepare("SELECT product_id FROM shelf_items WHERE shelf_id=? ORDER BY position,added_at").bind(r.id).all<any>()).results;await recordSyncProjection(db,{userId,entityType:"shelf",entityId:String(r.id),payload:{name:String(r.name),visibility:String(r.visibility),productIds:items.map((x:any)=>String(x.product_id))},explicitVersion:Number(r.version||1)});}
  for(const r of wishlist.results)await recordSyncProjection(db,{userId,entityType:"wishlist",entityId:String(r.product_id),payload:{productId:String(r.product_id),saved:true,alerts:{priceDrop:!!r.alert_price_drop,sale:!!r.alert_sale,release:!!r.alert_release,preorder:!!r.alert_preorder}}});
  for(const r of samples.results)await recordSyncProjection(db,{userId,entityType:"sample",entityId:String(r.product_id),payload:{productId:String(r.product_id),cfi:String(r.cfi),progress:Number(r.sample_progress)},explicitVersion:Number(r.version)});
  for(const r of downloads.results)await recordSyncProjection(db,{userId,entityType:"download_metadata",entityId:`${r.client_id}:${r.product_id}`,payload:{clientId:String(r.client_id),productId:String(r.product_id),state:String(r.state),assetSha256:String(r.asset_sha256||""),bytesDownloaded:Number(r.bytes_downloaded||0),totalBytes:r.total_bytes==null?null:Number(r.total_bytes),offlineLicenseExpiresAt:r.offline_license_expires_at||null},explicitVersion:Number(r.version)});
  for(const r of devices.results)await recordSyncProjection(db,{userId,entityType:"device_state",entityId:String(r.id),payload:{clientId:String(r.id),capabilities:{...parseJson(r.capabilities_json,{}),name:r.name,platform:r.platform,appVersion:r.app_version},lastSeenAt:r.last_seen_at},tombstone:r.status==="revoked"});
  return {schema:"fore-sync-bootstrap",version:1,generatedAt:now(),readingPositions:positions.results,annotations:annotations.results,bookmarks:bookmarks.results,readerSettings:settings.results.map((r:any)=>({...r,value:parseJson(r.value_json,null)})),audioLocations:audio.results,biosyncLocations:[...biosync.results,...commercialBiosync.results],shelves:shelves.results,wishlist:wishlist.results,samples:samples.results,downloads:downloads.results,devices:devices.results};
}
