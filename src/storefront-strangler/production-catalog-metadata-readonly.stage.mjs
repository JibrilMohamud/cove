/* eslint-disable prettier/prettier -- Staged read-only D1 migration auditor; exact SQL is security-reviewed below. */
/**
 * Production metadata fingerprinting is NOT legal authorization. This module
 * can read searchable book metadata from primary D1 but NEVER writes to D1,
 * publishes a positive rights proof, connects customer routes or grants access.
 *
 * Use only a protected D1 Read-scoped credential, outside peak traffic. The
 * result is an *observed* read consistency check, NOT an atomic snapshot.
 */
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStageProductionFtsMirror,writeStageProductionSearchMetadata,
  sealStageProductionFtsMirror,readStageProductionFtsMirror}
  from './owner-production-fts-mirror.stage.mjs';

export const PRODUCTION_ACCOUNT='d26430caa63ec55f6612e32f36aca5e9';
export const PRODUCTION_DB='4bd657ac-8789-403e-a28c-93aba8d0a989';
export const TEXT_FIELDS=Object.freeze([
  'external_book_id','title','subtitle','contributors_text','series_text',
  'publisher_text','isbn13','categories_text','keywords_text','description',
]);
export const REQUIRED_FIELDS=Object.freeze([
  'product_id',...TEXT_FIELDS,'language_code','suppressed','storefront_status',
  'source_name','release_status','currency','price_minor','updated_at',
]);

const META_SQL=`SELECT
 (SELECT COUNT(*) FROM products) products,
 (SELECT COUNT(*) FROM catalog_search_documents) documents,
 (SELECT COUNT(*) FROM catalog_search_documents WHERE suppressed=1) suppressed,
 (SELECT COUNT(*) FROM catalog_search_documents d
   JOIN products p ON p.id=d.product_id
   JOIN editions e ON e.id=p.edition_id
   WHERE d.suppressed=0 AND lower(e.language)='en') english,
 (SELECT MAX(updated_at) FROM catalog_search_documents) watermark,
 (SELECT MAX(updated_at) FROM products) product_watermark,
 (SELECT MAX(updated_at) FROM editions) edition_watermark`;
const PAGE_SQL=`SELECT d.product_id,d.external_book_id,d.title,d.subtitle,
 d.contributors_text,d.series_text,d.publisher_text,d.isbn13,
 d.categories_text,d.keywords_text,d.description,
 e.language AS language_code,d.suppressed,p.storefront_status,p.source_name,
 e.release_status,d.currency,d.price_minor,d.updated_at
 FROM catalog_search_documents d
 JOIN products p ON p.id=d.product_id
 JOIN editions e ON e.id=p.edition_id
 WHERE d.product_id>? ORDER BY d.product_id LIMIT ?`;
const REMOTE_FTS_SQL={
  global:`SELECT COUNT(*) n FROM catalog_search_fts WHERE catalog_search_fts MATCH ?`,
  english:`SELECT COUNT(*) n FROM catalog_search_fts_en WHERE catalog_search_fts_en MATCH ?`,
};
const LOCAL_FTS_SQL={
  global:`SELECT COUNT(*) n FROM cove_audit_fts WHERE cove_audit_fts MATCH ?`,
  english:`SELECT COUNT(*) n FROM cove_audit_fts_en WHERE cove_audit_fts_en MATCH ?`,
};
const SAFE_QUERIES=['"river"','"love"','"science"','"history"','"fiction"'];

function validRow(row){
  if(!row||typeof row!=='object')throw Error('catalog_readonly_invalid_row');
  for(const key of REQUIRED_FIELDS)if(!Object.hasOwn(row,key))
    throw Error('catalog_readonly_missing_field');
  if(typeof row.product_id!=='string'||row.product_id.length<1||
    row.product_id.length>160||/[\u0000-\u001f]/.test(row.product_id))
    throw Error('catalog_readonly_invalid_product_id');
  for(const name of TEXT_FIELDS)if(typeof row[name]!=='string'||
    row[name].length>100000)throw Error('catalog_readonly_invalid_text_field');
  if(typeof row.language_code!=='string'||row.language_code.length>32||
    ![0,1].includes(row.suppressed)||!Number.isSafeInteger(row.price_minor)||
    typeof row.storefront_status!=='string'||typeof row.source_name!=='string'||
    typeof row.release_status!=='string'||typeof row.currency!=='string'||
    typeof row.updated_at!=='string')throw Error('catalog_readonly_invalid_metadata');
}
function validMeta(row){
  if(!row||!['products','documents','suppressed','english'].every(k=>
    Number.isSafeInteger(row[k])&&row[k]>=0)||
    ['watermark','product_watermark','edition_watermark'].some(k=>typeof row[k]!=='string'))throw Error('catalog_readonly_invalid_baseline');
  if(row.documents!==row.products||row.suppressed>row.documents||
    row.english>row.documents-row.suppressed||row.documents>250000)
    throw Error('catalog_readonly_inconsistent_baseline');
}
function sameMeta(a,b){return ['products','documents','suppressed','english','watermark','product_watermark','edition_watermark']
  .every(k=>a[k]===b[k]);}
export function isOnlyReadSql(sql){
  if(typeof sql!=='string'||sql.includes(';'))return false;
  return /^\s*SELECT\b/i.test(sql) && !/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i.test(sql);
}

/** Cloudflare API wrapper. No raw response, token, metadata or query text is logged. */
export function createD1Reader({token,fetchImpl=fetch,accountId=PRODUCTION_ACCOUNT,
  databaseId=PRODUCTION_DB,timeoutMs=18000}){
  if(accountId!==PRODUCTION_ACCOUNT||databaseId!==PRODUCTION_DB||
    typeof token!=='string'||token.length<20)throw Error('catalog_readonly_bad_credentials_or_target');
  return async function read(sql,params=[]){
    if(!isOnlyReadSql(sql)||!Array.isArray(params)||params.length>2||
      params.some(x=>typeof x!=='string'||x.length>160))
      throw Error('catalog_readonly_nonread_query_blocked');
    let response;
    try{
      response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+
        accountId+'/d1/database/'+databaseId+'/query',{
        method:'POST',headers:{Authorization:'Bearer '+token,
          'Content-Type':'application/json'},body:JSON.stringify({sql,params}),
        signal:AbortSignal.timeout(timeoutMs),
      });
    }catch{throw Error('catalog_readonly_transport_failed');}
    if(!response?.ok)throw Error('catalog_readonly_http_'+(response?.status||0));
    let json;
    try{json=await response.json();}catch{throw Error('catalog_readonly_invalid_json');}
    if(json?.success!==true||!Array.isArray(json.result)||
      json.result.length!==1||!Array.isArray(json.result[0].results))
      throw Error('catalog_readonly_failed_query');
    return json.result[0].results;
  };
}

function makeSqlite(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cove_audit_documents(
    product_id TEXT PRIMARY KEY,language_code TEXT NOT NULL,
    suppressed INTEGER NOT NULL, storefront_status TEXT NOT NULL,
    source_name TEXT NOT NULL,release_status TEXT NOT NULL,
    currency TEXT NOT NULL,price_minor INTEGER NOT NULL,updated_at TEXT NOT NULL)`);
  db.exec(`CREATE VIRTUAL TABLE cove_audit_fts USING fts5(
    product_id UNINDEXED,external_book_id,title,subtitle,
    contributors_text,series_text,publisher_text,isbn13,categories_text,
    keywords_text,description,tokenize='unicode61 remove_diacritics 2',prefix='2 3 4')`);
  db.exec(`CREATE VIRTUAL TABLE cove_audit_fts_en USING fts5(
    product_id UNINDEXED,external_book_id,title,subtitle,
    contributors_text,series_text,publisher_text,isbn13,categories_text,
    keywords_text,description,tokenize='porter unicode61 remove_diacritics 2',prefix='2 3 4')`);
  const doc=db.prepare('INSERT INTO cove_audit_documents VALUES(?,?,?,?,?,?,?,?,?)');
  const statement=`INSERT INTO %TABLE% (product_id,${TEXT_FIELDS.join(',')}) VALUES(${Array(11).fill('?').join(',')})`;
  const global=db.prepare(statement.replace('%TABLE%','cove_audit_fts'));
  const english=db.prepare(statement.replace('%TABLE%','cove_audit_fts_en'));
  // This is an EMPTY legal-owner index, intentionally. Real metadata may be
  // imported into a stage presentation source, but it MUST NOT produce a
  // positive grant. Only a separately verified canonical owner writer may
  // ever populate this table. The source audit never executes that writer.
  db.exec(`CREATE TABLE cove_stage_owner_index_items(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id)) WITHOUT ROWID`);
  const sql={exec:(query,...args)=>{
    const prepared=db.prepare(query);
    const rows=/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)?
      prepared.all(...args):(prepared.run(...args),[]);
    return {toArray:()=>rows};
  }};
  createStageProductionFtsMirror(sql);
  return {db,doc,global,english,sql};
}

/**
 * Stream a read-only *observed* catalog and rebuild metadata-only FTS.
 * Does NOT and MUST NOT create owner-authorized product entries.
 * No book titles/content are written to disk, logs, GitHub artifacts or R2.
 * Fail closed on partial/inconsistent keyset, row cap, source watermark,
 * production FTS mismatch, or FTS query parity mismatch.
 */
export async function verifyProductionMetadata({read,batchSize=250,maxRows=250000,
  phrases=SAFE_QUERIES,onProgress=()=>{}}){
  if(typeof read!=='function'||!Number.isSafeInteger(batchSize)||batchSize<1||
    batchSize>500||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>250000)
    throw Error('catalog_readonly_invalid_scope');
  if(!Array.isArray(phrases)||phrases.length>10||phrases.some(x=>
    typeof x!=='string'||!/^(?:"[A-Za-z]{2,30}")$/.test(x)))
    throw Error('catalog_readonly_invalid_queries');
  const before=(await read(META_SQL))[0];validMeta(before);
  if(before.documents>maxRows)throw Error('catalog_readonly_refuse_large_inventory');
  const {db,doc,global,english,sql}=makeSqlite();
  const hash=createHash('sha256');
  let rowCount=0,suppressedCount=0,englishCount=0,visibilityCount=0;
  let previous='';let batches=0;
  try{
    db.exec('BEGIN IMMEDIATE');
    for(;;){
      const items=await read(PAGE_SQL,[previous,String(batchSize)]);
      if(!Array.isArray(items)||items.length>batchSize)
        throw Error('catalog_readonly_invalid_page');
      if(items.length===0)break;
      batches++;
      for(const row of items){
        validRow(row);
        if(row.product_id<=previous)throw Error('catalog_readonly_duplicate_or_unsorted');
        previous=row.product_id;rowCount++;
        if(rowCount>maxRows||rowCount>before.documents)
          throw Error('catalog_readonly_overflow');
        hash.update(JSON.stringify(REQUIRED_FIELDS.map(k=>row[k]))+'\n','utf8');
        doc.run(row.product_id,row.language_code,row.suppressed,
          row.storefront_status,row.source_name,row.release_status,
          row.currency,row.price_minor,row.updated_at);
        // Metadata is copied into an isolated stage PRESENTATION table,
        // never the authoritative owner-authorization index. Its triggers
        // must keep BOTH owner-serving FTS5 indices EMPTY without grants.
        writeStageProductionSearchMetadata(sql,{
          product_id:row.product_id,...Object.fromEntries(TEXT_FIELDS.map(k=>[k,row[k]])),
          language_code:row.language_code,suppressed:row.suppressed===1,
          storefront_status:row.storefront_status,source_name:row.source_name,
          release_status:row.release_status,
        });
        const visible=row.suppressed===0&&row.storefront_status==='active'&&
          row.source_name!=='upload'&&['available','preorder'].includes(row.release_status);
        if(visible)visibilityCount++;
        if(row.suppressed===1){suppressedCount++;continue;}
        global.run(row.product_id,...TEXT_FIELDS.map(k=>row[k]));
        if(row.language_code.toLowerCase()==='en'){
          english.run(row.product_id,...TEXT_FIELDS.map(k=>row[k]));
          englishCount++;
        }
      }
      if(batches%25===0)onProgress({batches,documents:rowCount,authorizedProducts:0});
      if(items.length<batchSize)break;
    }
    if(rowCount!==before.documents||suppressedCount!==before.suppressed||
      englishCount!==before.english)throw Error('catalog_readonly_incomplete_population');
    const after=(await read(META_SQL))[0];validMeta(after);
    if(!sameMeta(before,after))throw Error('catalog_readonly_source_changed_during_scan');
    const localGlobal=db.prepare('SELECT COUNT(*) n FROM cove_audit_fts').get().n;
    const localEnglish=db.prepare('SELECT COUNT(*) n FROM cove_audit_fts_en').get().n;
    if(localGlobal!==before.documents-before.suppressed||localEnglish!==before.english)
      throw Error('catalog_readonly_local_fts_incomplete');
    const stageSource=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_prod_search_source').get().n;
    const stageOwner=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_index_items').get().n;
    const noGrants=sealStageProductionFtsMirror(sql);
    if(stageSource!==before.documents||stageOwner!==0||
      noGrants.global_count!==0||noGrants.english_count!==0||noGrants.mapped!==0)
      throw Error('catalog_readonly_metadata_must_not_grant_rights');
    const inaccessible=readStageProductionFtsMirror(sql,{
      query:'river',territory:'US',currency:'USD',language:'all',
      sort:'relevance',page:1,limit:24,
    },()=>({count:0,pageIds:[],releaseCertified:false}));
    if(inaccessible.count!==0||inaccessible.pageIds.length!==0)
      throw Error('catalog_readonly_unauthorized_search_visible');
    const parity=[];
    for(const phrase of phrases){
      for(const language of ['global','english']){
        const remote=(await read(REMOTE_FTS_SQL[language],[phrase]))[0]?.n;
        const local=db.prepare(LOCAL_FTS_SQL[language]).get(phrase)?.n;
        if(!Number.isSafeInteger(remote)||remote!==local)
          throw Error('catalog_readonly_fts_search_mismatch');
        parity.push({language,queryClass:'literal',matchingDocuments:remote});
      }
    }
    db.exec('COMMIT');
    return {schema:'cove.readonly-production-metadata-audit.v1',
      documents:rowCount,suppressed:suppressedCount,globalFts:localGlobal,
      englishFts:localEnglish,visibleMetadata:visibilityCount,
      observedSourceWatermarks:{document:after.watermark,product:after.product_watermark,
        edition:after.edition_watermark},
      sha256:hash.digest('hex'),batches,phraseChecks:parity,
      // Rows in metadata-only mirrors are NEVER positive owner authorization.
      authorizedProducts:0,stageMetadataRows:stageSource,
      stageAuthorizedFtsDocuments:0,atomicPrimarySnapshot:false,
      productionOwnerEvidence:false,fullSearchInputParity:false,
      releaseCertified:false};
  }finally{db.close();}
}

export const COVE_AUDIT_READ_SQL=Object.freeze({META_SQL,PAGE_SQL,
  REMOTE_FTS_SQL,LOCAL_FTS_SQL});