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
const BRANCH='refs/heads/main';
const DB_API='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+
  '/d1/database/'+PRODUCTION_DB+'/query';
const MAX_PRODUCTS=8,MAX_QUERIES=400;
// Deliberately independent legal-policy cohorts, not merely the first
// contract-bound or bestselling products. Small fixed limits prevent a
// metadata scan or whole-catalog rights resolution from this audit.
const COHORTS=Object.freeze([
  // The real primary currently has grants but zero contracts/versions/language
  // policy rows. Sample actual allow/deny evidence and the vast Gutenberg
  // source FIRST; otherwise the audit can pass on all-denied metadata alone.
  {name:'active_grant_allow',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
      AND rg.status='active' AND rg.decision='allow'
    ORDER BY p.id LIMIT 2`},
  {name:'active_grant_deny',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
      AND rg.status='active' AND rg.decision='deny'
    ORDER BY p.id LIMIT 2`},
  {name:'gutenberg_free',limit:2,sql:`SELECT p.id product_id FROM products p
    WHERE p.storefront_status='active' AND p.source_name='gutenberg'
      AND p.id NOT LIKE 'perf-synth-%'
    ORDER BY p.id LIMIT 2`},
  {name:'contract_version',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    JOIN rights_contract_versions v ON v.contract_id=rg.contract_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
    ORDER BY p.id LIMIT 2`},
  {name:'contract_language',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    JOIN rights_contract_languages l ON l.contract_id=rg.contract_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
    ORDER BY p.id LIMIT 2`},
  {name:'nontrivial_drm',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
      AND lower(COALESCE(rg.drm_requirement,'')) NOT IN ('none','optional','any','')
    ORDER BY p.id LIMIT 2`},
  {name:'timed_rights',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
      AND (rg.starts_at IS NOT NULL OR rg.ends_at IS NOT NULL)
    ORDER BY p.id LIMIT 2`},
  {name:'contract_bound',limit:2,sql:`SELECT DISTINCT p.id product_id
    FROM products p JOIN rights_grants rg ON rg.edition_id=p.edition_id
    WHERE p.storefront_status='active' AND p.id NOT LIKE 'perf-synth-%'
      AND rg.contract_id IS NOT NULL
    ORDER BY p.id LIMIT 2`},
  {name:'catalog',limit:8,sql:`SELECT p.id product_id FROM products p
    WHERE p.storefront_status='active' AND p.source_name<>'upload'
      AND p.id NOT LIKE 'perf-synth-%'
    ORDER BY p.id LIMIT 8`},
]);
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
/**
 * A missing D1 mutation attestation is NOT equivalent to a zero-write result.
 * The Cloudflare API must explicitly report changed_db=false and changes=0.
 */
function verifiedD1ReadResult(parsed){
  const result=parsed?.result?.[0];
  const meta=result?.meta;
  if(parsed?.success!==true||!Array.isArray(parsed.result)||
    parsed.result.length!==1||!Array.isArray(result?.results)||
    !meta||meta.changed_db!==false||
    !Number.isSafeInteger(meta.changes)||meta.changes!==0)
    throw Error('rights_spot_audit_d1_invalid_or_write');
  return result.results;
}
function assertLivePermission(argv=process.argv,env=process.env){
  if(argv.length!==3||argv[2]!=='--live'||
    env.COVE_PRODUCTION_LEGAL_AUDIT_ONLY!=='1'||
    env.CF_ACCOUNT_ID!==ACCOUNT||
    env.COVE_PRODUCTION_D1_ID!==PRODUCTION_DB||
    env.GITHUB_ACTIONS!=='true'||
    env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    env.GITHUB_REF!==BRANCH)
    throw Error('rights_spot_audit_protected_permission_required');
  // A missing environment secret is a setup problem, NOT legal evidence.
  // Never substitute the broad CLOUDFLARE_API_TOKEN or permit anonymous runs.
  if(typeof env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN!=='string'||
    env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN.length<20)
    throw Error('rights_spot_audit_missing_read_token');
}
async function main(){
  if(process.argv.includes('--self-test')){
    for(const cohort of COHORTS){
      assert.equal(allowedReadSql(cohort.sql),true);
      assert.match(cohort.name,/^[a-z_]+$/);
      assert.ok(cohort.limit>=1&&cohort.limit<=MAX_PRODUCTS);
    }
    assert.equal(allowedReadSql(VIEW_SQL),true);
    assert.equal(allowedReadSql('SELECT 1;DELETE FROM products'),false);
    assert.equal(allowedReadSql('SELECT load_extension(x)'),false);
    assert.equal(allowedReadSql('UPDATE rights_grants SET status=\'active\''),false);
    assert.equal(allowedReadSql('SELECT 1'),true);
    assert.equal(allowedParams(['test','US',24]),true);
    assert.equal(allowedParams([{}]),false);
    const valid={success:true,result:[{results:[{n:1}],
      meta:{changed_db:false,changes:0}}]};
    assert.deepEqual(verifiedD1ReadResult(valid),[{n:1}]);
    for(const faulty of [
      {success:true,result:[{results:[],meta:{changes:0}}]},
      {success:true,result:[{results:[],meta:{changed_db:false}}]},
      {success:true,result:[{results:[],meta:{changed_db:true,changes:0}}]},
      {success:true,result:[{results:[],meta:{changed_db:false,changes:1}}]},
      {success:true,result:[{results:[],meta:{changed_db:false,changes:'0'}}]},
      {success:true,result:[]},
    ])assert.throws(()=>verifiedD1ReadResult(faulty),/d1_invalid_or_write/,
      'Missing or invalid D1 zero-write evidence must be rejected');
    assert.throws(assertLivePermission,/protected_permission_required/);
    const validContext={
      COVE_PRODUCTION_LEGAL_AUDIT_ONLY:'1',
      CF_ACCOUNT_ID:ACCOUNT,
      COVE_PRODUCTION_D1_ID:PRODUCTION_DB,
      GITHUB_ACTIONS:'true',
      GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_REF:BRANCH,
      COVE_CF_PRODUCTION_AUDIT_READ_TOKEN:'X'.repeat(32),
    };
    const liveArgv=['node','audit.mjs','--live'];
    assert.doesNotThrow(()=>assertLivePermission(liveArgv,validContext));
    assert.throws(()=>assertLivePermission(liveArgv,{
      ...validContext,COVE_CF_PRODUCTION_AUDIT_READ_TOKEN:'',
    }),/rights_spot_audit_missing_read_token/);
    assert.throws(()=>assertLivePermission(liveArgv,{
      ...validContext,COVE_CF_PRODUCTION_AUDIT_READ_TOKEN:'too-short',
    }),/rights_spot_audit_missing_read_token/);
    assert.throws(()=>assertLivePermission(liveArgv,{
      ...validContext,GITHUB_REF:'refs/heads/feature',
    }),/rights_spot_audit_protected_permission_required/);
    assert.throws(()=>assertLivePermission(liveArgv,{
      ...validContext,GITHUB_EVENT_NAME:'push',
    }),/rights_spot_audit_protected_permission_required/);
    console.log('PASS: production spot audit rejects missing read credential and unprotected invocation without weakening rights');
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
    return verifiedD1ReadResult(parsed);
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
    const ids=new Set();
    const cohortCounts=Object.create(null);
    for(const cohort of COHORTS){
      const rows=await readSql(cohort.sql);
      if(rows.length>cohort.limit)
        throw Error('rights_spot_audit_cohort_unbounded');
      let selected=0;
      for(const row of rows){
        const id=String(row?.product_id||'');
        if(!/^[a-zA-Z0-9_:-]{1,128}$/.test(id)||id.startsWith('perf-synth-'))
          throw Error('rights_spot_audit_invalid_identifier');
        if(ids.size>=MAX_PRODUCTS)break;
        if(!ids.has(id)){ids.add(id);selected++;}
      }
      cohortCounts[cohort.name]={candidates:rows.length,uniquelySelected:selected};
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
      checked:ids.size,cohortCounts,canonicalAllowed:allowed,
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
