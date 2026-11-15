/**
 * ISOLATED staging mirror of production FTS5 textual contract. NEVER a rights source.
 * Product authorization comes only from the existing strongly consistent owner index.
 * Requires owner-index schema to already exist before creating these triggers.
 * No Worker routes, DB bindings, production tables or payment code are touched.
 */
const CONTENT_FIELDS = Object.freeze([
  'external_book_id', 'title', 'subtitle', 'contributors_text', 'series_text',
  'publisher_text', 'isbn13', 'categories_text', 'keywords_text', 'description',
]);
const SELECT_FIELDS = CONTENT_FIELDS.map(x => `d.${x}`).join(',');
const NEW_FIELDS = CONTENT_FIELDS.map(x => `NEW.${x}`).join(',');
const QUOTED_FIELDS = CONTENT_FIELDS.join(',');
const OWNER_DB_INDEX = 'cove_stage_owner_index_items';
const SOURCE = 'cove_stage_owner_prod_search_source';
const KEYS = 'cove_stage_owner_prod_fts_keys';
const FTS = 'cove_stage_owner_prod_fts';
const EN = 'cove_stage_owner_prod_fts_en';
const READY = 'cove_stage_owner_prod_fts_ready';
const ID = /^[a-zA-Z0-9_:-]{1,128}$/;

export const PRODUCTION_FTS_FIELDS = CONTENT_FIELDS;
export const PRODUCTION_FTS_SCHEMA = Object.freeze({
  searchableFields: CONTENT_FIELDS,
  globalTokenizer: 'unicode61 remove_diacritics 2',
  englishTokenizer: 'porter unicode61 remove_diacritics 2',
  prefixes: '2 3 4',
  // Exact order in src/features/fore/search.server.ts candidateParts().
  bm25Weights: [0,14,11,12,10,8,4,14,4,3,1],
});

function exec(sql, statement, ...args) {return sql.exec(statement,...args).toArray();}
const membership = (prefix) => `EXISTS(SELECT 1 FROM ${OWNER_DB_INDEX} i
  WHERE i.territory='US' AND i.currency='USD' AND i.product_id=${prefix}.product_id)`;
const eligibility = (prefix) => `${prefix}.suppressed=0 AND ${prefix}.storefront_status='active'
  AND ${prefix}.source_name<>'upload' AND ${prefix}.release_status IN ('available','preorder')`;
const eligible = (prefix) => `${eligibility(prefix)} AND ${membership(prefix)}`;

function refreshStatements(productId) {
  const row = `(SELECT fts_rowid FROM ${KEYS} WHERE product_id=${productId})`;
  return `
    DELETE FROM ${FTS} WHERE rowid=${row};
    DELETE FROM ${EN} WHERE rowid=${row};
    DELETE FROM ${KEYS} WHERE product_id=${productId};
    INSERT INTO ${KEYS}(product_id)
      SELECT d.product_id FROM ${SOURCE} d
      WHERE d.product_id=${productId} AND ${eligible('d')};
    INSERT INTO ${FTS}(rowid,product_id,${QUOTED_FIELDS})
      SELECT k.fts_rowid,d.product_id,${SELECT_FIELDS}
      FROM ${SOURCE} d JOIN ${KEYS} k ON k.product_id=d.product_id
      WHERE d.product_id=${productId};
    INSERT INTO ${EN}(rowid,product_id,${QUOTED_FIELDS})
      SELECT k.fts_rowid,d.product_id,${SELECT_FIELDS}
      FROM ${SOURCE} d JOIN ${KEYS} k ON k.product_id=d.product_id
      WHERE d.product_id=${productId} AND lower(d.language_code)='en';
  `;
}

export function createStageProductionFtsMirror(sql) {
  exec(sql, `CREATE TABLE IF NOT EXISTS ${SOURCE} (
    product_id TEXT PRIMARY KEY NOT NULL, external_book_id TEXT NOT NULL,
    title TEXT NOT NULL, subtitle TEXT NOT NULL,
    contributors_text TEXT NOT NULL, series_text TEXT NOT NULL,
    publisher_text TEXT NOT NULL, isbn13 TEXT NOT NULL,
    categories_text TEXT NOT NULL, keywords_text TEXT NOT NULL,
    description TEXT NOT NULL,language_code TEXT NOT NULL,
    suppressed INTEGER NOT NULL CHECK(suppressed IN (0,1)),
    storefront_status TEXT NOT NULL,source_name TEXT NOT NULL,release_status TEXT NOT NULL
  ) WITHOUT ROWID`);
  exec(sql, `CREATE TABLE IF NOT EXISTS ${KEYS}(
    fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL UNIQUE)`);
  for (const [name,tokenize] of [[FTS,PRODUCTION_FTS_SCHEMA.globalTokenizer],
    [EN,PRODUCTION_FTS_SCHEMA.englishTokenizer]]) {
    exec(sql, `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(
      product_id UNINDEXED, ${QUOTED_FIELDS},
      tokenize='${tokenize}',prefix='2 3 4')`);
  }
  exec(sql, `CREATE TABLE IF NOT EXISTS ${READY}(
    id INTEGER PRIMARY KEY CHECK(id=1),ready INTEGER NOT NULL CHECK(ready IN(0,1)))`);
  exec(sql, `INSERT OR IGNORE INTO ${READY}(id,ready) VALUES(1,0)`);
  // Metadata updates do not grant access: FTS joins only authorized owner rows.
  exec(sql, `CREATE TRIGGER IF NOT EXISTS stage_prod_fts_source_no_rekey
    BEFORE UPDATE OF product_id ON ${SOURCE}
    WHEN OLD.product_id<>NEW.product_id BEGIN SELECT RAISE(ABORT,'stage_prod_fts_source_rekey'); END`);
  for (const action of ['INSERT','UPDATE','DELETE']) {
    const target=action==='DELETE'?'OLD.product_id':'NEW.product_id';
    exec(sql, `CREATE TRIGGER IF NOT EXISTS stage_prod_fts_source_${action.toLowerCase()}
      AFTER ${action} ON ${SOURCE} BEGIN ${refreshStatements(target)} END`);
  }
  for (const action of ['INSERT','UPDATE','DELETE']) {
    const target=action==='DELETE'?'OLD.product_id':'NEW.product_id';
    exec(sql, `CREATE TRIGGER IF NOT EXISTS stage_prod_fts_owner_${action.toLowerCase()}
      AFTER ${action} ON ${OWNER_DB_INDEX} BEGIN ${refreshStatements(target)} END`);
  }
}

export function writeStageProductionSearchMetadata(sql, raw) {
  if(!raw||typeof raw!=='object'||!ID.test(raw.product_id)||
    CONTENT_FIELDS.some(k=>typeof raw[k]!=='string'||raw[k].length>10000)||
    !/^[a-z]{2,8}(?:-[a-z]{2,8})?$/i.test(raw.language_code)||
    ['storefront_status','source_name','release_status'].some(k=>
      typeof raw[k]!=='string'||raw[k].length<1||raw[k].length>80)||
    typeof raw.suppressed!=='boolean')
    throw Error('stage_production_fts_invalid_metadata');
  exec(sql,`INSERT INTO ${SOURCE}(product_id,${QUOTED_FIELDS},language_code,suppressed,
    storefront_status,source_name,release_status)
    VALUES(${Array(16).fill('?').join(',')}) ON CONFLICT(product_id) DO UPDATE SET
    ${CONTENT_FIELDS.map(x=>`${x}=excluded.${x}`).join(',')},
    language_code=excluded.language_code,suppressed=excluded.suppressed,
    storefront_status=excluded.storefront_status,source_name=excluded.source_name,
    release_status=excluded.release_status`,
    raw.product_id,...CONTENT_FIELDS.map(x=>raw[x]),raw.language_code,Number(raw.suppressed),
    raw.storefront_status,raw.source_name,raw.release_status);
}

export function sealStageProductionFtsMirror(sql){
  // A failed re-seal MUST revoke a prior readiness bit. Never leave an old
  // successful population certificate active after detecting corruption.
  exec(sql,`UPDATE ${READY} SET ready=0 WHERE id=1`);
  const metrics=exec(sql,`SELECT
    (SELECT COUNT(*) FROM ${OWNER_DB_INDEX} i JOIN ${SOURCE} d
      ON d.product_id=i.product_id WHERE i.territory='US' AND i.currency='USD'
      AND ${eligibility('d')}) expected,
    (SELECT COUNT(*) FROM ${KEYS}) mapped,
    (SELECT COUNT(*) FROM ${FTS}) global_count,
    (SELECT COUNT(*) FROM ${EN}) english_count,
    (SELECT COUNT(*) FROM ${OWNER_DB_INDEX} i JOIN ${SOURCE} d
      ON d.product_id=i.product_id WHERE i.territory='US' AND i.currency='USD'
      AND ${eligibility('d')} AND lower(d.language_code)='en') expected_en`)[0];
  if(!metrics||metrics.expected!==metrics.mapped||metrics.expected!==metrics.global_count||
    metrics.expected_en!==metrics.english_count)
    throw Error('stage_production_fts_incomplete_migration');
  // Every authorization-index row requires metadata, even if suppressed.
  // Otherwise an empty metadata table could falsely seal an empty search index.
  const noMetadata=exec(sql,`SELECT 1 FROM ${OWNER_DB_INDEX} i
    LEFT JOIN ${SOURCE} d ON d.product_id=i.product_id
    WHERE i.territory='US' AND i.currency='USD' AND d.product_id IS NULL LIMIT 1`);
  const orphanKey=exec(sql,`SELECT 1 FROM ${KEYS} k
    LEFT JOIN ${SOURCE} d ON d.product_id=k.product_id
    LEFT JOIN ${OWNER_DB_INDEX} i ON i.product_id=k.product_id
      AND i.territory='US' AND i.currency='USD'
    WHERE d.product_id IS NULL OR i.product_id IS NULL LIMIT 1`);
  // Counts alone cannot prove content or identity. Fail on swapped or forged rows.
  const mismatch=exec(sql,`SELECT 1 FROM ${KEYS} k
    JOIN ${SOURCE} d ON d.product_id=k.product_id
    JOIN ${FTS} f ON f.rowid=k.fts_rowid
    LEFT JOIN ${EN} en ON en.rowid=k.fts_rowid
    WHERE NOT (${eligible('d')}) OR f.product_id<>d.product_id OR
      (${CONTENT_FIELDS.map(x=>`f.${x}<>d.${x}`).join(' OR ')}) OR
      (lower(d.language_code)='en' AND (en.product_id IS NULL OR
       en.product_id<>d.product_id OR
       (${CONTENT_FIELDS.map(x=>`en.${x}<>d.${x}`).join(' OR ')}))) OR
      (lower(d.language_code)<>'en' AND en.product_id IS NOT NULL)
    LIMIT 1`);
  const missing=exec(sql,`SELECT 1 FROM ${OWNER_DB_INDEX} i JOIN ${SOURCE} d
    ON d.product_id=i.product_id WHERE i.territory='US' AND i.currency='USD'
    AND ${eligibility('d')} AND NOT EXISTS (SELECT 1 FROM ${KEYS} k
      WHERE k.product_id=i.product_id) LIMIT 1`);
  if(noMetadata.length||orphanKey.length||mismatch.length||missing.length)
    throw Error('stage_production_fts_incomplete_migration');
  exec(sql,`UPDATE ${READY} SET ready=1 WHERE id=1`);
  return metrics;
}

export function productionFtsExpression(raw,topic=''){
  if(typeof raw!=='string'||raw.length>160||typeof topic!=='string'||topic.length>100)
    throw Error('stage_production_fts_invalid_query');
  const clean=s=>s.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().toLocaleLowerCase('en-US');
  const query=clean(raw), normalizedTopic=clean(topic);
  const compact=query.replace(/[\s-]/g,'');
  const quote=s=>'"'+s.replace(/"/g,'""')+'"';
  if(/^(?:\d{13}|\d{9}[\dx])$/i.test(compact))
    return `isbn13 : ${quote(compact)}`;
  if(/^(?:\d{1,9}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100})$/.test(query))
    return `external_book_id : ${quote(query)}`;
  const tokens=query.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)||[];
  if(tokens.length>24)throw Error('stage_production_fts_invalid_query');
  const groups=tokens.map((token,i)=>`(${quote(token)}${i===tokens.length-1?'*':''})`);
  if(normalizedTopic)groups.push(`categories_text : ${quote(normalizedTopic)}*`);
  return groups.join(' AND ');
}

/** Requires the caller's real owner-local index read as a synchronous legal
 * gate. Do not bind this stage-only endpoint to an external customer route. */
export function readStageProductionFtsMirror(sql,input,legalIndexRead){
  if(!input||Object.keys(input).some(k=>!['query','topic','territory','currency','language',
    'page','limit','sort'].includes(k))||input.territory!=='US'||input.currency!=='USD'||
    !['en','all'].includes(input.language)||input.sort!=='relevance'||
    !Number.isSafeInteger(input.page)||input.page<1||input.page>500||
    !Number.isSafeInteger(input.limit)||input.limit<1||input.limit>60||
    typeof legalIndexRead!=='function')throw Error('stage_production_fts_unreviewed_scope');
  // Never consider a FTS match legally valid; the real owner index first
  // checks current legal epoch, dirty queue, paid expiry and market veto.
  const legal=legalIndexRead();
  if(!legal||legal.releaseCertified!==false||!Number.isSafeInteger(legal.count))
    throw Error('stage_production_fts_authority_missing');
  if(!exec(sql,`SELECT ready FROM ${READY} WHERE id=1 AND ready=1`).length)
    throw Error('stage_production_fts_unsealed');
  if(legal.count===0)return {count:0,pageIds:[],releaseCertified:false};
  const expression=productionFtsExpression(input.query,input.topic||'');
  if(!expression)throw Error('stage_production_fts_empty_query_requires_default_index');
  const table=input.language==='en'?EN:FTS;
  const count=exec(sql,`SELECT COUNT(*) total FROM ${table} f
    JOIN ${KEYS} k ON k.fts_rowid=f.rowid
    JOIN ${OWNER_DB_INDEX} i ON i.product_id=k.product_id
      AND i.territory='US' AND i.currency='USD'
    WHERE ${table} MATCH ?`,expression)[0]?.total;
  if(!Number.isSafeInteger(count)||count<0)throw Error('stage_production_fts_invalid_count');
  const term=input.query.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const compact=term.replace(/[\s-]/g,'');
  const rows=exec(sql,`SELECT i.product_id FROM ${table} f
    JOIN ${KEYS} k ON k.fts_rowid=f.rowid
    JOIN ${OWNER_DB_INDEX} i ON i.product_id=k.product_id
      AND i.territory='US' AND i.currency='USD'
    JOIN ${SOURCE} d ON d.product_id=i.product_id
    WHERE ${table} MATCH ?
    ORDER BY CASE WHEN lower(d.external_book_id)=? OR
       replace(d.isbn13,'-','')=? OR lower(d.title)=? THEN 0 ELSE 1 END,
       bm25(${table},0,14,11,12,10,8,4,14,4,3,1) ASC,
       i.rank_score DESC,i.product_id ASC LIMIT ? OFFSET ?`,
    expression,term,compact,term,input.limit,(input.page-1)*input.limit);
  return {count,pageIds:rows.map(x=>x.product_id),releaseCertified:false};
}

/**
 * Production-shaped *facet surface*, restricted to the five already-reviewed
 * stage dimensions and price. This still DOES NOT implement the full public
 * SearchInput (ratings, IDs, taxonomy, dates, additional sorts, etc.).
 * Every facet omits only its own selected values and retains FTS + all other
 * filters. No result is cached without owner epoch/legal expiry fencing.
 */
export function readStageProductionFtsFiltered(sql,input,legalIndexRead){
  const fields=['categories','languages','formats','publishers','series'];
  const allowed=new Set(['query','topic','territory','currency','language','page',
    'limit','sort',...fields,'minPrice','maxPrice']);
  if(!input||Object.keys(input).some(x=>!allowed.has(x))||
    typeof legalIndexRead!=='function'||input.territory!=='US'||input.currency!=='USD'||
    !['en','all'].includes(input.language)||input.sort!=='relevance'||
    !Number.isSafeInteger(input.page)||input.page<1||input.page>500||
    !Number.isSafeInteger(input.limit)||input.limit<1||input.limit>60)
    throw Error('stage_production_fts_unreviewed_scope');
  const filters={};
  for(const field of fields){
    const values=input[field]??[];
    if(!Array.isArray(values)||values.length>12||values.some(x=>
      typeof x!=='string'||x.length<1||x.length>160))
      throw Error('stage_production_fts_unreviewed_filters');
    filters[field]=[...new Set(values)].sort();
  }
  for(const key of ['minPrice','maxPrice'])if(input[key]!==undefined&&
    (!Number.isSafeInteger(input[key])||input[key]<0||input[key]>1000000000))
    throw Error('stage_production_fts_unreviewed_filters');
  if(input.minPrice!==undefined&&input.maxPrice!==undefined&&input.minPrice>input.maxPrice)
    throw Error('stage_production_fts_unreviewed_filters');
  const legal=legalIndexRead();
  if(!legal||legal.releaseCertified!==false||!Number.isSafeInteger(legal.count))
    throw Error('stage_production_fts_authority_missing');
  if(!exec(sql,`SELECT 1 FROM ${READY} WHERE id=1 AND ready=1`).length)
    throw Error('stage_production_fts_unsealed');
  if(legal.count===0)return {count:0,pageIds:[],facets:{
    categories:[],languages:[],formats:[],publishers:[],series:[],
    availability:[],price:null},releaseCertified:false};
  const expression=productionFtsExpression(input.query,input.topic||'');
  if(!expression)throw Error('stage_production_fts_empty_query_requires_default_index');
  const table=input.language==='en'?EN:FTS;
  const base=`FROM ${table} f
    JOIN ${KEYS} k ON k.fts_rowid=f.rowid
    JOIN ${OWNER_DB_INDEX} i ON i.product_id=k.product_id
      AND i.territory='US' AND i.currency='USD'
    JOIN ${SOURCE} d ON d.product_id=i.product_id`;
  const where=(omit)=>{
    const clauses=[`${table} MATCH ?`];
    const params=[expression];
    for(const field of fields){
      const vals=filters[field];
      if(!vals.length||omit===field)continue;
      clauses.push(`EXISTS(SELECT 1 FROM cove_stage_owner_index_dimensions dim
        WHERE dim.product_id=i.product_id AND dim.territory=i.territory
          AND dim.currency=i.currency AND dim.kind=?
          AND dim.value IN (${vals.map(()=>'?').join(',')}))`);
      params.push(field,...vals);
    }
    if(omit!=='price')for(const [key,op] of [['minPrice','>='],['maxPrice','<=']]){
      if(input[key]!==undefined){clauses.push(`i.price_minor${op}?`);params.push(input[key]);}
    }
    return {sql:' WHERE '+clauses.join(' AND '),params};
  };
  const filtered=where();
  const count=exec(sql,`SELECT COUNT(*) total ${base}${filtered.sql}`,
    ...filtered.params)[0]?.total;
  if(!Number.isSafeInteger(count)||count<0)
    throw Error('stage_production_fts_invalid_count');
  const rawQuery=input.query.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const compact=rawQuery.replace(/[\s-]/g,'');
  const pageIds=exec(sql,`SELECT i.product_id ${base}${filtered.sql}
    ORDER BY CASE WHEN lower(d.external_book_id)=? OR
      replace(d.isbn13,'-','')=? OR lower(d.title)=? THEN 0 ELSE 1 END ASC,
      bm25(${table},0,14,11,12,10,8,4,14,4,3,1) ASC,
      i.rank_score DESC,i.product_id ASC LIMIT ? OFFSET ?`,
    ...filtered.params,rawQuery,compact,rawQuery,input.limit,
    (input.page-1)*input.limit).map(x=>x.product_id);
  const caps={categories:40,languages:30,formats:20,publishers:30,series:30};
  const facets={};
  for(const field of fields){
    const subset=where(field);
    facets[field]=exec(sql,`SELECT dim.value value,
      COUNT(DISTINCT i.product_id) amount ${base}
      JOIN cove_stage_owner_index_dimensions dim ON
        dim.product_id=i.product_id AND dim.territory=i.territory
        AND dim.currency=i.currency AND dim.kind=?
      ${subset.sql} GROUP BY dim.value
      ORDER BY amount DESC,dim.value ASC LIMIT ?`,
      field,...subset.params,caps[field]).map(x=>({value:x.value,count:x.amount}));
  }
  const p=where('price');
  const prices=exec(sql,`SELECT MIN(i.price_minor) low,MAX(i.price_minor) high
    ${base}${p.sql}`,...p.params)[0];
  return {count,pageIds,facets:{...facets,
    availability:count?[{value:'available',count}]:[],
    price:prices?.low==null||prices.high==null?null:{currency:'USD',
      min:prices.low,max:prices.high}},releaseCertified:false};
}