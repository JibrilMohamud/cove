/* eslint-disable prettier/prettier -- Stage-only canonical owner and production-shaped metadata integration proof. */
/**
 * Real owner-SQL functions + ten-field FTS metadata source, all in one
 * isolated Node SQLite transaction. Every row in this fixture is FAKE.
 * A metadata-only import must never issue a positive legal grant.
 * No production D1, routes, secret, Worker, money or entitlement I/O.
 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  PRODUCTION_FTS_SCHEMA,createStageProductionFtsMirror,
  writeStageProductionSearchMetadata,sealStageProductionFtsMirror,
  readStageProductionFtsMirror,readStageProductionFtsFiltered,
} from '../../src/storefront-strangler/owner-production-fts-mirror.stage.mjs';

const dir=mkdtempSync(path.join(tmpdir(),'cove-real-metadata-owner-boundary-'));
const db=new DatabaseSync(':memory:');
const sql={exec:(query,...args)=>{
  const statement=db.prepare(query);
  return {toArray:()=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)?
    statement.all(...args):(statement.run(...args),[])};
}};
const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const x=fn();db.exec('COMMIT');return x;}
  catch(e){db.exec('ROLLBACK');throw e;}};
const f1='prd_gutenberg_900000001',f2='prd_gutenberg_900000002';
const paid1='prd_stage_owner_001',paidHidden='prd_stage_owner_002';
const outsider='prd_gutenberg_900000099';
const ids=[f1,f2,paid1,paidHidden,outsider];
const meta=id=>({
  product_id:id,external_book_id:id.startsWith('prd_gutenberg_')?
    id.slice('prd_gutenberg_'.length):'stage'+id.slice(-3),
  title:({
    [f1]:'River at Dawn',[f2]:'Science of Astronomy',
    [paid1]:'River at Night',[paidHidden]:'Secret Suppressed River',
    [outsider]:'Unauthorized River Manual',
  })[id],subtitle:'A staged work',contributors_text:'Fixture Writer',
  series_text:'The Verified Series',publisher_text:'Stage Example Press',
  isbn13:'9781234567890',categories_text:'Fiction Science',
  keywords_text:id===f2?'astronomy science':'river astronomy',description:'Metadata alone is never a right',
  language_code:id===f2?'fr':'en',
  suppressed:id===paidHidden,
  storefront_status:'active',source_name:'gutenberg',release_status:'available',
});
const scope={territory:'US',currency:'USD',sort:'rank',page:1,limit:25};
const search=q=>({...scope,query:q,language:'all',sort:'relevance',limit:24});
try{
  await build({entryPoints:{
    free:'src/storefront-strangler/legal-authority-core.ts',
    commercial:'src/storefront-strangler/commercial-legal-core.ts',
    paid:'src/storefront-strangler/commercial-storefront-authority.ts',
    market:'src/storefront-strangler/market-authority-core.ts',
    catalog:'src/storefront-strangler/owner-catalog-authorized-set.stage.ts',
    incremental:'src/storefront-strangler/owner-catalog-incremental-index.stage.ts',
  },outdir:dir,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
  const load=async name=>import(pathToFileURL(path.join(dir,name+'.js')).href);
  const free=await load('free'),commercial=await load('commercial');
  const paid=await load('paid'),market=await load('market');
  const stage=await load('catalog'),idx=await load('incremental');

  for(const init of [free.createAuthoritySchema,free.createAuthorityProofSchema,
    commercial.createCommercialAuthoritySchema,paid.createCommercialStorefrontSchema,
    market.createMarketAuthoritySchema,stage.createStageOwnerCatalogSchema,
    idx.createStageOwnerIncrementalIndex,createStageProductionFtsMirror])
    init(sql);

  assert.equal(PRODUCTION_FTS_SCHEMA.searchableFields.length,10);
  tx(()=>{
    for(const id of ids){
      const row=meta(id);
      writeStageProductionSearchMetadata(sql,row);
      stage.stageStorePresentation(sql,{
        productId:id,title:row.title,format:id.startsWith('prd_stage_owner_')?'audio':'ebook',
        publisher:'Stage Example Press',rank:ids.length-ids.indexOf(id),
        categories:['Fiction'],languages:[row.language_code],series:['The Verified Series'],
      });
    }
  });
  assert.deepEqual(sealStageProductionFtsMirror(sql).global_count,0,
    'All five production-shaped metadata rows remain nonauthorized');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_index_items').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_prod_fts').get().n,0);

  // Only canonical legal authority commands may grant positive, stage-only
  // index membership. The imported search document never does.
  tx(()=>{
    for(const id of [f1,f2]){
      const sourceId=id.slice('prd_gutenberg_'.length);
      const command={sourceId,territory:'US',revision:1,action:'allow'};
      assert.equal(free.applyAuthorityCommand(sql,command).applied,true);
      free.storeAuthorizedPresentationProof(sql,command,'USD',{
        productId:id,editionId:'ed_gutenberg_'+sourceId,
        productPublicId:null,editionPublicId:null,
        offerJson:JSON.stringify({type:'public-domain',currency:'USD',amountMinor:0}),
      });
    }
    for(const [i,id] of [paid1,paidHidden].entries()){
      const suffix=String(i+1).padStart(3,'0');
      const until=new Date(Date.now()+3*60_000).toISOString();
      const proof={productId:id,editionId:'ed_stage_owner_'+suffix,
        territory:'US',channel:'retail',grantId:'grant_stage_owner_'+suffix,
        contractId:'contract_stage_owner_'+suffix,
        contractVersionId:'contract_version_stage_owner_'+suffix,validUntil:until};
      assert.equal(commercial.publishFreshCommercialProof(sql,proof,0).applied,true);
      paid.publishCommercialStorefront(sql,{
        product_id:id,edition_id:proof.editionId,product_public_id:null,
        edition_public_id:null,territory:'US',currency:'USD',rights_epoch:1,
        grant_id:proof.grantId,contract_id:proof.contractId,
        contract_version_id:proof.contractVersionId,
        offer_json:JSON.stringify({type:'retail',currency:'USD',amountMinor:599}),
        valid_until:until,
      });
    }
    idx.bootstrapStageOwnerIndex(sql);
  });
  const legalGate=()=>idx.readStageOwnerIncrementalIndex(sql,scope);
  const stageSearch=query=>readStageProductionFtsMirror(sql,search(query),legalGate);
  const ftsMetrics=sealStageProductionFtsMirror(sql);
  assert.equal(legalGate().count,4,'Only four genuinely owner-proven books allowed');
  assert.equal(ftsMetrics.global_count,3,'Owner-proven suppressed book not searchable');
  assert.equal(ftsMetrics.english_count,2,'English FTS checks owner and language');
  assert.deepEqual(stageSearch('river').pageIds.sort(),[f1,paid1].sort());
  assert.equal(stageSearch('unauthorized').count,0,
    'Real metadata-only outlier must never become a positive book');
  assert.equal(stageSearch('secret').count,0,'Owner-proven but suppressed book is hidden');
  const filter=readStageProductionFtsFiltered(sql,{...search('river'),
    categories:['Fiction'],maxPrice:599},legalGate);
  assert.equal(filter.count,2);
  assert.deepEqual(filter.facets.availability,[{value:'available',count:2}]);
  assert.equal(filter.facets.price.min,0);
  assert.equal(filter.facets.price.max,599);

  tx(()=>{
    const denial=commercial.denyCommercialSubject(sql,{
      subjectKind:'contract',subjectId:'contract_stage_owner_001',
      operationId:'stage:metadata-handoff:contract-deny-1'});
    assert.equal(denial.applied,true);
    idx.reconcileStageOwnerDirty(sql);
  });
  assert.equal(legalGate().count,3);
  assert.deepEqual(stageSearch('river').pageIds,[f1],
    'Canonical contract withdrawal must retire production-text FTS in owner transaction');
  assert.equal(sealStageProductionFtsMirror(sql).global_count,2);
  tx(()=>{
    const result=free.applyAuthorityCommand(sql,{
      sourceId:f1.slice('prd_gutenberg_'.length),territory:'*',revision:2,action:'deny'});
    assert.equal(result.applied,true);
    idx.reconcileStageOwnerDirty(sql);
  });
  assert.equal(legalGate().count,2);
  assert.equal(stageSearch('river').count,0,
    'Global free-source withdrawal must hide text, even if metadata still exists');
  assert.equal(sealStageProductionFtsMirror(sql).global_count,1);

  tx(()=>writeStageProductionSearchMetadata(sql,{...meta(paid1),
    keywords_text:'newer metadata cannot reinstate a withdrawn contract'}));
  assert.equal(stageSearch('newer').count,0,
    'Updating text metadata cannot resurrect a canonical legal denial');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cove_stage_owner_prod_search_source').get().n,5,
    'Production-shaped metadata remains intact without granting rights');
  assert.equal(legalGate().count,2);
  tx(()=>market.denyMarket(sql,{territory:'US',
    operationId:'stage:metadata-handoff:market-deny-1'}));
  assert.equal(legalGate().count,0,'Market denial is a synchronous owner-wide veto');
  assert.equal(stageSearch('science').count,0,'Market denial overrides indexed text');
  console.log(JSON.stringify({
    schema:'cove.stage.real-metadata-owner-join.v1',
    importedMetadataRows:5,realProductionMetadataRows:0,
    canonicalOwnerProofs:4,initialOwnerIndexed:4,initialSearchVisible:3,
    metadataOnlyGranted:0,suppressedOwnerVisibleInSearch:0,
    postContractOwnerIndexed:3,postSourceOwnerIndexed:2,postMarketOwnerIndexed:0,
    verifiedCanonicalFreeAndPaid:true,revokedTermsHidden:true,
    fullRealCatalogRightsCertified:false,hostedCloudflare:false,
    productionD1Written:false,releaseCertified:false,
  }));
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
