/* eslint-disable prettier/prettier -- Protected release audit fixtures. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspectPrimaryD1Writers,requireProtectedInvocation,createReadOnlyCloudflareClient,OWNER_WORKER,PRIMARY_D1_ID} from './audit-production-primary-d1-writers.mjs';
const modified_on='2026-11-16T00:00:00Z';
const workers=[{id:OWNER_WORKER,modified_on},{id:'cove-persistence-backend',modified_on}];
const owner=[
  {name:'PRIMARY_DB',type:'d1',id:PRIMARY_D1_ID},
  {name:'COVE_RIGHTS_OWNER_ENABLED',type:'plain_text',text:'1'},
  {name:'COVE_RIGHTS_OWNER_PRIMARY_ID',type:'plain_text',text:PRIMARY_D1_ID}
];
const backend=[{name:'DB',type:'d1',id:PRIMARY_D1_ID}];
function client({initial=workers,after=initial,settings={[OWNER_WORKER]:owner,'cove-persistence-backend':backend}}={}){
  let n=0;
  return {listWorkers:async()=>++n===1?initial:after,readSettings:async name=>({bindings:settings[name]})};
}
test('existing direct backend D1 binding must block certification',async()=>{
  const r=await inspectPrimaryD1Writers(client());
  assert.equal(r.bindingGatePassed,false);
  assert.deepEqual(r.competingWorkers,['cove-persistence-backend']);
  assert.deepEqual(r.blockers,['nonowner_primary_bindings_present']);
  assert.equal(r.releaseCertified,false);
});
test('exclusive owner direct binding is insufficient for token or release certification',async()=>{
  const r=await inspectPrimaryD1Writers(client({settings:{[OWNER_WORKER]:owner,'cove-persistence-backend':[]}}));
  assert.equal(r.bindingGatePassed,true);
  assert.equal(r.tokenWriteScopeCertified,false);
  assert.equal(r.inventoryAtomicSnapshot,false);
  assert.equal(r.releaseCertified,false);
});
test('disabled owner and invalid primary binding always block',async()=>{
  for(const b of [
    owner.map(x=>x.name==='COVE_RIGHTS_OWNER_ENABLED'?{...x,text:'0'}:x),
    owner.map(x=>x.name==='COVE_RIGHTS_OWNER_PRIMARY_ID'?{...x,text:'wrong'}:x),
    owner.filter(x=>x.type!=='d1')
  ]){
    const r=await inspectPrimaryD1Writers(client({settings:{[OWNER_WORKER]:b,'cove-persistence-backend':[]}}));
    assert.equal(r.bindingGatePassed,false);
  }
});
test('incomplete, duplicate, changing inventory or missing owner fails closed',async()=>{
  await assert.rejects(()=>inspectPrimaryD1Writers(client({settings:{[OWNER_WORKER]:owner}})),/writer_audit_missing_worker_settings/);
  await assert.rejects(()=>inspectPrimaryD1Writers(client({after:[...workers,{id:'new-worker',modified_on}]})),/writer_audit_inventory_changed_during_scan/);
  await assert.rejects(()=>inspectPrimaryD1Writers(client({initial:[...workers,workers[0]]})),/writer_audit_duplicate_worker/);
  await assert.rejects(()=>inspectPrimaryD1Writers(client({
    initial:[workers[1],{id:'other-worker',modified_on}],
    settings:{'cove-persistence-backend':backend,'other-worker':[]}
  })),/writer_audit_owner_worker_missing/);
});
test('guard denies nonmanual, nonmain, wrong confirmation and missing protected token',()=>{
  const env={
    GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'JibrilMohamud/cove',
    GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
    COVE_EXCLUSIVE_WRITER_AUDIT:'EXCLUSIVE_D1_WRITERS_READONLY',
    COVE_CF_WORKERS_METADATA_READ_TOKEN:'x'.repeat(24)
  };
  assert.doesNotThrow(()=>requireProtectedInvocation(env));
  for(const patch of [
    {GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/heads/other'},
    {COVE_EXCLUSIVE_WRITER_AUDIT:'YES'},{COVE_CF_WORKERS_METADATA_READ_TOKEN:''}
  ])assert.throws(()=>requireProtectedInvocation({...env,...patch}),/writer_audit_/);
});
test('transport never writes, never retries 403, rejects unapproved worker names',async()=>{
  let n=0;
  const api=createReadOnlyCloudflareClient({token:'fixture',fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET');n++;return {status:403,body:{cancel:async()=>{}}};
  }});
  await assert.rejects(()=>api.listWorkers(),/writer_audit_cloudflare_http_403/);
  await assert.rejects(()=>api.readSettings('../escape'),/writer_audit_invalid_worker_name/);
  assert.equal(n,1);
});
test('429 only retries a bounded GET; missing paginated workers fail closed',async()=>{
  let n=0,time=0;
  const api=createReadOnlyCloudflareClient({
    token:'fixture',now:()=>time,sleep:async ms=>{time+=ms;},
    fetchImpl:async(url,init)=>{
      assert.equal(init.method,'GET');
      assert.ok(url.endsWith('/workers/scripts'));
      n++;
      if(n===1)return {status:429,body:{cancel:async()=>{}}};
      return {status:200,json:async()=>({success:true,errors:[],result:workers,result_info:{total_count:5}})};
    }
  });
  await assert.rejects(()=>api.listWorkers(),/writer_audit_inventory_pagination_incomplete/);
  assert.equal(n,2);assert.equal(time,20000);
});
