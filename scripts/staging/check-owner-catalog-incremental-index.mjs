/* eslint-disable prettier/prettier -- Stage-only source-contract proof for real legal SQL modules. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=mkdtempSync(path.join(tmpdir(),'cove-stage-catalog-owner-index-'));
const db=new DatabaseSync(':memory:');
const sql={exec:(query,...args)=>{
  const statement=db.prepare(query);
  const rows=/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)?statement.all(...args):(statement.run(...args),[]);
  return {toArray:()=>rows};
}};
const inTransaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const x=fn();db.exec('COMMIT');return x;}catch(e){db.exec('ROLLBACK');throw e;}};
try{
  await build({entryPoints:{
    free:'src/storefront-strangler/legal-authority-core.ts',
    commercial:'src/storefront-strangler/commercial-legal-core.ts',
    paid:'src/storefront-strangler/commercial-storefront-authority.ts',
    market:'src/storefront-strangler/market-authority-core.ts',
    catalog:'src/storefront-strangler/owner-catalog-authorized-set.stage.ts',
    incremental:'src/storefront-strangler/owner-catalog-incremental-index.stage.ts',
    fts:'src/storefront-strangler/owner-catalog-fts.stage.ts',
  },outdir:root,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
  const load=async name=>import(pathToFileURL(path.join(root,name+'.js')).href);
  const free=await load('free'),commercial=await load('commercial');
  const paid=await load('paid'),market=await load('market');
  const stage=await load('catalog'),idx=await load('incremental');
  const fts=await load('fts');
  free.createAuthoritySchema(sql);free.createAuthorityProofSchema(sql);
  commercial.createCommercialAuthoritySchema(sql);
  paid.createCommercialStorefrontSchema(sql);market.createMarketAuthoritySchema(sql);
  stage.createStageOwnerCatalogSchema(sql);
  stage.createStageOwnerCatalogSnapshotSchema(sql);
  idx.createStageOwnerIncrementalIndex(sql);
  assert.doesNotMatch(stage.STAGE_OWNER_CATALOG_SQL,/retail_product_availability_rows|PRIMARY_DB|FROM offers|FROM rights_grants/);
  const scope={territory:'US',currency:'USD',page:1,limit:24,sort:'rank'};
  const freeIds=Array.from({length:12},(_,i)=>'prd_gutenberg_'+(900000001+i));
  const paidIds=Array.from({length:13},(_,i)=>'prd_stage_owner_'+String(i+1).padStart(3,'0'));
  const all=[...freeIds,...paidIds];
  inTransaction(()=>{
    for(const [i,id] of all.entries()){
      stage.stageStorePresentation(sql,{
        productId:id,title:'Fake catalog '+i,format:i%3===0?'ebook':'audio',
        publisher:i%2===0?'Stage Publishing A':'Stage Publishing B',rank:1000-i,
        categories:i<5?['Fiction','Classics']:['Fiction'],
        languages:i%2===0?['en']:['fr'],series:i<2?['Stage Series']:[],
      });
    }
    for(const id of freeIds){
      const sourceId=id.slice('prd_gutenberg_'.length);
      const command={sourceId,territory:'US',revision:1,action:'allow'};
      assert.equal(free.applyAuthorityCommand(sql,command).applied,true);
      free.storeAuthorizedPresentationProof(sql,command,'USD',{
        productId:id,editionId:'ed_gutenberg_'+sourceId,
        productPublicId:null,editionPublicId:null,
        offerJson:JSON.stringify({type:'public-domain',currency:'USD',amountMinor:0}),
      });
    }
    for(const [i,id] of paidIds.entries()){
      const suffix=String(i+1).padStart(3,'0');
      const proof={productId:id,editionId:'ed_stage_owner_'+suffix,
        territory:'US',channel:'retail',grantId:'grant_stage_owner_'+suffix,
        contractId:'contract_stage_owner_'+suffix,
        contractVersionId:'version_stage_owner_'+suffix,
        validUntil:new Date(Date.now()+4*60_000).toISOString()};
      const receipt=commercial.publishFreshCommercialProof(sql,proof,0);
      assert.equal(receipt.applied,true);assert.equal(receipt.epoch,1);
      paid.publishCommercialStorefront(sql,{
        product_id:id,edition_id:proof.editionId,
        product_public_id:null,edition_public_id:null,territory:'US',currency:'USD',
        rights_epoch:1,grant_id:proof.grantId,contract_id:proof.contractId,
        contract_version_id:proof.contractVersionId,
        offer_json:JSON.stringify({type:'retail',currency:'USD',amountMinor:599}),
        valid_until:proof.validUntil,
      });
    }
  });
  const direct=stage.stageOwnerCatalogRead(sql,scope);
  assert.equal(direct.count,25);
  assert.deepEqual(direct.pageIds,all.slice(0,24));
  assert.equal(direct.facets.price?.min,0);
  assert.equal(direct.facets.price?.max,599);
  assert.deepEqual(direct.facets.categories,[
    {value:'Fiction',count:25},{value:'Classics',count:5},
  ]);
  assert.equal(direct.facets.availability[0].count,25);
  assert.equal(stage.stageOwnerCatalogRead(sql,{...scope,page:2,limit:10}).pageIds.length,10);
  assert.equal(stage.stageOwnerCatalogRead(sql,{...scope,page:3,limit:10}).pageIds.length,5);
  assert.deepEqual(free.readAuthorizedPresentations(sql,freeIds,'US','USD').map(x=>x.product_id),freeIds);
  assert.deepEqual(paid.readCommercialStorefront(sql,paidIds,'US','USD').map(x=>x.product_id),paidIds);

  assert.throws(()=>stage.readStageOwnerCatalogSnapshot(sql,scope),/unavailable_or_revoked/);
  inTransaction(()=>stage.rebuildStageOwnerCatalogSnapshot(sql));
  inTransaction(()=>idx.bootstrapStageOwnerIndex(sql));
  const firstIndexed=idx.readStageOwnerIncrementalIndex(sql,scope);
  assert.deepEqual(firstIndexed,direct,'Indexed 25-book exact page/count/facets parity');
  assert.equal(idx.readStageOwnerIncrementalIndex(sql,{...scope,page:2,limit:10}).pageIds.length,10);
  assert.equal(idx.readStageOwnerIncrementalIndex(sql,{...scope,page:3,limit:10}).pageIds.length,5);
  // Independent reference: acquire authorized IDs from actual owner SQL,
  // then recompute each disjunctive facet using raw canonical fixture data.
  function filteredGold(input){
    const ids=stage.stageOwnerCatalogRead(sql,{...scope,page:1,limit:25}).pageIds;
    const books=ids.map(id=>{
      const meta=db.prepare('SELECT title,rank_score,format,publisher FROM cove_stage_owner_catalog WHERE product_id=?').get(id);
      const tags={};
      for(const [facet,table] of [['categories','category'],['languages','language'],['series','series']]){
        tags[facet]=db.prepare(`SELECT value FROM cove_stage_owner_catalog_${table} WHERE product_id=?`)
          .all(id).map(r=>r.value);
      }
      tags.formats=[meta.format];tags.publishers=[meta.publisher];
      const proof=db.prepare(id.startsWith('prd_gutenberg_')?
        `SELECT offer_json FROM cove_authorized_offer_proofs WHERE product_id=? AND territory='US' AND currency='USD'`:
        `SELECT offer_json FROM cove_commercial_storefront_proofs WHERE product_id=? AND territory='US' AND currency='USD'`).get(id);
      return {id,tags,rank:meta.rank_score,price:JSON.parse(proof.offer_json).amountMinor,
        words:new Set([meta.title,meta.format,meta.publisher].join(' ').toLowerCase()
          .split(/[^a-z0-9]+/).filter(Boolean))};
    });
    const facets=['categories','languages','formats','publishers','series'];
    const queryWords=String(input.query||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const selected=(book,omit)=>queryWords.every(term=>book.words.has(term))&&
      facets.every(f=>f===omit||!input[f]?.length||
      input[f].some(x=>book.tags[f].includes(x)))&&
      (omit==='price'||(
        (input.minPrice===undefined||book.price>=input.minPrice)&&
        (input.maxPrice===undefined||book.price<=input.maxPrice)));
    const matches=books.filter(b=>selected(b));
    const distribution=(kind)=>{
      const counter=new Map();
      for(const book of books.filter(b=>selected(b,kind))){
        for(const value of new Set(book.tags[kind]))counter.set(value,(counter.get(value)||0)+1);
      }
      const cap={categories:40,languages:30,formats:20,publishers:30,series:30}[kind];
      return [...counter].map(([value,count])=>({value,count}))
        .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value)).slice(0,cap);
    };
    const prices=books.filter(b=>selected(b,'price')).map(x=>x.price);
    return {count:matches.length,pageIds:matches.slice((input.page-1)*input.limit,input.page*input.limit)
      .map(x=>x.id),facets:{
      ...Object.fromEntries(facets.map(f=>[f,distribution(f)])),
      availability:matches.length?[{value:'available',count:matches.length}]:[],
      price:prices.length?{currency:'USD',min:Math.min(...prices),max:Math.max(...prices)}:null,
    },releaseCertified:false};
  }
  const filterSamples=[
    {categories:['Fiction']},
    {categories:['Classics']},
    {categories:['Missing']},
    {categories:['Classics'],languages:['en','fr']},
    {languages:['en'],formats:['ebook']},
    {formats:['audio'],publishers:['Stage Publishing A']},
    {series:['Stage Series']},
    {minPrice:500},
    {maxPrice:0},
    {minPrice:0,maxPrice:599},
    {categories:['Classics'],minPrice:500},
    {categories:['Classics'],minPrice:600},
    {formats:['audio','ebook'],series:['Stage Series'],page:2,limit:1},
    {query:'fake'},
    {query:'FAKE CATALOG'},
    {query:'ebook'},
    {query:'audio',publishers:['Stage Publishing A']},
    {query:'12'},
    {query:'13',minPrice:500},
    {query:'fake 0'},
    {query:'notfound'},
    {query:'stage publishing b',categories:['Classics']},
    {query:'audio',page:2,limit:3},
    {query:'ebook',maxPrice:0,languages:['en']},
  ];
  for(const part of filterSamples){
    const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input),
      'Every filtered count/page and self-excluding facet must match independent owner SQL');
  }
  const ftsDocs=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_fts').get().n;
  assert.equal(ftsDocs,25,'FTS must index every owner-authorized catalog row');
  assert.equal(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'12'}).count,1);
  assert.equal(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'0'}).count,1);
  assert.throws(()=>idx.readStageOwnerFilteredIndex(sql,{...scope,query:'" OR 1=1'}),
    /stage_owner_fts_invalid_query/,'Reject raw FTS operators and unsafe grammar');
  assert.throws(()=>idx.readStageOwnerFilteredIndex(sql,{...scope,query:' '}),
    /stage_owner_fts_invalid_query/);
  const ftsPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT product_id
    FROM cove_stage_owner_fts WHERE cove_stage_owner_fts MATCH ?`).all('"ebook"');
  assert.ok(ftsPlan.some(x=>/VIRTUAL TABLE INDEX/i.test(String(x.detail))),
    'Keyword lookups must use FTS5, not full table scans');
  // FTS-vocabulary planner must never change authorization or page order.
  // One title term is rare here, so SQLite should drive FROM FTS matches
  // rather than scan ranked rows until it finds the target book.
  assert.equal(fts.stageOwnerFtsPreferMatchesFirst(sql,'"12"'),true);
  assert.equal(fts.stageOwnerFtsPreferMatchesFirst(sql,'"missing-term"'),true);
  assert.equal(fts.stageOwnerFtsPreferMatchesFirst(sql,''),false);
  const narrowPlan=db.prepare(`EXPLAIN QUERY PLAN WITH matched AS MATERIALIZED (
    SELECT product_id FROM cove_stage_owner_fts WHERE cove_stage_owner_fts MATCH ?
  ) SELECT i.product_id FROM matched m CROSS JOIN cove_stage_owner_index_items i
    WHERE i.product_id=m.product_id AND i.territory='US' AND i.currency='USD'
    ORDER BY i.rank_score DESC,i.product_id ASC LIMIT 24`).all('"12"');
  assert.ok(narrowPlan.some(x=>String(x.detail).includes('SEARCH i USING PRIMARY KEY')),
    'Match-first plan should resolve products using primary-key point lookups');
  assert.ok(narrowPlan.some(x=>String(x.detail).includes('SCAN m')),
    'CROSS JOIN must keep match-set as outer loop');
  assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'12'}),
    filteredGold({...scope,query:'12'}),
    'The FTS-first page plan cannot alter facet/count/pagination semantics');
  const firstQueryCache=db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_index_query_cache').get().n;
  assert.ok(firstQueryCache>0,'Filtered query materialization must happen in owner SQLite');
  const firstEpoch=db.prepare('SELECT epoch FROM cove_stage_owner_index_epoch WHERE id=1').get().epoch;
  for(const part of filterSamples){
    const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input),
      'Cached query must return exact verified disjunctive facets');
  }
  const rankPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT product_id FROM cove_stage_owner_index_items
    WHERE territory='US' AND currency='USD'
    ORDER BY rank_score DESC,product_id LIMIT 24`).all();
  assert.ok(rankPlan.some(x=>String(x.detail).includes('cove_stage_owner_index_rank')),
    'Rank hot reads must use owner index, not 82k-row sort');
  const cached=stage.readStageOwnerCatalogSnapshot(sql,scope);
  assert.deepEqual(cached,direct);
  assert.equal(cached.releaseCertified,false);
  // Hot read must be a one-row owner-generation lookup, not a legal-view scan.
  const hotPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT s.body FROM cove_stage_catalog_snapshot s
    JOIN cove_stage_catalog_generation g ON g.id=1
    WHERE s.territory=? AND s.currency=? AND s.generation=g.generation
      AND s.expires_at>?`).all('US','USD',new Date().toISOString());
  assert.ok(hotPlan.some(p=>String(p.detail).includes('PRIMARY KEY')));
  for(let i=0;i<250;i++){
    assert.equal(stage.readStageOwnerCatalogSnapshot(sql,scope).count,25);
    assert.equal(idx.readStageOwnerIncrementalIndex(sql,scope).count,25);
  }

  // Fresh unverified presentation rows never become rights grants.
  inTransaction(()=>stage.stageStorePresentation(sql,{productId:'prd_gutenberg_999999999',
    title:'Unauthorized display only',format:'ebook',publisher:'Unknown',rank:9999,
    categories:['Fiction'],languages:['en'],series:[]}));
  assert.throws(()=>stage.readStageOwnerCatalogSnapshot(sql,scope),/unavailable_or_revoked/,
    'Unreviewed metadata mutation invalidates every cached positive');
  assert.equal(stage.stageOwnerCatalogRead(sql,scope).count,25);
  assert.throws(()=>idx.readStageOwnerIncrementalIndex(sql,scope),/dirty_unreconciled/,
    'Unreviewed metadata must invalidate index before authorization is confirmed');
  inTransaction(()=>{idx.reconcileStageOwnerDirty(sql);stage.rebuildStageOwnerCatalogSnapshot(sql);});
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope),stage.stageOwnerCatalogRead(sql,scope));
  assert.equal(stage.readStageOwnerCatalogSnapshot(sql,scope).count,25);

  inTransaction(()=>{
    const receipt=commercial.denyCommercialSubject(sql,{
      subjectKind:'contract',subjectId:'contract_stage_owner_001',
      operationId:'stage:catalog:contract-deny:1'});
    assert.equal(receipt.applied,true);
    idx.reconcileStageOwnerDirty(sql);
    stage.rebuildStageOwnerCatalogSnapshot(sql);
  });
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope),stage.stageOwnerCatalogRead(sql,scope));
  for(const part of filterSamples){const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input));}
  assert.ok(db.prepare('SELECT epoch FROM cove_stage_owner_index_epoch WHERE id=1').get().epoch>firstEpoch,
    'Contract withdrawal must transactionally invalidate all cached filtered scopes');
  assert.equal(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'12'}).count,0,
    'Revoked contract keyword must be removed from FTS in owner transaction');
  assert.equal(stage.readStageOwnerCatalogSnapshot(sql,scope).count,24);
  assert.ok(!stage.readStageOwnerCatalogSnapshot(sql,scope).pageIds.includes(paidIds[0]));
  assert.equal(paid.readCommercialStorefront(sql,paidIds,'US','USD').length,12);

  inTransaction(()=>{
    assert.equal(free.applyAuthorityCommand(sql,{
      sourceId:freeIds[0].slice('prd_gutenberg_'.length),territory:'*',revision:2,action:'deny',
    }).applied,true);
    idx.reconcileStageOwnerDirty(sql);
    stage.rebuildStageOwnerCatalogSnapshot(sql);
  });
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope),stage.stageOwnerCatalogRead(sql,scope));
  for(const part of filterSamples){const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input));}
  assert.equal(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'0'}).count,0,
    'Revoked free source cannot remain searchable');
  assert.equal(stage.readStageOwnerCatalogSnapshot(sql,scope).count,23);
  assert.equal(free.readAuthorizedPresentations(sql,freeIds,'US','USD').length,11);

  // Time-based expiry must never leave a still-visible paid book in an
  // otherwise cached query. Shorten an EXISTING verified test lease (not a
  // positive regrant), then let clock time cross its canonical deadline.
  const expiring=paidIds[1],shortLease=new Date(Date.now()+2200).toISOString();
  inTransaction(()=>{
    sql.exec(`UPDATE cove_commercial_scope_proofs SET valid_until=?
      WHERE product_id=? AND territory='US' AND channel='retail'`,shortLease,expiring);
    sql.exec(`UPDATE cove_commercial_storefront_proofs SET valid_until=?
      WHERE product_id=? AND territory='US' AND currency='USD'`,shortLease,expiring);
    idx.reconcileStageOwnerDirty(sql);
    stage.rebuildStageOwnerCatalogSnapshot(sql);
  });
  assert.equal(idx.readStageOwnerIncrementalIndex(sql,scope).count,23);
  await new Promise(resolve=>setTimeout(resolve,2400));
  assert.throws(()=>idx.readStageOwnerIncrementalIndex(sql,scope),/expired_unreconciled/,
    'Past canonical lease deadline MUST block stale indexed count and page');
  assert.throws(()=>idx.readStageOwnerFilteredIndex(sql,{...scope,categories:['Fiction']}),
    /expired_unreconciled/,'The filtered query cache also cannot bypass expiry');
  inTransaction(()=>{
    const swept=idx.refreshStageOwnerExpired(sql);
    assert.equal(swept.processed,1,'Only genuinely expired owner-local lease is reconciled');
    assert.equal(swept.remaining,0);
    // The OLD full snapshot is known to fail publication after ANY expired
    // stored paid lease. This incremental index deliberately avoids that
    // global expiry lock; keep the old snapshot unavailable, not falsified.
  });
  assert.equal(idx.readStageOwnerIncrementalIndex(sql,scope).count,22);
  assert.equal(idx.readStageOwnerFilteredIndex(sql,{...scope,query:'13'}).count,0,
    'Expired paid proof must leave FTS and its cache after owner refresh');
  assert.ok(!idx.readStageOwnerIncrementalIndex(sql,scope).pageIds.includes(expiring));
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope),
    stage.stageOwnerCatalogRead(sql,scope),'Expiry rebuild must equal canonical owner SQL');
  for(const part of filterSamples){
    const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input),
      'Expired paid offers must disappear from every filtered count and facet');
  }
  assert.throws(()=>stage.readStageOwnerCatalogSnapshot(sql,scope),
    /unavailable_or_revoked/,'Expired prior snapshot must remain fail-closed');
  assert.equal(paid.readCommercialStorefront(sql,paidIds,'US','USD').length,11);

  inTransaction(()=>{
    market.denyMarket(sql,{territory:'US',operationId:'stage:catalog:market-deny:1'});
    // Old snapshot rebuild is intentionally broken by the stale paid proof;
    // market veto in the incremental owner index must still return zero.
  });
  assert.throws(()=>stage.readStageOwnerCatalogSnapshot(sql,scope),/unavailable_or_revoked/);
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope),stage.stageOwnerCatalogRead(sql,scope));
  for(const part of filterSamples){const input={...scope,...part};
    assert.deepEqual(idx.readStageOwnerFilteredIndex(sql,input),filteredGold(input));}
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope).pageIds,[]);
  assert.deepEqual(idx.readStageOwnerIncrementalIndex(sql,scope).facets.availability,[]);
  for(const invalid of [
    {...scope,page:2},{...scope,limit:10},{...scope,query:'war'},
    {...scope,sort:'popular'},{...scope,territory:'GB'},
    {...scope,filter:'category'},
  ]) assert.throws(()=>stage.readStageOwnerCatalogSnapshot(sql,invalid),/unreviewed_scope/);
  assert.throws(()=>stage.stageOwnerCatalogRead(sql,{...scope,query:'war'}),/unsupported_scope/);
  for(const bad of [{...scope,query:'War'},{...scope,sort:'popular'},{...scope,filter:'category'}])
    assert.throws(()=>idx.readStageOwnerIncrementalIndex(sql,bad),/unreviewed_scope/);
  console.log('PASS: owner-transactional FTS5 keyword matching and '+filterSamples.length+
    ' filtered+keyword cases, expiry/contract/source/market withdrawal, disjunctive facets');
  console.log('PASS: owner-index exact default count/facets/page 25/24/23/22/0; 250 indexed hot reads, source/contract/market denial, dirty fail-close, disallowed scopes rejected');
}finally{
  db.close();rmSync(root,{recursive:true,force:true});
}