/** Offline exact-schema FTS5 stage contract and revocation checks. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStageProductionFtsMirror,writeStageProductionSearchMetadata,
  sealStageProductionFtsMirror,readStageProductionFtsMirror,readStageProductionFtsFiltered,
  productionFtsExpression,PRODUCTION_FTS_SCHEMA} from '../../src/storefront-strangler/owner-production-fts-mirror.stage.mjs';

const db=new DatabaseSync(':memory:');
const exec=(query,...params)=>{const s=db.prepare(query);return {toArray:()=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)?s.all(...params):(s.run(...params),[])}};
const sql={exec};
const tx=fn=>{db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
const input=(query,language='all',topic='')=>({query,language,topic,territory:'US',currency:'USD',page:1,limit:24,sort:'relevance'});
const docs=[
  ['prd_owner_0','15','Café on the Hill','A book','Jane Écrivain','The Cove Cycle','Moon Press','9781234567890','Classic Fiction','nightfall stargazing','A lyrical story of travelers','fr',false],
  ['prd_owner_1','16','Running the Rivers','A novel','Mary Lane','Cove Cycle','Wind Press','9781234567891','Sports Fiction','running races','A running novel about rivers','en',false],
  ['prd_owner_2','17','The River Lane','volume three','Jane Écrivain','Cove Cycle','Wind Press','9781234567892','Classic Fiction','astronomy','Exploring the sky','en',false],
  ['prd_owner_3','18','Private Redacted','a secret','Hidden','Hidden','Hidden','9781234567893','Private','secretword','Not available','en',true],
  ['prd_owner_4','19','Unauthorized Voyage','','Hidden','Hidden','Hidden','9781234567894','Private','outofscope','Never authorized','en',false],
];
const make=(arr)=>({...Object.fromEntries(['product_id',...PRODUCTION_FTS_SCHEMA.searchableFields,'language_code','suppressed'].map((key,i)=>[key,arr[i]])),storefront_status:'active',source_name:'gutenberg',release_status:'available'});
try{
  db.exec(`CREATE TABLE cove_stage_owner_index_items(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    rank_score INTEGER NOT NULL, price_minor INTEGER NOT NULL,
    PRIMARY KEY(territory,currency,product_id)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE cove_stage_owner_index_dimensions(product_id TEXT NOT NULL,
    territory TEXT NOT NULL,currency TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,
    PRIMARY KEY(territory,currency,product_id,kind,value)) WITHOUT ROWID`);
  createStageProductionFtsMirror(sql);
  assert.equal(PRODUCTION_FTS_SCHEMA.searchableFields.length,10);
  assert.deepEqual(PRODUCTION_FTS_SCHEMA.bm25Weights,[0,14,11,12,10,8,4,14,4,3,1]);
  for(const [name,tokenizer] of [
    ['cove_stage_owner_prod_fts','unicode61 remove_diacritics 2'],
    ['cove_stage_owner_prod_fts_en','porter unicode61 remove_diacritics 2']]){
    const def=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;
    assert.ok(def.includes(tokenizer)&&def.includes("prefix='2 3 4'"),name+' tokenizer/prefix mismatch');
  }
  // Empty/missing metadata must fail sealing even when the table is empty.
  db.prepare('INSERT INTO cove_stage_owner_index_items VALUES(?,?,?,?,?)')
    .run(docs[0][0],'US','USD',100,0);
  assert.throws(()=>sealStageProductionFtsMirror(sql),/incomplete_migration/);
  db.prepare('DELETE FROM cove_stage_owner_index_items WHERE product_id=?').run(docs[0][0]);
  tx(()=>{
    for(const row of docs)writeStageProductionSearchMetadata(sql,make(row));
    for(let i=0;i<4;i++)db.prepare('INSERT INTO cove_stage_owner_index_items VALUES(?,?,?,?,?)')
      .run(docs[i][0],'US','USD',100-i,i===1?599:0);
    for(let i=0;i<4;i++){
      for(const [kind,value] of [
        ['categories',i===1?'Sports':'Classics'],
        ['languages',i===0?'fr':'en'],
        ['formats',i===1?'audio':'ebook'],
        ['publishers',i===0?'Moon Press':'Wind Press'],
        ['series','Cove Cycle'],
      ])db.prepare('INSERT INTO cove_stage_owner_index_dimensions VALUES(?,?,?,?,?)')
        .run(docs[i][0],'US','USD',kind,value);
    }
  });
  const counts=sealStageProductionFtsMirror(sql);
  assert.deepEqual([counts.expected,counts.global_count,counts.english_count],[3,3,2]);
  // Metadata eligibility must remain a second deny-first predicate, separate
  // from legal authorization: inactive, uploads and unreleased products vanish
  // from both FTS tables in the same transaction as their status transition.
  for(const [i,changes] of [
    [1,{source_name:'upload'}],[2,{storefront_status:'inactive'}],
    [0,{release_status:'draft'}],
  ]){
    tx(()=>writeStageProductionSearchMetadata(sql,{...make(docs[i]),...changes}));
    assert.equal(sealStageProductionFtsMirror(sql).global_count,2,
      'Product search eligibility cannot be mistaken for legal authority');
    tx(()=>writeStageProductionSearchMetadata(sql,make(docs[i])));
    assert.equal(sealStageProductionFtsMirror(sql).global_count,3);
  }
  tx(()=>writeStageProductionSearchMetadata(sql,{...make(docs[2]),release_status:'preorder'}));
  assert.equal(sealStageProductionFtsMirror(sql).global_count,3);
  tx(()=>writeStageProductionSearchMetadata(sql,make(docs[2])));
  const legalGate=()=>({releaseCertified:false,count:db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_index_items').get().n});
  const find=(q,l='all',topic='')=>readStageProductionFtsMirror(sql,input(q,l,topic),legalGate);
  assert.deepEqual(find('cafe').pageIds,[docs[0][0]],'Diacritics must match production global tokenizer');
  assert.deepEqual(find('run','en').pageIds,[docs[1][0]],'Porter English prefix must work');
  assert.deepEqual(find('9781234567890').pageIds,[docs[0][0]],'Exact ISBN should search isbn13 field');
  assert.deepEqual(find('15').pageIds,[docs[0][0]],'Numeric Gutenberg id routes external_book_id field');
  assert.deepEqual(new Set(find('écrivain').pageIds),new Set([docs[0][0],docs[2][0]]),'Author search field must be populated');
  assert.deepEqual(new Set(find('classic','all').pageIds),new Set([docs[0][0],docs[2][0]]),'Categories must be searchable');
  assert.deepEqual(new Set(find('river','en').pageIds),new Set([docs[1][0],docs[2][0]]),'English index should include only English');
  assert.deepEqual(find('secretword').pageIds,[],'Suppressed book cannot become searchable');
  assert.deepEqual(find('outofscope').pageIds,[],'Non-owner-authorized metadata cannot be indexed');
  const filtered=(parts)=>readStageProductionFtsFiltered(sql,{...input('fiction'),...parts},legalGate);
  const allFiction=filtered({categories:['Classics']});
  assert.equal(allFiction.count,2);
  assert.deepEqual(allFiction.facets.categories,[{value:'Classics',count:2},{value:'Sports',count:1}],
    'Category facet must ignore its own filter but retain keyword scope');
  assert.equal(allFiction.facets.availability[0].count,2);
  assert.equal(allFiction.facets.languages.reduce((n,x)=>n+x.count,0),2);
  assert.deepEqual(allFiction.facets.price,{currency:'USD',min:0,max:0},
    'Disjunctive price facet must retain all prices matching non-price filters');
  assert.equal(filtered({categories:['Classics'],maxPrice:0}).count,2);
  assert.equal(filtered({languages:['fr']}).count,1);
  assert.equal(filtered({languages:['en'],categories:['Classics']}).count,1);
  assert.equal(filtered({formats:['audio']}).count,1);
  assert.equal(filtered({minPrice:700}).count,0);
  assert.equal(filtered({categories:['Never']}).count,0);
  assert.throws(()=>filtered({contributorIds:['123']}),/unreviewed_scope/);

  assert.ok(productionFtsExpression('river').includes('*'));
  assert.match(productionFtsExpression('9781234567890'),/^isbn13 :/);
  assert.throws(()=>readStageProductionFtsMirror(sql,{...input('cafe'),sort:'popular'},legalGate),/unreviewed_scope/);
  // Stage-only owner legal denial: removal from canonical owner index MUST
  // remove all mirror FTS matches in the SAME transaction.
  tx(()=>db.prepare('DELETE FROM cove_stage_owner_index_items WHERE product_id=?')
    .run(docs[1][0]));
  assert.equal(find('running').count,0,'Revoked paid product must disappear from global FTS');
  assert.equal(filtered({formats:['audio']}).count,0);
  assert.equal(filtered({categories:['Classics']}).count,2);
  assert.equal(find('run','en').count,0,'Revoked paid product must disappear from English FTS');
  const after=sealStageProductionFtsMirror(sql);
  assert.deepEqual([after.global_count,after.english_count],[2,1]);
  // Owner-bound metadata update cannot grant: title changes are reflected
  // only when still authorized, and are cross-checked at seal.
  tx(()=>writeStageProductionSearchMetadata(sql,{...make(docs[0]),title:'A Different Valley'}));
  assert.equal(find('cafe').count,0);
  assert.equal(find('different').count,1);
  // Adversarial same-count FTS tamper must fail the migration seal.
  const row=db.prepare('SELECT fts_rowid FROM cove_stage_owner_prod_fts_keys WHERE product_id=?')
    .get(docs[0][0]).fts_rowid;
  db.prepare('UPDATE cove_stage_owner_prod_fts SET title=? WHERE rowid=?').run('tampered',row);
  assert.throws(()=>sealStageProductionFtsMirror(sql),/incomplete_migration/);
  assert.throws(()=>find('tampered'),/stage_production_fts_unsealed/,
    'Failed integrity seal must revoke previous ready state');
  tx(()=>writeStageProductionSearchMetadata(sql,{...make(docs[0]),title:'A Different Valley',keywords_text:'additional metadata'}));
  assert.throws(()=>find('different'),/stage_production_fts_unsealed/,
    'Metadata repair alone cannot bypass explicit seal');
  assert.doesNotThrow(()=>sealStageProductionFtsMirror(sql));
  console.log('PASS: production 10-field / two-tokenizer stage mirror, exact IDs and field matching, suppression, English, revocation and tamper fail-close');
}finally{db.close();}