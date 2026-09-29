import { z } from "zod";
import type { CatalogBook } from "./client";
import { canonicalBooksByProductIds, type CatalogDB } from "./catalog-model.server";
import { ApiError, now } from "./service";
import { setWishlistItem } from "./retail.server";

export type RecommendationEnv = {
  DB: CatalogDB;
  FORE_RECOMMENDER_URL?: string;
  FORE_RECOMMENDER_API_KEY?: string;
  FORE_RECOMMENDER_MODEL?: string;
  FORE_RECOMMENDER_TIMEOUT_MS?: string;
};

type Privacy = {
  personalizationEnabled: boolean;
  activityPersonalizationEnabled: boolean;
  personalizedSearchEnabled: boolean;
};
type ItemMeta = {
  productId: string;
  externalBookId: string;
  editionId: string;
  title: string;
  format: string;
  authorIds: string[];
  authorNames: string[];
  seriesIds: string[];
  seriesNames: string[];
  seriesPositions: Record<string, number>;
  publisherId: string;
  publisherName: string;
  taxonomyPaths: string[];
  languages: string[];
  priceMinor: number;
  currency: string;
  releaseDate: string;
  popularity: number;
  trend: number;
  rating: number;
  reviewCount: number;
};
type Candidate = {
  productId: string;
  score: number;
  sources: Set<string>;
  sourceScores?: Map<string, number>;
  reasonCode: string;
  reasonText: string;
  reasonScore?: number;
  meta?: ItemMeta;
};
type FeatureRow = { feature_type: string; feature_key: string; score: number };
export type RecommendationRail = {
  key: string;
  title: string;
  subtitle?: string;
  requestId: string;
  modelVersion: string;
  personalized: boolean;
  books: CatalogBook[];
  items: Array<{ productId: string; score: number; reasonCode: string; reason: string }>;
};

const DEFAULT_MODEL_KEY = "fore-hybrid";
const DEFAULT_MODEL_VERSION = "1";
const FEATURE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CANDIDATES = 500;
const allowedEvents = new Set([
  "book_view", "sample_start", "read_start", "read_progress", "library_add", "completion", "rating",
  "wishlist_add", "wishlist_remove", "purchase", "recommendation_impression", "recommendation_click", "search_click",
]);
const eventWeights: Record<string, number> = {
  book_view: 0.2, sample_start: 0.8, read_start: 2, read_progress: 0.35, library_add: 3,
  completion: 7, rating: 2.5, wishlist_add: 3, wishlist_remove: -1.5, purchase: 8, recommendation_click: 0.7, search_click: 0.4,
};

function parseArray(value: unknown): string[] {
  try { const x = JSON.parse(String(value ?? "[]")); return Array.isArray(x) ? x.map(String) : []; } catch { return []; }
}
function parseObject<T extends object>(value: unknown, fallback: T): T {
  try { const x = JSON.parse(String(value ?? "{}")); return x && typeof x === "object" && !Array.isArray(x) ? x as T : fallback; } catch { return fallback; }
}
function uniq<T>(values: T[]) { return [...new Set(values)]; }
function hash32(value: string) { let h=2166136261; for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; }
function decay(date: string, halfLifeDays = 60) {
  const age = Math.max(0, Date.now() - Date.parse(date || new Date().toISOString()));
  return Math.pow(0.5, age / (halfLifeDays * 86400000));
}
function featureId(type: string, key: string) { return `${type}:${key}`; }
function rootTaxonomy(paths: string[]) { return paths.map((p)=>p.split("/")[0]).filter(Boolean); }
function priceBucket(minor: number) { return minor <= 0 ? "free" : minor < 500 ? "under-5" : minor < 1500 ? "5-15" : minor < 3000 ? "15-30" : "30-plus"; }

type ModelRuntime = { key:string; version:string; algorithm:string; config:Record<string,unknown> };
async function activeModel(db:CatalogDB):Promise<ModelRuntime>{
  const row=await db.prepare("SELECT model_key,version,algorithm,config_json FROM recommendation_models WHERE status='active' ORDER BY COALESCE(activated_at,created_at) DESC LIMIT 1").first<any>();
  if(!row)return{key:DEFAULT_MODEL_KEY,version:DEFAULT_MODEL_VERSION,algorithm:"multi-candidate-hybrid",config:{}};
  return{key:String(row.model_key),version:String(row.version),algorithm:String(row.algorithm||"multi-candidate-hybrid"),config:parseObject<Record<string,unknown>>(row.config_json,{})};
}
function modelNumber(model:ModelRuntime,key:string,fallback:number,min:number,max:number){const value=Number(model.config[key]);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;}
function modelStringArray(model:ModelRuntime,key:string){const value=model.config[key];return Array.isArray(value)?value.map(String):[];}
function modelRecord(model:ModelRuntime,key:string){const value=model.config[key];return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,number>:{};}

export async function recommendationPrivacy(db: CatalogDB, userId: string | null): Promise<Privacy> {
  if (!userId) return { personalizationEnabled: false, activityPersonalizationEnabled: false, personalizedSearchEnabled: false };
  const row = await db.prepare("SELECT * FROM recommendation_privacy WHERE user_id=?").bind(userId).first<any>();
  return {
    personalizationEnabled: row ? !!row.personalization_enabled : true,
    activityPersonalizationEnabled: row ? !!row.activity_personalization_enabled : true,
    personalizedSearchEnabled: row ? !!row.personalized_search_enabled : true,
  };
}

export async function setRecommendationPrivacy(db: CatalogDB, userId: string, raw: unknown) {
  const input = z.object({ personalizationEnabled:z.boolean(), activityPersonalizationEnabled:z.boolean(), personalizedSearchEnabled:z.boolean() }).parse(raw);
  const at=now();
  await db.prepare(`INSERT INTO recommendation_privacy(user_id,personalization_enabled,activity_personalization_enabled,personalized_search_enabled,consent_version,updated_at)
    VALUES(?,?,?,?, '2026-09',?) ON CONFLICT(user_id) DO UPDATE SET personalization_enabled=excluded.personalization_enabled,activity_personalization_enabled=excluded.activity_personalization_enabled,personalized_search_enabled=excluded.personalized_search_enabled,consent_version=excluded.consent_version,updated_at=excluded.updated_at`)
    .bind(userId,input.personalizationEnabled?1:0,input.activityPersonalizationEnabled?1:0,input.personalizedSearchEnabled?1:0,at).run();
  if (!input.activityPersonalizationEnabled) {
    await db.prepare("DELETE FROM recommendation_user_features WHERE user_id=?").bind(userId).run();
  } else await queueRecommendationJob(db,"user-features",userId);
  return { ...input, updatedAt: at };
}

export async function resetRecommendationProfile(db: CatalogDB, userId: string, raw: unknown) {
  const scope=z.object({ scope:z.enum(["learned","all"]).default("learned") }).parse(raw).scope;
  await db.prepare("DELETE FROM recommendation_events WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM recommendation_user_features WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM recommendation_feedback WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM recommendation_requests WHERE user_id=?").bind(userId).run();
  if(scope==="all"){
    await db.prepare("DELETE FROM author_follows WHERE user_id=?").bind(userId).run();
    await db.prepare("DELETE FROM wishlist_items WHERE user_id=?").bind(userId).run();
  }
  return { reset:true, scope };
}

async function queueRecommendationJob(db: CatalogDB, jobType: string, entityId?: string | null) {
  const entity=entityId||null,existing=await db.prepare("SELECT id FROM recommendation_jobs WHERE job_type=? AND COALESCE(entity_id,'')=COALESCE(?,'') AND status='pending' LIMIT 1").bind(jobType,entity).first<any>();
  if(existing)return String(existing.id);
  const id=crypto.randomUUID(),at=now();
  await db.prepare("INSERT INTO recommendation_jobs(id,job_type,entity_id,status,attempts,max_attempts,last_error,queued_at,available_at) VALUES(?,?,?,'pending',0,5,'',?,?)")
    .bind(id,jobType,entity,at,at).run();
  return id;
}

async function productMeta(db: CatalogDB, productIds: string[]): Promise<Map<string,ItemMeta>> {
  if(!productIds.length) return new Map();
  const ids=uniq(productIds).slice(0,MAX_CANDIDATES), placeholders=ids.map(()=>"?").join(",");
  const rows=await db.prepare(`SELECT p.id product_id,p.source_external_id,p.format,e.id edition_id,e.release_date,
    COALESCE(pub.id,'') publisher_id,COALESCE(pub.name,'') publisher_name,
    COALESCE(d.title,e.title) title,COALESCE(d.price_minor,0) price_minor,COALESCE(d.currency,'USD') currency,
    COALESCE(m.popularity_score,d.download_count,0) popularity_score,COALESCE(m.trend_score,d.sales_velocity,0) trend_score,
    COALESCE(m.average_rating,d.average_rating,0) average_rating,COALESCE(m.rating_count,d.review_count,0) review_count,
    (SELECT json_group_array(ec.contributor_id) FROM edition_contributors ec WHERE ec.edition_id=e.id AND ec.role='author') author_ids,
    (SELECT json_group_array(c.name) FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id AND ec.role='author') author_names,
    (SELECT json_group_array(sm.series_id) FROM series_memberships sm WHERE sm.edition_id=e.id) series_ids,
    (SELECT json_group_array(s.name) FROM series_memberships sm JOIN series s ON s.id=sm.series_id WHERE sm.edition_id=e.id) series_names,
    (SELECT json_group_object(sm.series_id,COALESCE(sm.position,0)) FROM series_memberships sm WHERE sm.edition_id=e.id) series_positions,
    (SELECT json_group_array(n.path) FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE et.edition_id=e.id AND n.visible=1) taxonomy_paths,
    (SELECT json_group_array(el.language_code) FROM edition_languages el WHERE el.edition_id=e.id AND el.kind='content') languages
    FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id LEFT JOIN catalog_search_documents d ON d.product_id=p.id LEFT JOIN recommendation_item_metrics m ON m.product_id=p.id
    WHERE p.id IN (${placeholders})`).bind(...ids).all<any>();
  const map=new Map<string,ItemMeta>();
  for(const r of rows.results){
    map.set(String(r.product_id),{ productId:String(r.product_id),externalBookId:String(r.source_external_id),editionId:String(r.edition_id),title:String(r.title||""),format:String(r.format||"ebook"),
      authorIds:parseArray(r.author_ids),authorNames:parseArray(r.author_names),seriesIds:parseArray(r.series_ids),seriesNames:parseArray(r.series_names),seriesPositions:parseObject<Record<string,number>>(r.series_positions,{}),
      publisherId:String(r.publisher_id||""),publisherName:String(r.publisher_name||""),taxonomyPaths:parseArray(r.taxonomy_paths),languages:parseArray(r.languages),priceMinor:Number(r.price_minor||0),currency:String(r.currency||"USD"),releaseDate:String(r.release_date||""),popularity:Number(r.popularity_score||0),trend:Number(r.trend_score||0),rating:Number(r.average_rating||0),reviewCount:Number(r.review_count||0) });
  }
  return map;
}

async function activeCandidateIds(db: CatalogDB, territory: string, limit=400) {
  const rows=await db.prepare(`SELECT p.id FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN recommendation_item_metrics m ON m.product_id=p.id LEFT JOIN recommendation_regional_item_metrics rm ON rm.product_id=p.id AND rm.territory_code=upper(?) LEFT JOIN catalog_search_documents d ON d.product_id=p.id
    WHERE p.storefront_status='active' AND e.release_status IN ('available','preorder') AND p.source_name<>'upload'
      AND EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
    ORDER BY COALESCE(rm.trend_score,m.trend_score,d.sales_velocity,0) DESC,COALESCE(rm.popularity_score,m.popularity_score,d.download_count,0) DESC,p.updated_at DESC LIMIT ?`).bind(territory,territory,Math.min(MAX_CANDIDATES,limit)).all<any>();
  return rows.results.map((x)=>String(x.id));
}

function addFeature(target: Map<string,{score:number;positive:number;negative:number;last:string}>, type:string,key:string,value:number,date:string) {
  if(!key||!Number.isFinite(value)||Math.abs(value)<0.001)return;
  const id=featureId(type,key), old=target.get(id)||{score:0,positive:0,negative:0,last:date};
  old.score+=value; if(value>0)old.positive++;else old.negative++; if(date>old.last)old.last=date; target.set(id,old);
}
function applyMetaFeatures(target: Map<string,{score:number;positive:number;negative:number;last:string}>, meta:ItemMeta, base:number,date:string) {
  for(const path of meta.taxonomyPaths) addFeature(target,"taxonomy",path,base*(1+Math.min(3,path.split("/").length-1)*0.18),date);
  for(const id of meta.authorIds)addFeature(target,"author",id,base*1.3,date);
  for(const id of meta.seriesIds)addFeature(target,"series",id,base*1.8,date);
  if(meta.publisherId)addFeature(target,"publisher",meta.publisherId,base*0.45,date);
  for(const lang of meta.languages)addFeature(target,"language",lang,base*0.15,date);
  addFeature(target,"format",meta.format,base*0.12,date);
  addFeature(target,"price",priceBucket(meta.priceMinor),base*0.18,date);
}

export async function rebuildUserFeatures(db: CatalogDB,userId:string) {
  const privacy=await recommendationPrivacy(db,userId);
  await db.prepare("DELETE FROM recommendation_user_features WHERE user_id=?").bind(userId).run();
  if(!privacy.activityPersonalizationEnabled)return {userId,features:0,disabled:true};
  const states=await db.prepare(`SELECT rs.product_id,rs.status,rs.progress,rs.updated_at,r.rating_steps,
    EXISTS(SELECT 1 FROM completion_events c WHERE c.user_id=rs.user_id AND c.product_id=rs.product_id) completed
    FROM reading_states rs LEFT JOIN reviews r ON r.user_id=rs.user_id AND r.book_id=rs.external_book_id
    WHERE rs.user_id=? ORDER BY rs.updated_at DESC LIMIT 400`).bind(userId).all<any>();
  const events=await db.prepare("SELECT product_id,event_type,value,occurred_at FROM recommendation_events WHERE user_id=? AND occurred_at>=datetime('now','-365 days') ORDER BY occurred_at DESC LIMIT 1500").bind(userId).all<any>();
  const feedback=await db.prepare("SELECT entity_type,entity_id,updated_at FROM recommendation_feedback WHERE user_id=? AND action IN ('not_interested','hide') ORDER BY updated_at DESC LIMIT 500").bind(userId).all<any>();
  const feedbackProducts=feedback.results.filter((x:any)=>String(x.entity_type)==="product").map((x:any)=>String(x.entity_id));
  const ids=uniq([...states.results.map((x)=>String(x.product_id)),...events.results.map((x)=>String(x.product_id)),...feedbackProducts]);
  const meta=await productMeta(db,ids), features=new Map<string,{score:number;positive:number;negative:number;last:string}>();
  for(const s of states.results){
    const m=meta.get(String(s.product_id));if(!m)continue; let base=0.8;
    if(s.status==="reading")base+=2.2; if(s.status==="finished"||s.completed)base+=5.5; base+=Math.max(0,Math.min(1,Number(s.progress||0)))*1.5;
    if(s.rating_steps!=null)base+=(Number(s.rating_steps)-6)*1.15;
    applyMetaFeatures(features,m,base*decay(String(s.updated_at),120),String(s.updated_at));
  }
  for(const e of events.results){
    const m=meta.get(String(e.product_id));if(!m)continue; let base=eventWeights[String(e.event_type)]||0;
    if(e.event_type==="rating"&&e.value!=null)base+=(Number(e.value)-3)*1.4;
    applyMetaFeatures(features,m,base*decay(String(e.occurred_at),45),String(e.occurred_at));
  }
  // Explicit negative feedback must teach the profile, not merely suppress one SKU.
  for(const f of feedback.results){
    const type=String(f.entity_type),id=String(f.entity_id),date=String(f.updated_at||now());
    if(type==="product"){const m=meta.get(id);if(m)applyMetaFeatures(features,m,-4.5*decay(date,180),date);}
    else if(type==="author")addFeature(features,"author",id,-7*decay(date,240),date);
    else if(type==="series")addFeature(features,"series",id,-8*decay(date,240),date);
  }
  const rows=[...features.entries()].map(([id,v])=>{const [type,...rest]=id.split(":");return{type,key:rest.join(":"),...v};}).filter((x)=>Math.abs(x.score)>=0.05).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,350);
  const at=now(),model=await activeModel(db);
  for(const r of rows)await db.prepare("INSERT INTO recommendation_user_features(user_id,feature_type,feature_key,score,positive_events,negative_events,last_event_at,model_version,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(userId,r.type,r.key,r.score,r.positive,r.negative,r.last,model.version,at).run();
  return {userId,features:rows.length,disabled:false};
}

async function userFeatures(db:CatalogDB,userId:string|null) {
  if(!userId)return [] as FeatureRow[];
  const privacy=await recommendationPrivacy(db,userId);if(!privacy.personalizationEnabled||!privacy.activityPersonalizationEnabled)return [];
  let rows=await db.prepare("SELECT feature_type,feature_key,score,updated_at FROM recommendation_user_features WHERE user_id=? ORDER BY ABS(score) DESC LIMIT 250").bind(userId).all<any>();
  const newest=rows.results[0]?.updated_at;
  if(!rows.results.length||!newest||Date.now()-Date.parse(String(newest))>FEATURE_TTL_MS){await rebuildUserFeatures(db,userId);rows=await db.prepare("SELECT feature_type,feature_key,score FROM recommendation_user_features WHERE user_id=? ORDER BY ABS(score) DESC LIMIT 250").bind(userId).all<any>();}
  return rows.results.map((x)=>({feature_type:String(x.feature_type),feature_key:String(x.feature_key),score:Number(x.score||0)}));
}

function affinityScore(meta:ItemMeta,features:FeatureRow[]) {
  const map=new Map(features.map((x)=>[featureId(x.feature_type,x.feature_key),x.score])); let score=0;
  for(const p of meta.taxonomyPaths)score+=(map.get(featureId("taxonomy",p))||0)*0.9;
  for(const a of meta.authorIds)score+=(map.get(featureId("author",a))||0)*1.15;
  for(const s of meta.seriesIds)score+=(map.get(featureId("series",s))||0)*1.25;
  if(meta.publisherId)score+=(map.get(featureId("publisher",meta.publisherId))||0)*0.4;
  for(const l of meta.languages)score+=(map.get(featureId("language",l))||0)*0.1;
  score+=(map.get(featureId("format",meta.format))||0)*0.08;
  score+=(map.get(featureId("price",priceBucket(meta.priceMinor)))||0)*0.12;
  return score;
}
function contentSimilarity(a:ItemMeta,b:ItemMeta) {
  let score=0; const sharedSeries=b.seriesIds.filter((x)=>a.seriesIds.includes(x)); if(sharedSeries.length)score+=18*sharedSeries.length;
  const sharedAuthors=b.authorIds.filter((x)=>a.authorIds.includes(x)); if(sharedAuthors.length)score+=8*sharedAuthors.length;
  const sharedTax=b.taxonomyPaths.filter((x)=>a.taxonomyPaths.includes(x)); score+=sharedTax.reduce((s,p)=>s+2.5+p.split("/").length*0.8,0);
  if(a.publisherId&&a.publisherId===b.publisherId)score+=1.2;
  if(a.languages.some((x)=>b.languages.includes(x)))score+=0.4;
  return score;
}

async function ownedSet(db:CatalogDB,userId:string|null): Promise<Set<string>> {if(!userId)return new Set<string>();const r=await db.prepare("SELECT product_id FROM reading_states WHERE user_id=? AND in_library=1").bind(userId).all<any>();return new Set<string>(r.results.map((x:any)=>String(x.product_id)));}
async function hiddenSet(db:CatalogDB,userId:string|null){if(!userId)return{products:new Set<string>(),authors:new Set<string>(),series:new Set<string>()};const r=await db.prepare("SELECT entity_type,entity_id FROM recommendation_feedback WHERE user_id=? AND action IN ('not_interested','hide')").bind(userId).all<any>();return{products:new Set(r.results.filter((x)=>x.entity_type==='product').map((x)=>String(x.entity_id))),authors:new Set(r.results.filter((x)=>x.entity_type==='author').map((x)=>String(x.entity_id))),series:new Set(r.results.filter((x)=>x.entity_type==='series').map((x)=>String(x.entity_id)))};}

async function collaborativeScores(db:CatalogDB,userId:string|null,seedIds:string[],limit=120){
  if(!seedIds.length)return new Map<string,number>();
  const seeds=seedIds.slice(0,20), ph=seeds.map(()=>"?").join(",");
  const exclude=userId?" AND a.user_id<>?":"";
  const bindings=userId?[...seeds,userId,limit]:[...seeds,limit];
  const rows=await db.prepare(`SELECT b.product_id,COUNT(DISTINCT b.user_id) score FROM reading_states a JOIN reading_states b ON b.user_id=a.user_id AND b.product_id<>a.product_id
    LEFT JOIN recommendation_privacy rp ON rp.user_id=a.user_id
    JOIN products p ON p.id=b.product_id
    WHERE a.product_id IN (${ph}) AND a.in_library=1 AND b.in_library=1 AND p.storefront_status='active' AND COALESCE(rp.activity_personalization_enabled,1)=1${exclude}
    GROUP BY b.product_id HAVING score>=1 ORDER BY score DESC LIMIT ?`).bind(...bindings).all<any>();
  return new Map<string,number>(rows.results.map((x)=>[String(x.product_id),Number(x.score||0)]));
}

async function seedProducts(db:CatalogDB,userId:string|null){
  if(!userId)return [] as string[];const r=await db.prepare(`SELECT product_id FROM reading_states WHERE user_id=? AND (status IN ('reading','finished') OR progress>0.1) ORDER BY CASE status WHEN 'reading' THEN 0 ELSE 1 END,updated_at DESC LIMIT 20`).bind(userId).all<any>();return r.results.map((x)=>String(x.product_id));
}

function mergeCandidate(map:Map<string,Candidate>,id:string,score:number,source:string,reasonCode:string,reasonText:string){
  if(!id||!Number.isFinite(score))return;
  const old=map.get(id)||{productId:id,score:0,sources:new Set<string>(),sourceScores:new Map<string,number>(),reasonCode,reasonText,reasonScore:-Infinity};
  old.score+=score;old.sources.add(source);const sourceScores=old.sourceScores||(old.sourceScores=new Map<string,number>());sourceScores.set(source,(sourceScores.get(source)||0)+score);
  if(score>(old.reasonScore??-Infinity)){old.reasonCode=reasonCode;old.reasonText=reasonText;old.reasonScore=score;}
  map.set(id,old);
}

async function externalCandidates(env:RecommendationEnv,model:ModelRuntime,opts:{surface:string;features:FeatureRow[];seedIds:string[];anchorProductId?:string|null;territory:string}){
  if(!env.FORE_RECOMMENDER_URL||!env.FORE_RECOMMENDER_API_KEY)return {scores:new Map<string,number>(),status:"disabled" as const,reason:""};
  const timeout=Math.max(150,Math.min(2500,Number(env.FORE_RECOMMENDER_TIMEOUT_MS||700)));
  try{
    const response=await fetch(String(env.FORE_RECOMMENDER_URL).replace(/\/+$/,'')+"/candidates",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${env.FORE_RECOMMENDER_API_KEY}`},body:JSON.stringify({model:env.FORE_RECOMMENDER_MODEL||model.key,modelVersion:model.version,surface:opts.surface,territory:opts.territory,anchorProductId:opts.anchorProductId||null,seedProductIds:opts.seedIds.slice(0,30),userFeatures:opts.features.slice(0,160),limit:200}),signal:AbortSignal.timeout(timeout)});
    if(response.status===404)return {scores:new Map<string,number>(),status:"unsupported" as const,reason:"candidate endpoint unavailable"};
    if(!response.ok)return {scores:new Map<string,number>(),status:"failed" as const,reason:`candidate service ${response.status}`};
    const payload=await response.json() as any;if(!Array.isArray(payload?.candidates))return {scores:new Map<string,number>(),status:"failed" as const,reason:"invalid candidate payload"};
    const scores=new Map<string,number>();for(const row of payload.candidates.slice(0,300)){const id=String(row?.id||"");const score=Number(row?.score);if(id&&Number.isFinite(score))scores.set(id,score);}
    return {scores,status:"external" as const,reason:""};
  }catch(error){return {scores:new Map<string,number>(),status:"failed" as const,reason:error instanceof Error?error.message.slice(0,160):"candidate service failed"};}
}

function normalizedExternalScores(values:Map<string,number>){
  const entries=[...values].filter(([,score])=>Number.isFinite(score)).sort((a,b)=>b[1]-a[1]);
  const out=new Map<string,number>();const n=Math.max(1,entries.length-1);
  entries.forEach(([id],index)=>out.set(id,20*(1-index/n)));
  return out;
}

async function externalRank(env:RecommendationEnv,model:ModelRuntime,surface:string,features:FeatureRow[],candidates:Candidate[],metas:Map<string,ItemMeta>){
  if(!env.FORE_RECOMMENDER_URL||!env.FORE_RECOMMENDER_API_KEY)return {scores:null as Map<string,number>|null,status:"disabled",reason:""};
  const timeout=Math.max(150,Math.min(2500,Number(env.FORE_RECOMMENDER_TIMEOUT_MS||700)));
  try{
    const response=await fetch(String(env.FORE_RECOMMENDER_URL).replace(/\/+$/,'')+"/rank",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${env.FORE_RECOMMENDER_API_KEY}`},body:JSON.stringify({model:env.FORE_RECOMMENDER_MODEL||model.key,modelVersion:model.version,surface,userFeatures:features.slice(0,160),candidates:candidates.slice(0,350).map((c)=>({id:c.productId,baseScore:c.score,features:metas.get(c.productId)}))}),signal:AbortSignal.timeout(timeout)});
    if(!response.ok)return {scores:null,status:"failed",reason:`rank service ${response.status}`};
    const payload=await response.json() as any;if(!Array.isArray(payload?.scores))return {scores:null,status:"failed",reason:"invalid rank payload"};
    const raw=new Map<string,number>(payload.scores.map((x:any)=>[String(x.id),Number(x.score)] as [string,number]).filter(([,score])=>Number.isFinite(score)));
    return {scores:normalizedExternalScores(raw),status:"external",reason:""};
  }catch(error){return {scores:null,status:"failed",reason:error instanceof Error?error.message.slice(0,160):"rank service failed"};}
}

type RankingControls={explorationRate?:number;diversityStrength?:number;sourceWeights?:Record<string,number>};
function diversitySelect(candidates:Candidate[],limit:number,seed:string,controls:RankingControls={}){
  const chosen:Candidate[]=[],authorCount=new Map<string,number>(),seriesCount=new Map<string,number>(),rootCount=new Map<string,number>();
  const remaining=[...candidates],diversity=Math.max(0,Math.min(3,Number(controls.diversityStrength??1))),exploration=Math.max(0,Math.min(0.5,Number(controls.explorationRate??0.08)));
  while(chosen.length<limit&&remaining.length){
    let bestIndex=0,best=-Infinity;
    const explore = chosen.length === Math.min(3, Math.max(0, limit - 1)) && remaining.length > 8 && (hash32(`${seed}:explore`) % 10000) < exploration*10000;
    if (explore) bestIndex = 5 + (hash32(`${seed}:explore-item`) % Math.min(20, remaining.length - 5));
    if (!explore) for(let i=0;i<remaining.length;i++){const c=remaining[i],m=c.meta;if(!m)continue;let penalty=0;for(const a of m.authorIds)penalty+=(authorCount.get(a)||0)*1.9;for(const s of m.seriesIds)penalty+=(seriesCount.get(s)||0)*2.4;for(const r of rootTaxonomy(m.taxonomyPaths))penalty+=(rootCount.get(r)||0)*0.45;const jitter=(hash32(`${seed}:${c.productId}`)%1000)/100000;const value=c.score-penalty*diversity+jitter;if(value>best){best=value;bestIndex=i;}}
    const [pick]=remaining.splice(bestIndex,1);if(!pick?.meta)continue;chosen.push(pick);for(const a of pick.meta.authorIds)authorCount.set(a,(authorCount.get(a)||0)+1);for(const s of pick.meta.seriesIds)seriesCount.set(s,(seriesCount.get(s)||0)+1);for(const r of rootTaxonomy(pick.meta.taxonomyPaths))rootCount.set(r,(rootCount.get(r)||0)+1);
  }return chosen;
}
function applyRankingControls(candidates:Candidate[],controls:RankingControls={}){
  const weights=controls.sourceWeights||{};
  return candidates.map((candidate)=>{
    const sourceScores=candidate.sourceScores||new Map<string,number>();
    const hasConfigured=[...candidate.sources].some((source)=>Number.isFinite(Number(weights[source])));
    let score=candidate.score;
    if(hasConfigured&&sourceScores.size){score=0;for(const [source,value] of sourceScores){const weight=Number.isFinite(Number(weights[source]))?Math.max(0,Math.min(5,Number(weights[source]))):1;score+=value*weight;}}
    return{...candidate,sources:new Set(candidate.sources),sourceScores:new Map(sourceScores),score};
  }).sort((a,b)=>b.score-a.score);
}

async function candidatePool(env:RecommendationEnv,opts:{userId:string|null;territory:string;anchorProductId?:string|null;mode:string;includeOwned?:boolean;model?:ModelRuntime}){
  const started=Date.now(),db=env.DB,model=opts.model||await activeModel(db),privacy=await recommendationPrivacy(db,opts.userId),personalizationUserId=opts.userId&&privacy.personalizationEnabled?opts.userId:null;
  const generators=modelStringArray(model,"candidateGenerators"),enabled=(name:string)=>!generators.length||generators.includes(name);
  const anchorId=opts.anchorProductId||null,seeds=await seedProducts(db,personalizationUserId),features=await userFeatures(db,personalizationUserId);
  const ids=await activeCandidateIds(db,opts.territory,Math.min(MAX_CANDIDATES,Math.max(100,Number(model.config.maxCandidates||450))));if(anchorId&&!ids.includes(anchorId))ids.push(anchorId);
  const collab=enabled("collaborative")?await collaborativeScores(db,personalizationUserId,anchorId?[anchorId]:seeds):new Map<string,number>();
  for(const id of collab.keys())if(!ids.includes(id))ids.push(id);
  const neighborScores=new Map<string,number>(),coReadNeighborScores=new Map<string,number>();
  if(anchorId&&enabled("content")){const n=await db.prepare("SELECT neighbor_product_id,strategy,score FROM recommendation_item_neighbors WHERE product_id=? AND strategy IN ('content','co-read') ORDER BY score DESC LIMIT 220").bind(anchorId).all<any>();for(const row of n.results){const id=String(row.neighbor_product_id),score=Number(row.score||0);if(String(row.strategy)==="co-read")coReadNeighborScores.set(id,score);else neighborScores.set(id,score);if(!ids.includes(id))ids.push(id);}}
  const externalCandidate=await externalCandidates(env,model,{surface:opts.mode,features,seedIds:anchorId?[anchorId,...seeds]:seeds,anchorProductId:anchorId,territory:opts.territory});
  for(const id of externalCandidate.scores.keys())if(!ids.includes(id)&&ids.length<MAX_CANDIDATES)ids.push(id);
  const metas=await productMeta(db,ids),anchor=anchorId?metas.get(anchorId):undefined,owned=await ownedSet(db,personalizationUserId),hidden=await hiddenSet(db,opts.userId),map=new Map<string,Candidate>();
  for(const [id,m] of metas){
    if(id===anchorId||hidden.products.has(id)||m.authorIds.some((x)=>hidden.authors.has(x))||m.seriesIds.some((x)=>hidden.series.has(x)))continue;
    if(!opts.includeOwned&&owned.has(id))continue;
    const affinity=features.length?affinityScore(m,features):0;
    const recency=m.releaseDate?decay(m.releaseDate,180):0;
    const quality=Math.log1p(Math.max(0,m.popularity))*0.09+Math.log1p(Math.max(0,m.trend))*0.35+(m.rating>=4?Math.min(2,m.rating-3.5)*0.6:0)+recency*0.65;
    if(enabled("trending")||enabled("quality"))mergeCandidate(map,id,quality,"quality","popular","Popular with Cove readers");
    if(enabled("affinity")&&affinity>0.05)mergeCandidate(map,id,affinity,"affinity","taste","Matches your reading tastes");
    if(anchor&&enabled("content")){const sim=contentSimilarity(anchor,m);if(sim>0)mergeCandidate(map,id,sim,"content","similar",`Similar to ${anchor.title}`);}
    const precomputed=neighborScores.get(id)||0;if(precomputed>0)mergeCandidate(map,id,precomputed*0.9,"item-neighbor","similar",`Similar to ${anchor?.title||"this book"}`);
    const coRead=coReadNeighborScores.get(id)||0;if(coRead>0)mergeCandidate(map,id,coRead,"collaborative-item","also-enjoyed","Readers of this book also enjoyed this");
    const co=collab.get(id)||0;if(co>0)mergeCandidate(map,id,Math.log1p(co)*5,"collaborative","also-enjoyed","Readers with similar libraries also enjoyed this");
  }
  const extCandidates=normalizedExternalScores(externalCandidate.scores);for(const [id,score] of extCandidates){if(metas.has(id))mergeCandidate(map,id,score*0.7,"external-candidate","modeled-match","Recommended by Cove's retrieval model");}
  const localCandidates=[...map.values()];
  const external=await externalRank(env,model,opts.mode,features,localCandidates,metas);
  if(external.scores)for(const [id,score] of external.scores){const c=map.get(id);if(c){c.score=c.score*0.45+score*0.55;c.sources.add("external-ranker");(c.sourceScores||(c.sourceScores=new Map<string,number>())).set("external-ranker",score*0.55);}}
  for(const c of map.values())c.meta=metas.get(c.productId);
  const scorerMode=external.status==="external"?"external-rank":externalCandidate.status==="external"?"external-candidates":"local";
  const fallbackReason=[externalCandidate.status==="failed"?externalCandidate.reason:"",external.status==="failed"?external.reason:""].filter(Boolean).join("; ");
  const candidateCounts:Record<string,number>={};for(const c of map.values())for(const source of c.sources)candidateCounts[source]=(candidateCounts[source]||0)+1;
  return {candidates:[...map.values()].sort((a,b)=>b.score-a.score),metas,features,personalized:features.length>0,model,telemetry:{candidateCount:map.size,candidateCounts,scorerMode,fallbackReason,latencyMs:Date.now()-started}};
}

async function activeRecommendationExperiment(db:CatalogDB,surface:string,identity:string){
  const row=await db.prepare(`SELECT * FROM recommendation_experiments WHERE surface=? AND status='published' AND (starts_at IS NULL OR starts_at<=datetime('now')) AND (ends_at IS NULL OR ends_at>datetime('now')) ORDER BY updated_at DESC LIMIT 1`).bind(surface).first<any>();
  if(!row)return null;let parsed:any[];try{parsed=JSON.parse(String(row.variants_json||"[]"))}catch{parsed=[]}
  const valid=parsed.filter((x)=>x&&x.key&&Number(x.weight)>0),total=valid.reduce((n,x)=>n+Number(x.weight),0);if(!total)return null;
  let bucket=hash32(`${identity}:${row.experiment_key}`)%total,chosen=valid[0];for(const v of valid){if(bucket<Number(v.weight)){chosen=v;break;}bucket-=Number(v.weight);}
  const config=chosen?.config&&typeof chosen.config==="object"&&!Array.isArray(chosen.config)?chosen.config:{};
  return{id:String(row.id),key:String(row.experiment_key),variant:String(chosen.key),config:{explorationRate:Number.isFinite(Number(config.explorationRate))?Number(config.explorationRate):undefined,diversityStrength:Number.isFinite(Number(config.diversityStrength))?Number(config.diversityStrength):undefined,sourceWeights:config.sourceWeights&&typeof config.sourceWeights==="object"&&!Array.isArray(config.sourceWeights)?config.sourceWeights:undefined} as RankingControls};
}

async function requestRecord(db:CatalogDB,opts:{userId:string|null;visitorId:string;surface:string;anchorProductId?:string|null;territory:string;personalized:boolean;context?:Record<string,unknown>;experiment?:Awaited<ReturnType<typeof activeRecommendationExperiment>>;model:ModelRuntime;telemetry?:{candidateCount:number;candidateCounts?:Record<string,number>;latencyMs:number;scorerMode:string;fallbackReason:string}},candidates:Candidate[]) {
  const id=crypto.randomUUID(),at=now(),privacy=opts.userId?await recommendationPrivacy(db,opts.userId):null;
  const consentMode=!opts.userId?"anonymous":privacy?.personalizationEnabled?"personalized":"contextual";
  const experiment=opts.experiment===undefined?await activeRecommendationExperiment(db,opts.surface,opts.userId||opts.visitorId||id):opts.experiment;
  const telemetry=opts.telemetry||{candidateCount:candidates.length,latencyMs:0,scorerMode:"local",fallbackReason:""};
  await db.prepare("INSERT INTO recommendation_requests(id,user_id,visitor_id,surface,anchor_product_id,model_key,model_version,experiment_id,experiment_variant,algorithm,consent_mode,territory_code,context_json,candidate_count,latency_ms,scorer_mode,fallback_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,opts.userId,opts.visitorId||null,opts.surface,opts.anchorProductId||null,opts.model.key,opts.model.version,experiment?.id||null,experiment?.variant||null,opts.model.algorithm,consentMode,opts.territory,JSON.stringify({...opts.context,experimentKey:experiment?.key||null,candidateSources:telemetry.candidateCounts||{}}),telemetry.candidateCount,telemetry.latencyMs,telemetry.scorerMode,telemetry.fallbackReason,at).run();
  for(let i=0;i<candidates.length;i++){const c=candidates[i];await db.prepare("INSERT INTO recommendation_impressions(request_id,product_id,position,score,reason_code,reason_text,candidate_sources_json) VALUES(?,?,?,?,?,?,?)")
    .bind(id,c.productId,i+1,c.score,c.reasonCode,c.reasonText,JSON.stringify([...c.sources])).run();}
  return id;
}

async function eligibleRecommendationIds(db:CatalogDB, ids:string[], territory:string, userId:string|null){
  if(!ids.length)return new Set<string>();const unique=uniq(ids).slice(0,MAX_CANDIDATES),ph=unique.map(()=>"?").join(",");const rows=await db.prepare(`SELECT p.id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id IN (${ph}) AND p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder') AND EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))` ).bind(...unique,territory).all<any>();const allowed=new Set<string>(rows.results.map((x)=>String(x.id))),hidden=await hiddenSet(db,userId),metas=await productMeta(db,[...allowed]);for(const id of [...allowed]){const meta=metas.get(id);if(hidden.products.has(id)||meta?.authorIds.some((x)=>hidden.authors.has(x))||meta?.seriesIds.some((x)=>hidden.series.has(x)))allowed.delete(id);}return allowed;
}

async function makeRail(env:RecommendationEnv,opts:{key:string;title:string;subtitle?:string;surface:string;userId:string|null;visitorId:string;territory:string;anchorProductId?:string|null;candidates:Candidate[];limit:number;personalized:boolean;model?:ModelRuntime;telemetry?:{candidateCount:number;candidateCounts?:Record<string,number>;latencyMs:number;scorerMode:string;fallbackReason:string};excludeProductIds?:Set<string>;excludeOwned?:boolean}) : Promise<RecommendationRail|null> {
  const model=opts.model||await activeModel(env.DB),filtered=opts.excludeProductIds?.size?opts.candidates.filter((x)=>!opts.excludeProductIds!.has(x.productId)):opts.candidates;
  const allowed=await eligibleRecommendationIds(env.DB,filtered.map((x)=>x.productId),opts.territory,opts.userId);
  if(opts.excludeOwned&&opts.userId){const owned=await ownedSet(env.DB,opts.userId);for(const id of owned)allowed.delete(id);}
  const hydrated=await augmentMeta(env.DB,filtered.filter((x)=>allowed.has(x.productId)));
  const experiment=await activeRecommendationExperiment(env.DB,opts.surface,opts.userId||opts.visitorId||crypto.randomUUID());
  const modelControls:RankingControls={explorationRate:modelNumber(model,"explorationRate",0.08,0,0.5),diversityStrength:modelNumber(model,"diversityStrength",1,0,3),sourceWeights:modelRecord(model,"sourceWeights")};
  const controls={...modelControls,...(experiment?.config||{}),sourceWeights:{...(modelControls.sourceWeights||{}),...(experiment?.config?.sourceWeights||{})}};
  const ranked=applyRankingControls(hydrated,controls);
  const selected=diversitySelect(ranked,opts.limit,`${opts.visitorId}:${opts.surface}:${opts.key}`,controls);if(!selected.length)return null;
  const requestId=await requestRecord(env.DB,{userId:opts.userId,visitorId:opts.visitorId,surface:opts.surface,anchorProductId:opts.anchorProductId,territory:opts.territory,personalized:opts.personalized,context:{rail:opts.key},experiment,model,telemetry:opts.telemetry},selected);
  const books=await canonicalBooksByProductIds(env.DB,selected.map((x)=>x.productId)); const byId=new Map(books.map((b)=>[String(b.productId),b]));
  const ordered=selected.map((c)=>byId.get(c.productId)).filter(Boolean) as CatalogBook[];
  return {key:opts.key,title:opts.title,subtitle:opts.subtitle,requestId,modelVersion:model.version,personalized:opts.personalized,books:ordered,items:selected.map((c)=>({productId:c.productId,score:Number(c.score.toFixed(4)),reasonCode:c.reasonCode,reason:c.reasonText}))};
}

async function recentAnchor(db:CatalogDB,userId:string|null){if(!userId)return null;const r=await db.prepare("SELECT product_id FROM reading_states WHERE user_id=? AND (progress>0.05 OR status IN ('reading','finished')) ORDER BY updated_at DESC LIMIT 1").bind(userId).first<any>();return r?String(r.product_id):null;}
async function ratedAnchor(db:CatalogDB,userId:string|null){if(!userId)return null;const r=await db.prepare(`SELECT rs.product_id FROM reviews v JOIN reading_states rs ON rs.user_id=v.user_id AND rs.external_book_id=v.book_id WHERE v.user_id=? AND v.rating_steps>=8 ORDER BY v.updated_at DESC LIMIT 1`).bind(userId).first<any>();return r?String(r.product_id):null;}

async function continueSeriesCandidates(db:CatalogDB,userId:string|null,anchorProductId?:string|null){
  const seed=anchorProductId||(await recentAnchor(db,userId));if(!seed)return [] as Candidate[];
  const row=await db.prepare("SELECT e.id edition_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(seed).first<any>();if(!row)return[];
  const seriesRows=await db.prepare("SELECT series_id,position FROM series_memberships WHERE edition_id=? ORDER BY position").bind(row.edition_id).all<any>();const out:Candidate[]=[];
  for(const sr of seriesRows.results){const rows=await db.prepare(`SELECT p.id,s.name,sm.position FROM series_memberships sm JOIN series s ON s.id=sm.series_id JOIN products p ON p.edition_id=sm.edition_id
      WHERE sm.series_id=? AND p.storefront_status='active' AND p.id<>? AND COALESCE(sm.position,9999)>COALESCE(?,0) ORDER BY sm.position LIMIT 5`).bind(sr.series_id,seed,sr.position).all<any>();
    for(const x of rows.results)out.push({productId:String(x.id),score:30-Math.max(0,Number(x.position||0)-Number(sr.position||0)),sources:new Set(["series"]),reasonCode:"continue-series",reasonText:`Continue ${String(x.name)}`});
  }return out;
}

async function followedAuthorCandidates(db:CatalogDB,userId:string|null){if(!userId)return[] as Candidate[];const rows=await db.prepare(`SELECT DISTINCT p.id,c.name FROM author_follows f JOIN contributors c ON c.id=f.contributor_id JOIN edition_contributors ec ON ec.contributor_id=f.contributor_id AND ec.role='author' JOIN products p ON p.edition_id=ec.edition_id JOIN editions e ON e.id=p.edition_id WHERE f.user_id=? AND p.storefront_status='active' ORDER BY COALESCE(e.release_date,e.publication_date,p.created_at) DESC LIMIT 80`).bind(userId).all<any>();return rows.results.map((x:any,i)=>({productId:String(x.id),score:25-i*0.05,sources:new Set(["followed-author"]),reasonCode:"followed-author",reasonText:`New from ${String(x.name)}`}));}
async function wishlistDropCandidates(db:CatalogDB,userId:string|null){if(!userId)return[] as Candidate[];const rows=await db.prepare(`SELECT w.product_id,w.baseline_price_minor,COALESCE((SELECT MIN(o.amount_minor) FROM offers o WHERE o.product_id=w.product_id AND o.active=1 AND (o.starts_at IS NULL OR o.starts_at<=datetime('now')) AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))),d.price_minor,0) current_price,d.title FROM wishlist_items w LEFT JOIN catalog_search_documents d ON d.product_id=w.product_id WHERE w.user_id=? AND w.baseline_price_minor IS NOT NULL AND COALESCE((SELECT MIN(o.amount_minor) FROM offers o WHERE o.product_id=w.product_id AND o.active=1 AND (o.starts_at IS NULL OR o.starts_at<=datetime('now')) AND (o.ends_at IS NULL OR o.ends_at>datetime('now'))),d.price_minor,0)<w.baseline_price_minor ORDER BY (w.baseline_price_minor-current_price) DESC LIMIT 50`).bind(userId).all<any>();return rows.results.map((x:any)=>({productId:String(x.product_id),score:20+(Number(x.baseline_price_minor)-Number(x.current_price))/100,sources:new Set(["wishlist-price-drop"]),reasonCode:"price-drop",reasonText:"Price dropped since you wishlisted it"}));}
async function rereadCandidates(db:CatalogDB,userId:string|null){if(!userId)return[] as Candidate[];const rows=await db.prepare(`SELECT c.product_id,MAX(c.finished_at) finished_at,d.title FROM completion_events c LEFT JOIN catalog_search_documents d ON d.product_id=c.product_id WHERE c.user_id=? AND c.finished_at<datetime('now','-120 days') GROUP BY c.product_id ORDER BY finished_at ASC LIMIT 30`).bind(userId).all<any>();return rows.results.map((x:any,i)=>({productId:String(x.product_id),score:12-i*0.1,sources:new Set(["reread"]),reasonCode:"reread",reasonText:"A book you finished a while ago"}));}
async function editorialCandidates(db:CatalogDB,limit=24){const rows=await db.prepare(`SELECT i.product_id,c.title FROM merch_collections c JOIN merch_collection_items i ON i.collection_id=c.id WHERE c.status='published' AND c.mode='manual' AND (c.starts_at IS NULL OR c.starts_at<=datetime('now')) AND (c.ends_at IS NULL OR c.ends_at>datetime('now')) AND (i.starts_at IS NULL OR i.starts_at<=datetime('now')) AND (i.ends_at IS NULL OR i.ends_at>datetime('now')) ORDER BY c.updated_at DESC,i.sort_order LIMIT ?`).bind(limit).all<any>();return rows.results.map((x:any,i)=>({productId:String(x.product_id),score:10-i*0.1,sources:new Set(["editorial"]),reasonCode:"editorial",reasonText:`Selected by Cove editors${x.title?` · ${String(x.title)}`:""}`}));}

async function augmentMeta(db:CatalogDB,candidates:Candidate[]){
  const metas=await productMeta(db,candidates.map((x)=>x.productId));
  return candidates.filter((x)=>metas.has(x.productId)).map((x)=>({
    ...x,
    sources:x.sources||new Set<string>(),
    sourceScores:x.sourceScores||new Map<string,number>([...((x.sources||new Set<string>()) as Set<string>)].map((source)=>[source,x.score])),
    reasonScore:Number.isFinite(Number(x.reasonScore))?Number(x.reasonScore):x.score,
    meta:metas.get(x.productId),
  }));
}

export async function homeRecommendations(env:RecommendationEnv,opts:{userId:string|null;visitorId:string;territory:string;limit?:number}){
  const limit=Math.max(4,Math.min(20,opts.limit||12)),privacy=await recommendationPrivacy(env.DB,opts.userId),personalized=!!opts.userId&&privacy.personalizationEnabled,model=await activeModel(env.DB);
  const base=await candidatePool(env,{userId:personalized?opts.userId:null,territory:opts.territory,mode:"home",model}),rails:RecommendationRail[]=[],used=new Set<string>();
  const add=async(promise:Promise<RecommendationRail|null>)=>{const rail=await promise;if(!rail)return;rails.push(rail);for(const book of rail.books)if(book.productId)used.add(String(book.productId));};
  await add(makeRail(env,{key:"recommended-for-you",title:personalized?"Recommended for you":"Popular on Cove",subtitle:personalized?"Blended from your reading, ratings, series, authors and reader cohorts":"Strong picks from current reader activity",surface:"home:recommended",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:base.candidates,limit,personalized,model,telemetry:base.telemetry,excludeProductIds:used}));
  const anchor=personalized?await recentAnchor(env.DB,opts.userId):null;
  if(anchor){const related=await candidatePool(env,{userId:opts.userId,territory:opts.territory,anchorProductId:anchor,mode:"because-read",model});const aMeta=(await productMeta(env.DB,[anchor])).get(anchor);await add(makeRail(env,{key:"because-you-read",title:aMeta?`Because you read ${aMeta.title}`:"Because of your recent reading",surface:"home:because-read",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:anchor,candidates:related.candidates.filter((x)=>x.sources.has("content")||x.sources.has("collaborative")||x.sources.has("external-candidate")),limit,personalized:true,model,telemetry:related.telemetry,excludeProductIds:used}));}
  const ratingAnchor=personalized?await ratedAnchor(env.DB,opts.userId):null;
  if(ratingAnchor&&ratingAnchor!==anchor){const related=await candidatePool(env,{userId:opts.userId,territory:opts.territory,anchorProductId:ratingAnchor,mode:"because-rated",model});const aMeta=(await productMeta(env.DB,[ratingAnchor])).get(ratingAnchor);await add(makeRail(env,{key:"because-you-rated",title:aMeta?`Because you rated ${aMeta.title} highly`:"Because of a book you rated highly",surface:"home:because-rated",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:ratingAnchor,candidates:related.candidates.filter((x)=>x.sources.has("content")||x.sources.has("collaborative")||x.sources.has("external-candidate")),limit,personalized:true,model,telemetry:related.telemetry,excludeProductIds:used}));}
  if(personalized){
    const series=await augmentMeta(env.DB,await continueSeriesCandidates(env.DB,opts.userId));await add(makeRail(env,{key:"continue-series",title:"Continue a series",surface:"home:series",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:series,limit:Math.min(8,limit),personalized:true,model,excludeProductIds:used,excludeOwned:true}));
    const followed=await augmentMeta(env.DB,await followedAuthorCandidates(env.DB,opts.userId));await add(makeRail(env,{key:"followed-authors",title:"New from authors you follow",surface:"home:followed",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:followed,limit,personalized:true,model,excludeProductIds:used,excludeOwned:true}));
    const drops=await augmentMeta(env.DB,await wishlistDropCandidates(env.DB,opts.userId));await add(makeRail(env,{key:"wishlist-price-drops",title:"Price drops from your wishlist",surface:"home:wishlist-drops",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:drops,limit,personalized:true,model,excludeProductIds:used}));
    const reread=await augmentMeta(env.DB,await rereadCandidates(env.DB,opts.userId));await add(makeRail(env,{key:"reread",title:"Worth reading again",surface:"home:reread",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:reread,limit:Math.min(8,limit),personalized:true,model,excludeProductIds:used}));
    const favorite=base.candidates.filter((x)=>x.sources.has("affinity"));await add(makeRail(env,{key:"favorite-genres",title:"Popular in your favorite genres",surface:"home:favorites",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:favorite,limit,personalized:true,model,telemetry:base.telemetry,excludeProductIds:used}));
  }
  const trending=base.candidates.filter((x)=>x.meta?.trend&&x.meta.trend>0).sort((a,b)=>(b.meta?.trend||0)-(a.meta?.trend||0));await add(makeRail(env,{key:"trending",title:"Trending now",surface:"home:trending",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:trending.length?trending:base.candidates,limit,personalized:false,model,telemetry:base.telemetry,excludeProductIds:used}));
  const editorial=await augmentMeta(env.DB,await editorialCandidates(env.DB));await add(makeRail(env,{key:"editors-picks",title:"Cove editors recommend",surface:"home:editorial",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,candidates:editorial,limit,personalized:false,model,excludeProductIds:used,excludeOwned:true}));
  return {rails,personalization:{enabled:personalized,activityLearning:privacy.activityPersonalizationEnabled,personalizedSearch:privacy.personalizedSearchEnabled},model:{key:model.key,version:model.version,algorithm:model.algorithm,externalScorer:!!env.FORE_RECOMMENDER_URL}};
}

export async function bookRecommendations(env:RecommendationEnv,opts:{userId:string|null;visitorId:string;territory:string;anchorProductId:string;limit?:number}){
  const limit=Math.max(4,Math.min(20,opts.limit||10)),model=await activeModel(env.DB),base=await candidatePool(env,{userId:opts.userId,territory:opts.territory,anchorProductId:opts.anchorProductId,mode:"book-related",model}),anchor=base.metas.get(opts.anchorProductId);if(!anchor)throw new ApiError(404,"This product is not available for recommendations.");const rails:RecommendationRail[]=[],used=new Set<string>();
  const add=async(promise:Promise<RecommendationRail|null>)=>{const rail=await promise;if(!rail)return;rails.push(rail);for(const book of rail.books)if(book.productId)used.add(String(book.productId));};
  await add(makeRail(env,{key:"more-like-this",title:"More like this",surface:"book:similar",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:opts.anchorProductId,candidates:base.candidates.filter((x)=>x.sources.has("content")||x.sources.has("item-neighbor")||x.sources.has("external-candidate")),limit,personalized:base.personalized,model,telemetry:base.telemetry,excludeProductIds:used}));
  await add(makeRail(env,{key:"readers-also-enjoyed",title:"Readers also enjoyed",surface:"book:collaborative",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:opts.anchorProductId,candidates:base.candidates.filter((x)=>x.sources.has("collaborative")),limit,personalized:base.personalized,model,telemetry:base.telemetry,excludeProductIds:used}));
  const series=await augmentMeta(env.DB,await continueSeriesCandidates(env.DB,opts.userId,opts.anchorProductId));await add(makeRail(env,{key:"continue-series",title:anchor.seriesNames[0]?`Continue ${anchor.seriesNames[0]}`:"Continue the series",surface:"book:series",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:opts.anchorProductId,candidates:series,limit:Math.min(8,limit),personalized:base.personalized,model,excludeProductIds:used,excludeOwned:true}));
  const authorCandidates=base.candidates.filter((c)=>c.meta?.authorIds.some((a)=>anchor.authorIds.includes(a)));await add(makeRail(env,{key:"more-by-author",title:anchor.authorNames[0]?`More by ${anchor.authorNames[0]}`:"More by this author",surface:"book:author",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:opts.anchorProductId,candidates:authorCandidates,limit,personalized:false,model,excludeProductIds:used}));
  if(anchor.publisherId){const pubCandidates=base.candidates.filter((c)=>c.meta?.publisherId===anchor.publisherId);await add(makeRail(env,{key:"more-from-publisher",title:`More from ${anchor.publisherName||"this publisher"}`,surface:"book:publisher",userId:opts.userId,visitorId:opts.visitorId,territory:opts.territory,anchorProductId:opts.anchorProductId,candidates:pubCandidates,limit,personalized:false,model,excludeProductIds:used}));}
  return {rails,model:{key:model.key,version:model.version,algorithm:model.algorithm}};
}

const interactionInput=z.object({type:z.string().min(1).max(50),productId:z.string().min(1).max(160),eventId:z.string().uuid().nullable().optional(),visitorId:z.string().uuid().nullable().optional(),sessionId:z.string().max(160).nullable().optional(),requestId:z.string().uuid().nullable().optional(),position:z.number().int().min(1).max(500).nullable().optional(),value:z.number().finite().min(-1000000).max(1000000).nullable().optional(),surface:z.string().max(100).default(""),metadata:z.record(z.string(),z.unknown()).default({})});
function recommendationEventKey(userId:string|null,x:z.infer<typeof interactionInput>){
  if(x.eventId)return `client:${x.eventId}`;
  if(x.type==="recommendation_impression"||x.type==="recommendation_click")return x.requestId?`rec:${x.requestId}:${x.productId}:${x.type}`:null;
  const identity=userId||x.visitorId||"anonymous",minute=Math.floor(Date.now()/300000),day=new Date().toISOString().slice(0,10);
  if(x.type==="read_progress"){const bucket=String(x.metadata?.progressBucket??Math.max(0,Math.min(20,Math.floor(Number(x.value||0)*20))));return `progress:${identity}:${x.productId}:${x.sessionId||day}:${bucket}`;}
  if(["book_view","sample_start","read_start","search_click"].includes(x.type))return `view:${identity}:${x.productId}:${x.type}:${x.surface}:${minute}`;
  if(["library_add","completion","wishlist_add","wishlist_remove","purchase"].includes(x.type))return `state:${identity}:${x.productId}:${x.type}:${day}`;
  if(x.type==="rating")return `rating:${identity}:${x.productId}:${String(x.value??"")}:${day}`;
  return null;
}
export async function recordRecommendationEvent(db:CatalogDB,userId:string|null,raw:unknown){
  const x=interactionInput.parse(raw);if(!allowedEvents.has(x.type))throw new ApiError(400,"Unsupported recommendation event.");
  const product=await db.prepare("SELECT id FROM products WHERE id=? AND storefront_status='active'").bind(x.productId).first<any>();if(!product)throw new ApiError(400,"Unknown storefront product.");
  if(x.type==="recommendation_impression"||x.type==="recommendation_click"){
    if(!x.requestId)throw new ApiError(400,"Recommendation attribution requires a request ID.");
    const imp=await db.prepare(`SELECT i.*,r.user_id,r.visitor_id,r.created_at FROM recommendation_impressions i JOIN recommendation_requests r ON r.id=i.request_id WHERE i.request_id=? AND i.product_id=? AND r.created_at>=datetime('now','-24 hours')`).bind(x.requestId,x.productId).first<any>();
    if(!imp)throw new ApiError(400,"This recommendation was not served by Cove.");
    if(imp.user_id&&imp.user_id!==userId)throw new ApiError(403,"Recommendation attribution does not match this account.");
    if(!imp.user_id&&imp.visitor_id&&x.visitorId!==imp.visitor_id)throw new ApiError(403,"Recommendation attribution does not match this visitor.");
    if(x.type==="recommendation_click"&&!imp.impressed_at)throw new ApiError(409,"A recommendation click requires a preceding visible impression.");
    await db.prepare(`UPDATE recommendation_impressions SET ${x.type==="recommendation_impression"?"impressed_at=COALESCE(impressed_at,?)":"clicked_at=COALESCE(clicked_at,?)"} WHERE request_id=? AND product_id=?`).bind(now(),x.requestId,x.productId).run();
  }
  const privacy=await recommendationPrivacy(db,userId),learnedUser=userId&&privacy.activityPersonalizationEnabled?userId:null,eventKey=recommendationEventKey(userId,x);
  const inserted=await db.prepare("INSERT OR IGNORE INTO recommendation_events(id,user_id,visitor_id,session_id,product_id,event_type,source_surface,recommendation_request_id,position,value,metadata_json,occurred_at,event_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),learnedUser,x.visitorId||null,x.sessionId||null,x.productId,x.type,x.surface,x.requestId||null,x.position||null,x.value??null,JSON.stringify(x.metadata).slice(0,4000),now(),eventKey).run();
  const changed=Number((inserted as any)?.meta?.changes??1)>0;if(!changed)return {recorded:false,deduplicated:true,learned:!!learnedUser};
  // Clicks are weak signals and are intentionally learned; visible impressions are not.
  if(learnedUser&&x.type!=="recommendation_impression")await queueRecommendationJob(db,"user-features",learnedUser);
  await queueRecommendationJob(db,"product-metrics",x.productId);
  return {recorded:true,deduplicated:false,learned:!!learnedUser};
}

export async function recommendationFeedback(db:CatalogDB,userId:string,raw:unknown){const x=z.object({entityType:z.enum(["product","author","series"]),entityId:z.string().min(1).max(180),action:z.enum(["not_interested","hide"]),reason:z.string().max(300).default("")}).parse(raw),at=now();await db.prepare("INSERT INTO recommendation_feedback(user_id,entity_type,entity_id,action,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,entity_type,entity_id,action) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at").bind(userId,x.entityType,x.entityId,x.action,x.reason,at,at).run();await queueRecommendationJob(db,"user-features",userId);return{saved:true};}

export async function followAuthor(db:CatalogDB,userId:string,raw:unknown){const x=z.object({contributorId:z.string().min(1).max(180),follow:z.boolean()}).parse(raw);const author=await db.prepare("SELECT id FROM contributors WHERE id=?").bind(x.contributorId).first<any>();if(!author)throw new ApiError(404,"Author not found.");if(x.follow)await db.prepare("INSERT OR IGNORE INTO author_follows(user_id,contributor_id,created_at) VALUES(?,?,?)").bind(userId,x.contributorId,now()).run();else await db.prepare("DELETE FROM author_follows WHERE user_id=? AND contributor_id=?").bind(userId,x.contributorId).run();return{following:x.follow};}
export async function wishlistProduct(db:CatalogDB,userId:string,raw:unknown){
  const x=z.object({productId:z.string().min(1).max(180),saved:z.boolean(),alerts:z.object({priceDrop:z.boolean().default(true),sale:z.boolean().default(true),release:z.boolean().default(true),preorder:z.boolean().default(true)}).optional(),sourceSurface:z.string().max(100).default("wishlist"),sourceRequestId:z.string().max(180).nullable().optional(),territory:z.string().regex(/^[A-Z]{2}$/).default("US")}).parse(raw);
  const result=await setWishlistItem(db,userId,x);
  await recordRecommendationEvent(db,userId,{type:x.saved?"wishlist_add":"wishlist_remove",productId:x.productId,surface:x.sourceSurface});
  return result;
}
export async function recommendationAccountState(db:CatalogDB,userId:string){const [privacy,follows,wishlist]=await Promise.all([recommendationPrivacy(db,userId),db.prepare("SELECT contributor_id FROM author_follows WHERE user_id=?").bind(userId).all<any>(),db.prepare("SELECT product_id FROM wishlist_items WHERE user_id=? ORDER BY added_at DESC").bind(userId).all<any>()]);return{privacy,following:follows.results.map((x)=>String(x.contributor_id)),wishlist:wishlist.results.map((x)=>String(x.product_id))};}

export async function personalizedSearchEnabled(db:CatalogDB,userId:string|null){if(!userId)return false;const privacy=await recommendationPrivacy(db,userId);return privacy.personalizationEnabled&&privacy.personalizedSearchEnabled;}

export async function personalizeSearchBooks(db:CatalogDB,userId:string|null,books:CatalogBook[]){if(!userId||books.length<2)return{books,applied:false};const privacy=await recommendationPrivacy(db,userId);if(!privacy.personalizationEnabled||!privacy.personalizedSearchEnabled)return{books,applied:false};const features=await userFeatures(db,userId);if(!features.length)return{books,applied:false};const ids=books.map((b)=>String(b.productId||"")).filter(Boolean),metas=await productMeta(db,ids),basePos=new Map(ids.map((id,i)=>[id,i]));const scored=books.map((book)=>{const id=String(book.productId||""),m=metas.get(id),aff=m?affinityScore(m,features):0;const base=1/(1+(basePos.get(id)||0));return{book,score:base+Math.tanh(Math.max(-8,Math.min(8,aff))/8)*0.18};}).sort((a,b)=>b.score-a.score);return{books:scored.map((x)=>x.book),applied:true};}

async function refreshRecommendationMetricForProduct(db:CatalogDB,id:string){
  const m=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM recommendation_events WHERE product_id=? AND event_type='book_view' AND occurred_at>=datetime('now','-7 days')) views,
    (SELECT COUNT(*) FROM recommendation_events WHERE product_id=? AND event_type IN ('recommendation_click','search_click') AND occurred_at>=datetime('now','-7 days')) clicks,
    (SELECT COUNT(*) FROM recommendation_events WHERE product_id=? AND event_type='library_add' AND occurred_at>=datetime('now','-30 days')) adds,
    (SELECT COUNT(*) FROM completion_events WHERE product_id=? AND finished_at>=datetime('now','-90 days')) completions,
    (SELECT COUNT(*) FROM wishlist_items WHERE product_id=?) wishlists,
    COALESCE((SELECT average_rating FROM catalog_search_documents WHERE product_id=?),0) avg_rating,
    COALESCE((SELECT review_count FROM catalog_search_documents WHERE product_id=?),0) rating_count,
    COALESCE((SELECT download_count FROM catalog_search_documents WHERE product_id=?),0) legacy_pop`).bind(id,id,id,id,id,id,id,id).first<any>();
  const trend=Number(m?.views||0)*0.15+Number(m?.clicks||0)*1.1+Number(m?.adds||0)*2.5+Number(m?.completions||0)*4+Number(m?.wishlists||0)*0.8;
  const pop=Math.log1p(Number(m?.legacy_pop||0))*2+Number(m?.completions||0)+Number(m?.rating_count||0)*0.35+Number(m?.avg_rating||0)*2,at=now();
  await db.prepare(`INSERT INTO recommendation_item_metrics(product_id,views_7d,clicks_7d,library_adds_30d,completions_90d,wishlists,average_rating,rating_count,popularity_score,trend_score,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET views_7d=excluded.views_7d,clicks_7d=excluded.clicks_7d,library_adds_30d=excluded.library_adds_30d,completions_90d=excluded.completions_90d,wishlists=excluded.wishlists,average_rating=excluded.average_rating,rating_count=excluded.rating_count,popularity_score=excluded.popularity_score,trend_score=excluded.trend_score,updated_at=excluded.updated_at`).bind(id,m?.views||0,m?.clicks||0,m?.adds||0,m?.completions||0,m?.wishlists||0,m?.avg_rating||0,m?.rating_count||0,pop,trend,at).run();
}
export async function refreshRecommendationMetrics(db:CatalogDB){
  const at=now(),ids=await db.prepare("SELECT id FROM products WHERE storefront_status='active' AND source_name<>'upload'").all<any>();
  for(const row of ids.results)await refreshRecommendationMetricForProduct(db,String(row.id));
  await db.prepare(`INSERT INTO recommendation_regional_item_metrics(territory_code,product_id,views_7d,clicks_7d,library_adds_30d,purchases_30d,completions_90d,trend_score,popularity_score,updated_at)
    SELECT upper(r.territory_code),r.product_id,
      SUM(CASE WHEN r.event_type='product_viewed' AND r.occurred_at>=datetime('now','-7 days') THEN 1 ELSE 0 END),
      SUM(CASE WHEN r.event_type IN ('search_result_clicked','promotion_clicked') AND r.occurred_at>=datetime('now','-7 days') THEN 1 ELSE 0 END),
      SUM(CASE WHEN r.event_type='wishlist_added' AND r.occurred_at>=datetime('now','-30 days') THEN 1 ELSE 0 END),
      SUM(CASE WHEN r.event_type='purchase_completed' AND r.occurred_at>=datetime('now','-30 days') THEN MAX(1,r.quantity) ELSE 0 END),
      SUM(CASE WHEN r.event_type='book_finished' AND r.occurred_at>=datetime('now','-90 days') THEN 1 ELSE 0 END),
      SUM(CASE WHEN r.ranking_eligible=1 THEN r.ranking_weight*(CASE r.event_type WHEN 'product_viewed' THEN .15 WHEN 'search_result_clicked' THEN 1.1 WHEN 'wishlist_added' THEN 2.5 WHEN 'purchase_completed' THEN 5 WHEN 'book_finished' THEN 4 ELSE 0 END) ELSE 0 END),
      SUM(CASE WHEN r.ranking_eligible=1 THEN r.ranking_weight*(CASE r.event_type WHEN 'product_viewed' THEN .05 WHEN 'search_result_clicked' THEN .5 WHEN 'wishlist_added' THEN 1.2 WHEN 'purchase_completed' THEN 3 WHEN 'book_finished' THEN 2 ELSE 0 END) ELSE 0 END),?
    FROM retail_events r WHERE r.product_id IS NOT NULL AND r.occurred_at>=datetime('now','-90 days') GROUP BY upper(r.territory_code),r.product_id
    ON CONFLICT(territory_code,product_id) DO UPDATE SET views_7d=excluded.views_7d,clicks_7d=excluded.clicks_7d,library_adds_30d=excluded.library_adds_30d,purchases_30d=excluded.purchases_30d,completions_90d=excluded.completions_90d,trend_score=excluded.trend_score,popularity_score=excluded.popularity_score,updated_at=excluded.updated_at`).bind(at).run();
  return{products:ids.results.length,updatedAt:at,regional:true};
}

async function neighborCandidateIds(db:CatalogDB,productId:string){
  const ids=new Set<string>();
  const queries=[
    `SELECT DISTINCT p2.id FROM products p0 JOIN edition_contributors e0 ON e0.edition_id=p0.edition_id AND e0.role='author' JOIN edition_contributors e2 ON e2.contributor_id=e0.contributor_id AND e2.role='author' JOIN products p2 ON p2.edition_id=e2.edition_id WHERE p0.id=? AND p2.id<>? AND p2.storefront_status='active' AND p2.source_name<>'upload' LIMIT 350`,
    `SELECT DISTINCT p2.id FROM products p0 JOIN series_memberships s0 ON s0.edition_id=p0.edition_id JOIN series_memberships s2 ON s2.series_id=s0.series_id JOIN products p2 ON p2.edition_id=s2.edition_id WHERE p0.id=? AND p2.id<>? AND p2.storefront_status='active' AND p2.source_name<>'upload' LIMIT 250`,
    `SELECT DISTINCT p2.id FROM products p0 JOIN edition_taxonomy_nodes t0 ON t0.edition_id=p0.edition_id JOIN edition_taxonomy_nodes t2 ON t2.taxonomy_node_id=t0.taxonomy_node_id JOIN products p2 ON p2.edition_id=t2.edition_id WHERE p0.id=? AND p2.id<>? AND p2.storefront_status='active' AND p2.source_name<>'upload' LIMIT 700`,
  ];
  for(const sql of queries){const rows=await db.prepare(sql).bind(productId,productId).all<any>();for(const row of rows.results)if(ids.size<900)ids.add(String(row.id));}
  if(ids.size<100){const fallback=await db.prepare("SELECT product_id id FROM recommendation_item_metrics WHERE product_id<>? ORDER BY trend_score DESC,popularity_score DESC LIMIT 150").bind(productId).all<any>();for(const row of fallback.results)if(ids.size<900)ids.add(String(row.id));}
  return [...ids];
}

export async function rebuildItemNeighbors(db:CatalogDB,limit=100,afterProductId=""){
  const rows=await db.prepare("SELECT id FROM products WHERE storefront_status='active' AND source_name<>'upload' AND id>? ORDER BY id LIMIT ?").bind(afterProductId,Math.min(500,Math.max(1,limit))).all<any>();
  const model=await activeModel(db);let written=0;
  for(const row of rows.results){
    const id=String(row.id),meta=(await productMeta(db,[id])).get(id);if(!meta)continue;
    const candidateIds=await neighborCandidateIds(db,id),candidateMeta=await productMeta(db,candidateIds);
    const neighbors=[...candidateMeta.values()].filter((m)=>m.productId!==id).map((m)=>({m,score:contentSimilarity(meta,m)})).filter((x)=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,60);
    const coRead=await db.prepare(`SELECT b.product_id,COUNT(DISTINCT b.user_id) readers FROM reading_states a JOIN reading_states b ON b.user_id=a.user_id AND b.product_id<>a.product_id LEFT JOIN recommendation_privacy rp ON rp.user_id=a.user_id JOIN products p ON p.id=b.product_id WHERE a.product_id=? AND a.in_library=1 AND b.in_library=1 AND p.storefront_status='active' AND p.source_name<>'upload' AND COALESCE(rp.activity_personalization_enabled,1)=1 GROUP BY b.product_id ORDER BY readers DESC LIMIT 60`).bind(id).all<any>();
    await db.prepare("DELETE FROM recommendation_item_neighbors WHERE product_id=? AND strategy IN ('content','co-read')").bind(id).run();
    for(const n of neighbors){await db.prepare("INSERT INTO recommendation_item_neighbors(product_id,neighbor_product_id,strategy,score,reason_json,model_version,updated_at) VALUES(?,?,'content',?,?,?,?)").bind(id,n.m.productId,n.score,JSON.stringify({sharedTaxonomy:n.m.taxonomyPaths.filter((p)=>meta.taxonomyPaths.includes(p)),sharedAuthors:n.m.authorIds.filter((a)=>meta.authorIds.includes(a)),sharedSeries:n.m.seriesIds.filter((s)=>meta.seriesIds.includes(s))}),model.version,now()).run();written++;}
    for(const n of coRead.results){const readers=Number(n.readers||0);if(readers<1)continue;await db.prepare("INSERT OR REPLACE INTO recommendation_item_neighbors(product_id,neighbor_product_id,strategy,score,reason_json,model_version,updated_at) VALUES(?,?,'co-read',?,?,?,?)").bind(id,String(n.product_id),Math.log1p(readers)*5,JSON.stringify({coReaders:readers}),model.version,now()).run();written++;}
  }
  return{processed:rows.results.length,neighbors:written,nextAfter:rows.results.length?String(rows.results.at(-1)?.id||""):null,done:rows.results.length<limit};
}

export async function processRecommendationJobs(db:CatalogDB,limit=25){
  const batch=Math.min(100,Math.max(1,limit)),at=now();
  await db.prepare("UPDATE recommendation_jobs SET status='pending',locked_at=NULL,lease_until=NULL,available_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?").bind(at,at).run();
  const jobs=await db.prepare("SELECT * FROM recommendation_jobs WHERE status='pending' AND available_at<=? ORDER BY available_at,queued_at LIMIT ?").bind(at,batch).all<any>();let done=0,failed=0,dead=0;
  for(const job of jobs.results){
    const started=now(),lease=new Date(Date.now()+5*60*1000).toISOString(),claim=await db.prepare("UPDATE recommendation_jobs SET status='running',started_at=?,locked_at=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending'").bind(started,started,lease,job.id).run();
    if(Number((claim as any)?.meta?.changes??1)===0)continue;
    try{
      if(job.job_type==="user-features"&&job.entity_id)await rebuildUserFeatures(db,String(job.entity_id));
      else if(job.job_type==="product-metrics"&&job.entity_id)await refreshRecommendationMetricForProduct(db,String(job.entity_id));
      else if(job.job_type==="metrics")await refreshRecommendationMetrics(db);
      else throw new Error(`Unsupported recommendation job: ${String(job.job_type)}`);
      await db.prepare("UPDATE recommendation_jobs SET status='done',finished_at=?,locked_at=NULL,lease_until=NULL,last_error='' WHERE id=?").bind(now(),job.id).run();done++;
    }catch(e){
      const attempts=Number(job.attempts||0)+1,maxAttempts=Math.max(1,Number(job.max_attempts||5)),isDead=attempts>=maxAttempts,backoffMinutes=Math.min(60,Math.pow(2,Math.max(0,attempts-1)));
      const available=new Date(Date.now()+backoffMinutes*60*1000).toISOString();
      await db.prepare("UPDATE recommendation_jobs SET status=?,available_at=?,locked_at=NULL,lease_until=NULL,last_error=? WHERE id=?").bind(isDead?"dead":"pending",available,e instanceof Error?e.message.slice(0,500):String(e).slice(0,500),job.id).run();
      if(isDead)dead++;else failed++;
    }
  }
  return{processed:jobs.results.length,done,failed,dead};
}
export async function refreshRecommendationEvaluations(db:CatalogDB,windowDays=30){
  const days=Math.max(1,Math.min(180,Math.floor(windowDays))),catalog=await db.prepare("SELECT COUNT(*) count FROM products WHERE storefront_status='active' AND source_name<>'upload'").first<any>(),catalogProducts=Number(catalog?.count||0);
  const rows=await db.prepare(`SELECT r.model_key,r.model_version,r.surface,COUNT(DISTINCT r.id) requests,SUM(CASE WHEN i.impressed_at IS NOT NULL THEN 1 ELSE 0 END) impressions,SUM(CASE WHEN i.clicked_at IS NOT NULL THEN 1 ELSE 0 END) clicks,COUNT(DISTINCT CASE WHEN i.impressed_at IS NOT NULL THEN i.product_id END) unique_products,AVG(CASE WHEN i.clicked_at IS NOT NULL THEN i.position END) mean_position_clicked FROM recommendation_requests r LEFT JOIN recommendation_impressions i ON i.request_id=r.id WHERE r.created_at>=datetime('now',?) GROUP BY r.model_key,r.model_version,r.surface`).bind(`-${days} days`).all<any>();
  const sourceRows=await db.prepare(`SELECT r.model_key,r.model_version,r.surface,j.value source,COUNT(*) count FROM recommendation_requests r JOIN recommendation_impressions i ON i.request_id=r.id JOIN json_each(i.candidate_sources_json) j WHERE r.created_at>=datetime('now',?) AND i.impressed_at IS NOT NULL GROUP BY r.model_key,r.model_version,r.surface,j.value`).bind(`-${days} days`).all<any>();
  const sourceMap=new Map<string,number[]>();for(const row of sourceRows.results){const key=`${row.model_key}\u0000${row.model_version}\u0000${row.surface}`,values=sourceMap.get(key)||[];values.push(Number(row.count||0));sourceMap.set(key,values);}
  const at=now();for(const row of rows.results){const key=`${row.model_key}\u0000${row.model_version}\u0000${row.surface}`,counts=sourceMap.get(key)||[],total=counts.reduce((a,b)=>a+b,0),entropy=total>0?-counts.reduce((sum,count)=>{const p=count/total;return sum+(p>0?p*Math.log2(p):0);},0):0,impressions=Number(row.impressions||0),clicks=Number(row.clicks||0),unique=Number(row.unique_products||0);
    await db.prepare(`INSERT INTO recommendation_model_evaluations(id,model_key,model_version,surface,window_days,requests,visible_impressions,clicks,unique_products,catalog_products,ctr,catalog_coverage,mean_position_clicked,source_entropy,generated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key,model_version,surface,window_days) DO UPDATE SET requests=excluded.requests,visible_impressions=excluded.visible_impressions,clicks=excluded.clicks,unique_products=excluded.unique_products,catalog_products=excluded.catalog_products,ctr=excluded.ctr,catalog_coverage=excluded.catalog_coverage,mean_position_clicked=excluded.mean_position_clicked,source_entropy=excluded.source_entropy,generated_at=excluded.generated_at`).bind(`eval_${crypto.randomUUID()}`,String(row.model_key),String(row.model_version),String(row.surface),days,Number(row.requests||0),impressions,clicks,unique,catalogProducts,impressions?clicks/impressions:0,catalogProducts?unique/catalogProducts:0,row.mean_position_clicked==null?null:Number(row.mean_position_clicked),entropy,at).run();
  }
  return{windowDays:days,surfaces:rows.results.length,catalogProducts,generatedAt:at};
}

export async function runRecommendationMaintenance(db:CatalogDB){
  const jobs=await processRecommendationJobs(db,75),at=now();
  const retention={eventsDays:365,requestsDays:180,jobsDays:30,evaluationsDays:365};
  const lastEval=await db.prepare("SELECT MAX(generated_at) generated_at FROM recommendation_model_evaluations").first<any>();let evaluation:null|Awaited<ReturnType<typeof refreshRecommendationEvaluations>>=null;
  if(!lastEval?.generated_at||Date.now()-Date.parse(String(lastEval.generated_at))>6*60*60*1000)evaluation=await refreshRecommendationEvaluations(db,30);
  await db.prepare("DELETE FROM recommendation_cache WHERE expires_at<=?").bind(at).run();
  await db.prepare("DELETE FROM recommendation_events WHERE occurred_at<datetime('now','-365 days')").run();
  await db.prepare("DELETE FROM recommendation_requests WHERE created_at<datetime('now','-180 days')").run();
  await db.prepare("DELETE FROM recommendation_jobs WHERE status IN ('done','dead') AND COALESCE(finished_at,queued_at)<datetime('now','-30 days')").run();
  await db.prepare("DELETE FROM recommendation_model_audit WHERE created_at<datetime('now','-365 days')").run();
  return{jobs,evaluation,retention,completedAt:at};
}

export async function recommendationStatus(db:CatalogDB){
  const [models,events,features,neighbors,requests,jobs,surfaces,experiments,evaluations,scorers,staleFeatures,deadJobs,audit]=await Promise.all([
    db.prepare("SELECT * FROM recommendation_models ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC").all<any>(),
    db.prepare("SELECT COUNT(*) count FROM recommendation_events WHERE occurred_at>=datetime('now','-24 hours')").first<any>(),
    db.prepare("SELECT COUNT(*) count FROM recommendation_user_features").first<any>(),
    db.prepare("SELECT COUNT(*) count FROM recommendation_item_neighbors").first<any>(),
    db.prepare("SELECT COUNT(*) count FROM recommendation_requests WHERE created_at>=datetime('now','-24 hours')").first<any>(),
    db.prepare("SELECT status,COUNT(*) count FROM recommendation_jobs GROUP BY status").all<any>(),
    db.prepare(`SELECT r.surface,COUNT(i.impressed_at) impressions,COUNT(i.clicked_at) clicks,AVG(CASE WHEN i.clicked_at IS NOT NULL THEN 1.0 ELSE 0.0 END) ctr,AVG(r.latency_ms) avg_latency_ms,AVG(r.candidate_count) avg_candidates FROM recommendation_requests r JOIN recommendation_impressions i ON i.request_id=r.id WHERE r.created_at>=datetime('now','-30 days') GROUP BY r.surface ORDER BY impressions DESC`).all<any>(),
    db.prepare("SELECT * FROM recommendation_experiments ORDER BY updated_at DESC").all<any>(),
    db.prepare("SELECT * FROM recommendation_model_evaluations ORDER BY generated_at DESC,surface LIMIT 100").all<any>(),
    db.prepare("SELECT scorer_mode,COUNT(*) count,AVG(latency_ms) avg_latency_ms FROM recommendation_requests WHERE created_at>=datetime('now','-24 hours') GROUP BY scorer_mode").all<any>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) count FROM recommendation_user_features WHERE updated_at<datetime('now','-24 hours')").first<any>(),
    db.prepare("SELECT COUNT(*) count FROM recommendation_jobs WHERE status='dead'").first<any>(),
    db.prepare("SELECT * FROM recommendation_model_audit ORDER BY created_at DESC LIMIT 50").all<any>(),
  ]);
  const model=await activeModel(db);return{activeModel:model,models:models.results,events24h:Number(events?.count||0),features:Number(features?.count||0),neighbors:Number(neighbors?.count||0),requests24h:Number(requests?.count||0),staleFeatureUsers:Number(staleFeatures?.count||0),deadJobs:Number(deadJobs?.count||0),jobs:jobs.results,surfaces:surfaces.results,experiments:experiments.results,evaluations:evaluations.results,scorers:scorers.results,modelAudit:audit.results};
}

export async function upsertRecommendationModel(db:CatalogDB,raw:unknown){
  const configSchema=z.object({candidateGenerators:z.array(z.string().min(1).max(60)).max(30).optional(),explorationRate:z.number().min(0).max(0.5).optional(),diversityStrength:z.number().min(0).max(3).optional(),sourceWeights:z.record(z.string(),z.number().min(0).max(5)).optional(),maxCandidates:z.number().int().min(50).max(MAX_CANDIDATES).optional()}).passthrough();
  const x=z.object({modelKey:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),version:z.string().min(1).max(40),status:z.enum(["draft","active","retired"]),algorithm:z.string().min(1).max(100).default("multi-candidate-hybrid"),config:configSchema.default({})}).parse(raw),at=now(),existing=await db.prepare("SELECT status FROM recommendation_models WHERE model_key=? AND version=?").bind(x.modelKey,x.version).first<any>(),id=`rec_model_${x.modelKey}_${x.version}`;
  if(existing?.status==="active"&&x.status!=="active"){const other=await db.prepare("SELECT id FROM recommendation_models WHERE status='active' AND NOT (model_key=? AND version=?) LIMIT 1").bind(x.modelKey,x.version).first<any>();if(!other)throw new ApiError(409,"Activate another recommendation model before retiring the only active model.");}
  if(x.status==="active")await db.prepare("UPDATE recommendation_models SET status='retired' WHERE status='active' AND NOT (model_key=? AND version=?)").bind(x.modelKey,x.version).run();
  await db.prepare(`INSERT INTO recommendation_models(id,model_key,version,status,algorithm,config_json,trained_at,activated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key,version) DO UPDATE SET status=excluded.status,algorithm=excluded.algorithm,config_json=excluded.config_json,activated_at=excluded.activated_at`).bind(id,x.modelKey,x.version,x.status,x.algorithm,JSON.stringify(x.config),at,x.status==="active"?at:null,at).run();
  await db.prepare("INSERT INTO recommendation_model_audit(id,model_key,version,action,previous_status,next_status,config_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),x.modelKey,x.version,x.status==="active"?"activate":"upsert",existing?.status||null,x.status,JSON.stringify(x.config),at).run();
  if(x.status==="active")await db.prepare("UPDATE recommendation_user_features SET updated_at='1970-01-01T00:00:00.000Z'").run();
  return{id,...x,activatedAt:x.status==="active"?at:null};
}

export async function upsertRecommendationExperiment(db:CatalogDB,raw:unknown){
  const rankingConfig=z.object({explorationRate:z.number().min(0).max(0.5).optional(),diversityStrength:z.number().min(0).max(3).optional(),sourceWeights:z.record(z.string(),z.number().min(0).max(5)).optional()}).strict();
  const x=z.object({id:z.string().max(160).optional(),experimentKey:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),surface:z.string().min(1).max(100),status:z.enum(["draft","published","paused","completed"]),variants:z.array(z.object({key:z.string().min(1).max(50),weight:z.number().int().min(1).max(10000),config:rankingConfig.optional()})).min(1).max(10),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional()}).parse(raw);
  if(x.startsAt&&x.endsAt&&Date.parse(x.startsAt)>=Date.parse(x.endsAt))throw new ApiError(400,"Experiment end must be after start.");
  const id=x.id||`rec_exp_${crypto.randomUUID()}`,at=now();
  await db.prepare(`INSERT INTO recommendation_experiments(id,experiment_key,surface,status,variants_json,starts_at,ends_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET experiment_key=excluded.experiment_key,surface=excluded.surface,status=excluded.status,variants_json=excluded.variants_json,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`).bind(id,x.experimentKey,x.surface,x.status,JSON.stringify(x.variants),x.startsAt||null,x.endsAt||null,at,at).run();return{id,...x};
}

/** Resolve a CMS "personalized" placement through the same recommendation ranker used by the storefront. */
export async function recommendationPlacementBooks(env: RecommendationEnv, options: { userId: string | null; visitorId: string; territory: string; strategy?: string; limit: number }) {
  const privacy = await recommendationPrivacy(env.DB, options.userId);
  if (!options.userId || !privacy.personalizationEnabled) return [] as CatalogBook[];
  const strategy = String(options.strategy || "recommended-for-you"),model=await activeModel(env.DB);
  let candidates:Candidate[];
  if (strategy === "followed-authors") candidates=await augmentMeta(env.DB, await followedAuthorCandidates(env.DB, options.userId));
  else if (strategy === "continue-series") candidates=await augmentMeta(env.DB, await continueSeriesCandidates(env.DB, options.userId));
  else {const pool = await candidatePool(env, { userId: options.userId, territory: options.territory, mode: `placement:${strategy}`, model });candidates = strategy === "favorite-genres" ? pool.candidates.filter((x)=>x.sources.has("affinity")) : pool.candidates;}
  const allowed=await eligibleRecommendationIds(env.DB,candidates.map((x)=>x.productId),options.territory,options.userId),owned=await ownedSet(env.DB,options.userId);for(const id of owned)allowed.delete(id);
  const eligible=await augmentMeta(env.DB,candidates.filter((x)=>allowed.has(x.productId))),controls:RankingControls={explorationRate:modelNumber(model,"explorationRate",0.08,0,0.5),diversityStrength:modelNumber(model,"diversityStrength",1,0,3),sourceWeights:modelRecord(model,"sourceWeights")};
  return canonicalBooksByProductIds(env.DB, diversitySelect(applyRankingControls(eligible,controls), options.limit, `${options.visitorId}:placement:${strategy}`,controls).map((x)=>x.productId));
}
