/* eslint-disable prettier/prettier -- Protected, bounded live canonical legal audit. */
/**
 * PRODUCTION READ-ONLY SPOT AUDIT, NOT A RIGHTS WRITER OR RELEASE TEST.
 * Only a protected/manual workflow_dispatch with a D1-READ credential can
 * execute live. Every SQL statement must be a single SELECT or WITH, all
 * D1 response metadata must report zero mutations, and no SQL/results/IDs/
 * book/contract texts/token values are logged. At most eight products and
 * 400 bounded D1 SELECT requests. No writes, owner flag, Stripe, routing,
 * publishing, payments, offline entitlements or other customer operations.
 *
 * This deliberately cannot certify the 82,247-product full corpus: paged
 * reads are not an atomic snapshot and the view can be stricter or weaker
 * than the canonical rights resolver for untested contract variants.
 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const ACCOUNT='d26430caa63ec55f6612e32f36aca5e9';
const PRODUCTION_DB='4bd657ac-8789-403e-a28c-93aba8d0a989';
const BRANCH='refs/heads/audit/stage-real-catalog-metadata-readonly-20261115';
const DB_API='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+
  '/d1/database/'+PRODUCTION_DB+'/query';
const MAX_PRODUCTS=8,MAX_QUERIES=400;
const ISOLATED_ONLY=false;
const CONTRACT_PRODUCT_SQL=`SELECT DISTINCT p.id product_id FROM products p
 JOIN rights_grants rg ON rg.edition_id=p.edition_id
 WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
 ORDER BY p.id LIMIT 4`;
const CATALOG_PRODUCT_SQL=`SELECT p.id product_id FROM products p
 WHERE p.storefront_status='active' AND p.source_name<>'upload'
   AND p.id NOT LIKE 'perf-synth-%'
 ORDER BY p.id LIMIT 8`;
const VIEW_SQL=`SELECT EXISTS(SELECT 1 FROM retail_product_availability_rows a
  WHERE a.product_id=? AND a.territory_code='US') AS permitted`;
const WATERMARK_SQL=`SELECT
 (SELECT MAX(updated_at) FROM products) product_watermark,
 (SELECT MAX(updated_at) FROM editions) edition_watermark,
 (SELECT MAX(updated_at) FROM catalog_search_documents) search_watermark`;

function allowedReadSql(value){
  return typeof value==='string'&&/^(?:SELECT|WITH)\b/i.test(value.trim())&&
    !value.includes(';')&&
    !/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM|LOAD_EXTENSION)\b/i.test(value);
}
function allowedParams(params){
  return Array.isArray(params)&&params.length<=24&&params.every(x=>
    x===null||typeof x==='string'&&x.length<=160||
    typeof x==='number'&&Number.isSafeInteger(x));
}
function assertLivePermission(){
  if(process.argv.length!==3||process.argv[2]!=='--live'||
    process.env.COVE_PRODUCTION_LEGAL_AUDIT_ONLY!=='1'||
    process.env.CF_ACCOUNT_ID!==ACCOUNT||
    process.env.COVE_PRODUCTION_D1_ID!==PRODUCTION_DB||
    process.env.GITHUB_ACTIONS!=='true'||
    process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    process.env.GITHUB_REF!==BRANCH||
    typeof process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN!=='string'||
    process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN.length<20)
    throw Error('rights_spot_audit_protected_permission_required');
}
async function main(){
  if(process.argv.includes('--self-test')){
    assert.equal(allowedReadSql(CONTRACT_PRODUCT_SQL),true);
    assert.equal(allowedReadSql(VIEW_SQL),true);
    assert.equal(allowedReadSql('SELECT 1;DELETE FROM products'),false);
    assert.equal(allowedReadSql('SELECT load_extension(x)'),false);
    assert.equal(allowedReadSql('UPDATE rights_grants SET status=\'active\''),false);
    assert.equal(allowedReadSql('SELECT 1'),true);
    assert.equal(allowedParams(['test','US',24]),true);
    assert.equal(allowedParams([{}]),false);
    assert.throws(assertLivePermission,/protected_permission_required/);
    console.log('PASS: production spot audit denies unprotected runs, SQL mutations, dynamic execution and invalid params');
    return;
  }
  assertLivePermission();
  let queryCount=0;
  async function readSql(sql,params=[]){
    if(!allowedReadSql(sql)||!allowedParams(params))
      throw Error('rights_spot_audit_query_blocked');
    if(++queryCount>MAX_QUERIES)
      throw Error('rights_spot_audit_query_budget_exhausted');
    let response;
    try{
      response=await fetch(DB_API,{
        method:'POST',headers:{
          authorization:'Bearer '+process.env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN,
          'content-type':'application/json',
        },body:JSON.stringify({sql,params}),
        signal:AbortSignal.timeout(15000),
      });
    }catch{throw Error('rights_spot_audit_transport_failed');}
    if(!response.ok)throw Error('rights_spot_audit_http_'+response.status);
    let parsed;
    try{parsed=await response.json();}
    catch{throw Error('rights_spot_audit_bad_json');}
    const result=parsed?.result?.[0];
    if(parsed?.success!==true||!Array.isArray(parsed.result)||
      parsed.result.length!==1||!Array.isArray(result?.results)||
      result?.meta?.changed_db===true||Number(result?.meta?.changes||0)!==0)
      throw Error('rights_spot_audit_d1_invalid_or_write');
    return result.results;
  }
  const statement=(sql,params=[])=>({
    bind:(...values)=>statement(sql,values),
    first:async()=>(await readSql(sql,params))[0]??null,
    all:async()=>({results:await readSql(sql,params)}),
    run:async()=>{throw Error('rights_spot_audit_write_denied');},
  });
  const db={
    prepare:sql=>statement(sql),
    batch:async()=>{throw Error('rights_spot_audit_batch_denied');},
  };
  const scratch=mkdtempSync(path.join(tmpdir(),'cove-prod-legal-readonly-'));
  try{
    const bundle=path.join(scratch,'rights.mjs');
    await build({entryPoints:['src/features/fore/rights.server.ts'],
      outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
    const {resolveProductRights}=await import(pathToFileURL(bundle).href);
    assert.equal(typeof resolveProductRights,'function');
    const before=(await readSql(WATERMARK_SQL))[0];
    if(!before||['product_watermark','edition_watermark','search_watermark']
      .some(x=>typeof before[x]!=='string'))
      throw Error('rights_spot_audit_invalid_baseline');
    const cohorts=[
      {kind:'contract',rows:await readSql(CONTRACT_PRODUCT_SQL)},
      {kind:'catalog',rows:await readSql(CATALOG_PRODUCT_SQL)},
    ];
    const ids=new Set();
    const counts={contract:0,catalog:0};
    for(const {kind,rows} of cohorts){
      for(const row of rows){
        const id=String(row?.product_id||'');
        if(!/^[a-zA-Z0-9_:-]{1,128}$/.test(id)||id.startsWith('perf-synth-'))
          throw Error('rights_spot_audit_invalid_identifier');
        if(ids.size>=MAX_PRODUCTS)break;
        if(!ids.has(id)){ids.add(id);counts[kind]++;}
      }
    }
    if(ids.size<4||ids.size>MAX_PRODUCTS)
      throw Error('rights_spot_audit_insufficient_witnesses');
    const now=new Date().toISOString();
    let allowed=0,legacyAllowed=0,viewOnly=0,canonicalOnly=0;
    const reasons=Object.create(null);
    for(const id of ids){
      let verdict;
      try{
        verdict=await resolveProductRights(db,id,'US',{
          salesChannel:'retail',at:now,persist:false,
        });
      }catch{
        throw Error('rights_spot_audit_resolver_failed');
      }
      if(typeof verdict?.allowed!=='boolean')
        throw Error('rights_spot_audit_invalid_canonical_decision');
      const view=(await readSql(VIEW_SQL,[id]))[0];
      if(![0,1].includes(Number(view?.permitted)))
        throw Error('rights_spot_audit_invalid_legacy_view');
      const legacy=Number(view.permitted)===1;
      if(verdict.allowed)allowed++;
      else{
        const reason=String(verdict.reasonCode||'UNCLASSIFIED')
          .replace(/[^A-Z0-9_]/g,'').slice(0,48)||'UNCLASSIFIED';
        reasons[reason]=(reasons[reason]||0)+1;
      }
      if(legacy)legacyAllowed++;
      if(legacy&&!verdict.allowed)viewOnly++;
      if(verdict.allowed&&!legacy)canonicalOnly++;
    }
    const after=(await readSql(WATERMARK_SQL))[0];
    if(!after||Object.keys(before).some(k=>before[k]!==after[k]))
      throw Error('rights_spot_audit_source_changed');
    const out={schema:'cove.production.canonical-rights-spot-readonly.v1',
      checked:ids.size,cohortCounts:counts,canonicalAllowed:allowed,
      legacyAllowed,viewOnly,canonicalOnly,deniedReasons:reasons,
      D1Queries:queryCount,allRowsAtomicSnapshot:false,
      productionOwnerEvidenceCertified:false,
      fullCatalogRightsCertified:false,releaseCertified:false,
      wroteD1:false,hostedCapacityCertified:false};
    console.log(JSON.stringify({event:'cove_prod_rights_spot_audit',...out}));
    if(viewOnly||canonicalOnly)
      throw Error('rights_spot_audit_canonical_legacy_mismatch');
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
main().catch(error=>{
  const reason=String(error?.message||'');
  console.error(JSON.stringify({event:'cove_prod_rights_spot_audit_failed',
    reason:/^rights_spot_audit_[a-z_0-9]+$/.test(reason)?reason:'rights_spot_audit_failed',
    releaseCertified:false}));
  process.exitCode=1;
});
