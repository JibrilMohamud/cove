/* eslint-disable prettier/prettier -- Isolated read-only D1 stream contract and negative tests. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {
  PRODUCTION_ACCOUNT,PRODUCTION_DB,TEXT_FIELDS,REQUIRED_FIELDS,
  COVE_AUDIT_READ_SQL,createD1Reader,isOnlyReadSql,verifyProductionMetadata,
} from '../../src/storefront-strangler/production-catalog-metadata-readonly.stage.mjs';

const fixture=Array.from({length:9},(_,i)=>({
  product_id:'prd_stage_'+String(i+1).padStart(3,'0'),
  external_book_id:String(8000+i),title:i%2===0?'River Sciences':'Love and Rivers',
  subtitle:'Staged subtitle',contributors_text:'Stage Writer',
  series_text:'Example cycle',publisher_text:'Stage Publisher',
  isbn13:'97812345678'+String(i).padStart(2,'0'),
  categories_text:'Fiction',keywords_text:'science history',
  description:'A fictional river love story for testing',
  language_code:i%3===0?'fr':'en',suppressed:i===7?1:0,
  storefront_status:i===8?'inactive':'active',source_name:'gutenberg',
  release_status:i===6?'preorder':'available',currency:'USD',price_minor:0,
  updated_at:'2026-11-15T00:00:00Z',
}));
const meta=()=>({products:fixture.length,documents:fixture.length,
  suppressed:fixture.filter(x=>x.suppressed===1).length,
  english:fixture.filter(x=>x.suppressed===0&&x.language_code==='en').length,
  watermark:'2026-11-15T00:00:00Z',
  product_watermark:'2026-11-15T00:00:00Z',
  edition_watermark:'2026-11-15T00:00:00Z',
});
const db=new DatabaseSync(':memory:');
try{
  db.exec(`CREATE VIRTUAL TABLE fixture_global USING fts5(
    product_id UNINDEXED,${TEXT_FIELDS.join(',')},
    tokenize='unicode61 remove_diacritics 2',prefix='2 3 4')`);
  db.exec(`CREATE VIRTUAL TABLE fixture_english USING fts5(
    product_id UNINDEXED,${TEXT_FIELDS.join(',')},
    tokenize='porter unicode61 remove_diacritics 2',prefix='2 3 4')`);
  for(const lang of ['global','english']){
    const stmt=db.prepare(`INSERT INTO fixture_${lang} (product_id,${TEXT_FIELDS.join(',')})
      VALUES(${Array(11).fill('?').join(',')})`);
    for(const row of fixture){
      if(row.suppressed===1||lang==='english'&&row.language_code!=='en')continue;
      stmt.run(row.product_id,...TEXT_FIELDS.map(k=>row[k]));
    }
  }
  function mockReader({changed=false,drop=false,duplicate=false,invalidField=false,
    wrongFTS=false}={}){
    let metaReads=0;
    return async (sql,params=[])=>{
      if(!isOnlyReadSql(sql))throw Error('mock_write_blocked');
      if(sql===COVE_AUDIT_READ_SQL.META_SQL){
        metaReads++;
        return [{...meta(),edition_watermark:changed&&metaReads>1?'changed':meta().edition_watermark}];
      }
      if(sql===COVE_AUDIT_READ_SQL.PAGE_SQL){
        const [cursor,limit]=params;
        let rows=fixture.filter(x=>x.product_id>cursor).slice(0,Number(limit))
          .map(x=>({...x}));
        if(drop)rows=rows.filter(x=>x.product_id!=='prd_stage_003');
        if(duplicate&&rows.length>1)rows[1].product_id=rows[0].product_id;
        if(invalidField&&rows.length)delete rows[0].release_status;
        return rows;
      }
      for(const lang of ['global','english']){
        if(sql!==COVE_AUDIT_READ_SQL.REMOTE_FTS_SQL[lang])continue;
        const table=`fixture_${lang}`;
        const local=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${table} MATCH ?`)
          .get(params[0]).n;
        return [{n:local+(wrongFTS?1:0)}];
      }
      throw Error('unexpected_read_sql');
    };
  }
  const result=await verifyProductionMetadata({read:mockReader(),batchSize:3,
    phrases:['"river"','"love"','"history"']});
  assert.equal(result.documents,9);
  assert.equal(result.suppressed,1);
  assert.equal(result.englishFts,meta().english);
  assert.equal(result.globalFts,8);
  assert.equal(result.authorizedProducts,0);
  assert.equal(result.stageMetadataRows,9);
  assert.equal(result.stageAuthorizedFtsDocuments,0);
  assert.equal(result.productionOwnerEvidence,false);
  assert.equal(result.atomicPrimarySnapshot,false);
  assert.equal(result.releaseCertified,false);
  assert.equal(result.phraseChecks.length,6);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('River Sciences'),false,
    'No text metadata may leak into production audit report');
  for(const [negative,expected] of [
    [{changed:true},'catalog_readonly_source_changed_during_scan'],
    [{drop:true},'catalog_readonly_incomplete_population'],
    [{duplicate:true},'catalog_readonly_duplicate_or_unsorted'],
    [{invalidField:true},'catalog_readonly_missing_field'],
    [{wrongFTS:true},'catalog_readonly_fts_search_mismatch'],
  ]){
    await assert.rejects(()=>verifyProductionMetadata({read:mockReader(negative),
      batchSize:3,phrases:['"river"']}),new RegExp(expected),
    'Must reject unsafe read-only source: '+expected);
  }
  assert.equal(isOnlyReadSql('DELETE FROM catalog_search_documents'),false);
  assert.equal(isOnlyReadSql('SELECT * FROM products; DROP TABLE products'),false);
  assert.equal(isOnlyReadSql(COVE_AUDIT_READ_SQL.PAGE_SQL),true);
  assert.throws(()=>createD1Reader({token:'too short'}),/bad_credentials_or_target/);
  const calls=[];
  const mockFetch=async (url,options)=>{
    calls.push({url,method:options.method,query:JSON.parse(options.body)});
    return {ok:true,status:200,json:async()=>({success:true,result:[{results:[{n:1}]}]})};
  };
  const read=createD1Reader({accountId:PRODUCTION_ACCOUNT,databaseId:PRODUCTION_DB,
    token:'read-only-test-token-abc-123-very-long',fetchImpl:mockFetch});
  assert.deepEqual(await read(COVE_AUDIT_READ_SQL.REMOTE_FTS_SQL.global,['"river"']),[{n:1}]);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/4bd657ac-8789-403e-a28c-93aba8d0a989/);
  assert.equal(calls[0].method,'POST');
  assert.throws(()=>createD1Reader({token:'long-but-wrong-account-secret-xyz',
    accountId:'other'}),/bad_credentials_or_target/);
  await assert.rejects(()=>read('UPDATE products SET storefront_status=?',['active']),
    /nonread_query_blocked/);
  console.log('PASS: strict D1 Read-only stream, 9-row full FTS rebuild, exact query parity, source-drift/duplicate/incomplete/malformed/counterfeit fail-closed; 0 rights grants');
}finally{db.close();}