/* eslint-disable prettier/prettier -- Auditable isolated owner SQLite stage: never customer authorization. */
/**
 * Staging-only proof of a bounded full-population catalog query inside the
 * SAME strongly consistent SQLite authority that stores legal withdrawal.
 * Presentation fields in this table are intentionally NON-AUTHORITATIVE.
 * An owner must independently verify every source mutation and metadata
 * publication before this design can be adapted for production.
 *
 * This first cut handles the anonymous unfiltered rank-ordered catalog,
 * exact count, disjunctive-free facets, page numbers and authoritative price.
 * Any other search/filter/sort is explicitly unsupported, not approximate.
 */
import type {AuthoritySql} from './legal-authority-core';

const PRODUCT=/^prd_[a-zA-Z0-9_-]{3,120}$/;
const CODE=/^[A-Z]{2,3}$/;
const TEXT=/^[^\u0000-\u001f]{1,160}$/;

export function createStageOwnerCatalogSchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_catalog(
    product_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    publisher TEXT NOT NULL,
    rank_score INTEGER NOT NULL CHECK(rank_score>=0)
  ) WITHOUT ROWID`);
  for(const kind of ['category','language','series'] as const){
    sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_owner_catalog_${kind}(
      product_id TEXT NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(product_id,value)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_catalog_${kind}_value
      ON cove_stage_owner_catalog_${kind}(value,product_id)`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS cove_stage_owner_catalog_rank
    ON cove_stage_owner_catalog(rank_score DESC,product_id)`);
}

export function stageStorePresentation(sql:AuthoritySql, raw:{
  productId:string;title:string;format:string;publisher:string;rank:number;
  categories:string[];languages:string[];series:string[];
}){
  const v=raw;
  if(!v||!PRODUCT.test(v.productId)||!TEXT.test(v.title)||!TEXT.test(v.format)||
     !TEXT.test(v.publisher)||!Number.isSafeInteger(v.rank)||v.rank<0||
     ['categories','languages','series'].some(k=>{
       const a=v[k as 'categories'|'languages'|'series'];
       return !Array.isArray(a)||a.length>25||a.some(x=>typeof x!=='string'||!TEXT.test(x))||
         new Set(a).size!==a.length;
     })) throw Error('stage_catalog_invalid_presentation');
  sql.exec('INSERT INTO cove_stage_owner_catalog(product_id,title,format,publisher,rank_score) VALUES(?,?,?,?,?)',
    v.productId,v.title,v.format,v.publisher,v.rank);
  for(const [kind,values] of [
    ['category',v.categories],['language',v.languages],['series',v.series],
  ] as const){
    for(const value of values)
      sql.exec(`INSERT INTO cove_stage_owner_catalog_${kind}(product_id,value) VALUES(?,?)`,v.productId,value);
  }
}

/**
 * Legal predicates must match readAuthorizedPresentations() and
 * readCommercialStorefront() exactly. Free source revisions, global deny
 * precedence, paid grant/contract/version/epoch/expiry, subject tombstones
 * and market-wide withdrawal are checked in this one local SQLite read.
 * No primary D1 / R2 / KV / eventual replica is consulted for permission.
 */
export const STAGE_OWNER_CATALOG_SQL=`WITH input(territory,currency,at) AS (VALUES(?,?,?)),
allowed_free AS (
  SELECT d.product_id,d.title,d.format,d.publisher,d.rank_score,
         CAST(json_extract(p.offer_json,'$.amountMinor') AS INTEGER) price_minor
    FROM input a CROSS JOIN cove_authorized_offer_proofs p
    JOIN cove_stage_owner_catalog d ON d.product_id=p.product_id
    WHERE p.territory=a.territory AND p.currency=a.currency
      AND (
        SELECT f.verdict FROM cove_legal_fences f
         WHERE f.source_id=p.source_id AND f.territory IN (a.territory,'*')
         ORDER BY f.revision DESC,
           CASE WHEN f.verdict='deny' THEN 0 ELSE 1 END LIMIT 1
      )='allow'
      AND p.revision=(
        SELECT f.revision FROM cove_legal_fences f
         WHERE f.source_id=p.source_id AND f.territory IN (a.territory,'*')
         ORDER BY f.revision DESC,
           CASE WHEN f.verdict='deny' THEN 0 ELSE 1 END LIMIT 1
      )
      AND p.product_id LIKE 'prd_gutenberg_%'
),
allowed_paid AS (
  SELECT d.product_id,d.title,d.format,d.publisher,d.rank_score,
         CAST(json_extract(p.offer_json,'$.amountMinor') AS INTEGER) price_minor
    FROM input a CROSS JOIN cove_commercial_storefront_proofs p
    JOIN cove_stage_owner_catalog d ON d.product_id=p.product_id
    JOIN cove_commercial_scope_proofs legal
      ON legal.product_id=p.product_id AND legal.territory=p.territory
     AND legal.channel='retail'
     AND legal.epoch=p.rights_epoch AND legal.edition_id=p.edition_id
     AND legal.grant_id=p.grant_id AND legal.contract_id=p.contract_id
     AND legal.contract_version_id=p.contract_version_id
    JOIN cove_commercial_authority rights
      ON rights.product_id=p.product_id AND rights.epoch=p.rights_epoch
     AND rights.verdict='allow'
    WHERE p.territory=a.territory AND p.currency=a.currency
      AND p.product_id NOT LIKE 'prd_gutenberg_%'
      AND p.valid_until>a.at AND legal.valid_until>a.at
      AND NOT EXISTS (
        SELECT 1 FROM cove_commercial_subject_denials denied
        WHERE (denied.subject_kind='grant' AND denied.subject_id=p.grant_id)
           OR (denied.subject_kind='contract' AND denied.subject_id=p.contract_id)
      )
),
live AS MATERIALIZED (
  SELECT * FROM allowed_free UNION ALL SELECT * FROM allowed_paid
),
permitted AS MATERIALIZED (
  SELECT * FROM live WHERE NOT EXISTS (
    SELECT 1 FROM cove_market_withdrawals m,input a WHERE m.territory=a.territory
  )
)
SELECT
 (SELECT COUNT(*) FROM permitted) total,
 (SELECT COALESCE(json_group_array(product_id),'[]') FROM (
   SELECT product_id FROM permitted
    ORDER BY rank_score DESC,product_id ASC LIMIT ? OFFSET ?
 )) page_ids,
 (SELECT COALESCE(json_group_array(json_object('value',value,'count',num)),'[]') FROM (
   SELECT c.value,COUNT(DISTINCT p.product_id) num
   FROM permitted p JOIN cove_stage_owner_catalog_category c ON c.product_id=p.product_id
   GROUP BY c.value ORDER BY num DESC,c.value LIMIT 40
 )) categories,
 (SELECT COALESCE(json_group_array(json_object('value',value,'count',num)),'[]') FROM (
   SELECT l.value,COUNT(DISTINCT p.product_id) num
   FROM permitted p JOIN cove_stage_owner_catalog_language l ON l.product_id=p.product_id
   GROUP BY l.value ORDER BY num DESC,l.value LIMIT 30
 )) languages,
 (SELECT COALESCE(json_group_array(json_object('value',value,'count',num)),'[]') FROM (
   SELECT p.format value,COUNT(*) num FROM permitted p
   GROUP BY p.format ORDER BY num DESC,p.format LIMIT 20
 )) formats,
 (SELECT COALESCE(json_group_array(json_object('value',value,'count',num)),'[]') FROM (
   SELECT p.publisher value,COUNT(*) num FROM permitted p
   WHERE p.publisher<>'' GROUP BY p.publisher ORDER BY num DESC,p.publisher LIMIT 30
 )) publishers,
 (SELECT COALESCE(json_group_array(json_object('value',value,'count',num)),'[]') FROM (
   SELECT s.value,COUNT(DISTINCT p.product_id) num
   FROM permitted p JOIN cove_stage_owner_catalog_series s ON s.product_id=p.product_id
   GROUP BY s.value ORDER BY num DESC,s.value LIMIT 30
 )) series,
 (SELECT CASE WHEN EXISTS(SELECT 1 FROM permitted) THEN json_array(
   json_object('value','available','count',(SELECT COUNT(*) FROM permitted))
 ) ELSE '[]' END) availability,
 (SELECT MIN(price_minor) FROM permitted) min_price,
 (SELECT MAX(price_minor) FROM permitted) max_price`;

export type StageOwnerCatalogRead={
  count:number;pageIds:string[];
  facets:{categories:Array<{value:string;count:number}>;
    languages:Array<{value:string;count:number}>;
    formats:Array<{value:string;count:number}>;
    publishers:Array<{value:string;count:number}>;
    series:Array<{value:string;count:number}>;
    availability:Array<{value:string;count:number}>;
    price:{currency:string;min:number;max:number}|null};
  releaseCertified:false;
};
export function stageOwnerCatalogRead(sql:AuthoritySql, input:{
  territory:string;currency:string;page:number;limit:number;sort:'rank';
  query?:''; // intentionally refuse all other query modes
}):StageOwnerCatalogRead{
  if(!input||!CODE.test(input.territory)||input.territory.length!==2||
    !CODE.test(input.currency)||input.currency.length!==3||input.sort!=='rank'||
    input.query&&input.query!==''||!Number.isSafeInteger(input.page)||
    input.page<1||input.page>500||!Number.isSafeInteger(input.limit)||
    input.limit<1||input.limit>25||
    Object.keys(input).some(k=>!['territory','currency','page','limit','sort','query'].includes(k)))
    throw Error('stage_catalog_unsupported_scope');
  const at=new Date().toISOString();
  const row=sql.exec<{
    total:number;page_ids:string;categories:string;languages:string;
    formats:string;publishers:string;series:string;availability:string;
    min_price:number|null;max_price:number|null;
  }>(STAGE_OWNER_CATALOG_SQL,input.territory,input.currency,at,input.limit,(input.page-1)*input.limit).toArray()[0];
  if(!row||!Number.isSafeInteger(row.total)||row.total<0)
    throw Error('stage_catalog_owner_query_unverified');
  const decode=(x:string)=>JSON.parse(x) as Array<{value:string;count:number}>;
  const ids=JSON.parse(row.page_ids) as string[];
  if(!Array.isArray(ids)||ids.length>input.limit||ids.some(x=>typeof x!=='string'))
    throw Error('stage_catalog_owner_page_unverified');
  return {count:row.total,pageIds:ids,facets:{
    categories:decode(row.categories),languages:decode(row.languages),
    formats:decode(row.formats),publishers:decode(row.publishers),
    series:decode(row.series),availability:decode(row.availability),
    price:row.min_price===null||row.max_price===null?null:
      {currency:input.currency,min:row.min_price,max:row.max_price},
  },releaseCertified:false};
}

/**
 * Snapshot experiment for the COMMON anonymous page-one scope ONLY. The
 * expensive full-population calculation happens at OWNER publication time,
 * not on every customer read. Other pages/searches are expressly unsupported.
 * A future production version needs indexed, incremental maintenance and
 * verified scheduling. This proof NEVER replaces canonical owner authorizers.
 */
const SNAPSHOT_TABLES=[
  'cove_legal_fences','cove_authorized_offer_proofs',
  'cove_commercial_authority','cove_commercial_scope_proofs',
  'cove_commercial_storefront_proofs','cove_commercial_subject_denials',
  'cove_market_withdrawals','cove_stage_owner_catalog',
  'cove_stage_owner_catalog_category','cove_stage_owner_catalog_language',
  'cove_stage_owner_catalog_series',
] as const;
export function createStageOwnerCatalogSnapshotSchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_catalog_generation(
    id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL CHECK(generation>=0)
  )`);
  sql.exec('INSERT OR IGNORE INTO cove_stage_catalog_generation(id,generation) VALUES(1,0)');
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_stage_catalog_snapshot(
    territory TEXT NOT NULL,currency TEXT NOT NULL,
    generation INTEGER NOT NULL,expires_at TEXT NOT NULL,
    body TEXT NOT NULL,PRIMARY KEY(territory,currency)
  ) WITHOUT ROWID`);
  // Any direct SQLite mutation that bypasses the anticipated owner command
  // invalidates the snapshot before any subsequent reader can consume it.
  // As new legal mutation sources are added, the closure audit MUST expand.
  for(const [i,table] of SNAPSHOT_TABLES.entries()){
    for(const verb of ['INSERT','UPDATE','DELETE'] as const){
      const name=`cove_stage_catalog_mutation_${i}_${verb.toLowerCase()}`;
      sql.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${verb} ON ${table}
        BEGIN UPDATE cove_stage_catalog_generation
          SET generation=generation+1 WHERE id=1; END`);
    }
  }
}
export function rebuildStageOwnerCatalogSnapshot(sql:AuthoritySql){
  // Must be invoked in the SAME SQLite transactionSync as the owner writer.
  // This intentionally slow rebuild is a correctness reference, not yet the
  // incremental, mutation-time O(log n) algorithm needed for production.
  const scope={territory:'US',currency:'USD',page:1,limit:24,sort:'rank' as const};
  const resolved=stageOwnerCatalogRead(sql,scope);
  const generation=sql.exec<{generation:number}>(
    'SELECT generation FROM cove_stage_catalog_generation WHERE id=1'
  ).toArray()[0]?.generation;
  if(!Number.isSafeInteger(generation))throw Error('stage_catalog_missing_generation');
  // Conservative expiry is bounded by ANY paid proof, including withdrawn
  // ones, not merely those currently returned by the search. A scheduled
  // legal event earlier than this requires a separate owner-first mutation.
  const paid=sql.exec<{expires_at:string|null}>(
    `SELECT MIN(valid_until) expires_at FROM cove_commercial_storefront_proofs`
  ).toArray()[0]?.expires_at;
  const earliest=paid?Date.parse(paid):Number.POSITIVE_INFINITY;
  if(paid&&!Number.isFinite(earliest))throw Error('stage_catalog_invalid_proof_expiry');
  const now=Date.now();
  const expiry=Math.min(now+4*60_000,earliest-1000);
  if(!(expiry>now))throw Error('stage_catalog_snapshot_expired_at_publication');
  sql.exec(`INSERT INTO cove_stage_catalog_snapshot(territory,currency,generation,expires_at,body)
    VALUES(?,?,?,?,?) ON CONFLICT(territory,currency) DO UPDATE SET
    generation=excluded.generation,expires_at=excluded.expires_at,body=excluded.body`,
    scope.territory,scope.currency,generation,new Date(expiry).toISOString(),
    JSON.stringify(resolved));
  return resolved;
}
export function readStageOwnerCatalogSnapshot(sql:AuthoritySql, input:{
  territory:string;currency:string;page:number;limit:number;sort:'rank';query?:'';
}):StageOwnerCatalogRead{
  if(!input||input.territory!=='US'||input.currency!=='USD'||
     input.page!==1||input.limit!==24||input.sort!=='rank'||
     input.query&&input.query!==''||
     Object.keys(input).some(k=>!['territory','currency','page','limit','sort','query'].includes(k)))
    throw Error('stage_catalog_snapshot_unreviewed_scope');
  const row=sql.exec<{body:string}>(`SELECT s.body FROM cove_stage_catalog_snapshot s
    JOIN cove_stage_catalog_generation g ON g.id=1
    WHERE s.territory=? AND s.currency=? AND s.generation=g.generation
      AND s.expires_at>?`,input.territory,input.currency,new Date().toISOString()).toArray()[0];
  if(!row)throw Error('stage_catalog_snapshot_unavailable_or_revoked');
  const decoded=JSON.parse(row.body) as StageOwnerCatalogRead;
  if(decoded.releaseCertified!==false||!Array.isArray(decoded.pageIds)||
      !Number.isSafeInteger(decoded.count))
    throw Error('stage_catalog_snapshot_corrupt');
  return decoded;
}