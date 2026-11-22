/* eslint-disable prettier/prettier -- Exercise the actual protected CLI with a network-denying fixture. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const runner=fileURLToPath(new URL("./protected-primary-grant-event-replay.mjs",import.meta.url));
const policy=new URL("./primary-grant-event-replay-policy.mjs",import.meta.url).href;
function runFixture(mode){
  const dir=mkdtempSync(join(tmpdir(),"cove-replay-protocol-"));
  const preload=join(dir,"network-denying-fixture.mjs");
  writeFileSync(preload,`
    import assert from 'node:assert/strict';
    import {AUDIT_KEYS,HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL} from ${JSON.stringify(policy)};
    const mode=${JSON.stringify(mode)};
    // No original fetch is retained or used. Any unreviewed request throws.
    let calls=0,time=1000000;
    Date.now=()=>time;
    globalThis.setTimeout=(fn,ms)=>{time+=ms;queueMicrotask(fn);return 0;};
    const value=Object.fromEntries(AUDIT_KEYS.map(k=>[k,null]));
    Object.assign(value,{editionId:'private-edition',decision:'allow',status:'active',
      format:'ebook',territory:'US',promotionRestrictions:{},notes:'private-evidence-marker'});
    const state=JSON.stringify(value);
    const boundary={audit_rows:1,audit_max_rowid:1,grant_rows:1,
      suspended_grants:0,decision_rows:0,copyright_notices:0};
    globalThis.fetch=async(url,options)=>{
      calls++;
      assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query');
      assert.equal(options.method,'POST');
      const {sql,params}=JSON.parse(options.body);
      assert.ok([HISTORY_BOUNDARY_SQL,HISTORY_EVENTS_SQL,HISTORY_CURRENT_SQL].includes(sql));
      if(mode==='rate-limit'||(mode==='retry'&&calls===2))
        return new Response('private-rate-limit-body',{status:429,headers:{'retry-after':'1'}});
      if(mode==='timeout'&&calls===3)throw Error('Timeout private-evidence-marker');
      if(mode==='forbidden'&&calls===2)return new Response('private-auth-body',{status:403});
      let rows;
      if(sql===HISTORY_BOUNDARY_SQL){assert.deepEqual(params,[]);rows=[boundary];}
      if(sql===HISTORY_EVENTS_SQL){assert.deepEqual(params,[0]);rows=[{
        event_seq:1,grant_id:'private-grant',action:'insert',snapshot_json:state,
        recorded_at:'2026-10-09T00:00:00.000Z'}];}
      if(sql===HISTORY_CURRENT_SQL){assert.deepEqual(params,['']);rows=[{
        grant_id:'private-grant',snapshot_json:state}];}
      const meta={changed_db:mode==='mutated',changes:mode==='mutated'?1:0};
      return Response.json({success:true,result:[{success:true,results:rows,meta}]});
    };
  `);
  try{
    const child=spawnSync(process.execPath,["--import",preload,runner,"--live"],{
      cwd:dir,encoding:"utf8",timeout:10000,
      env:{...process.env,GITHUB_ACTIONS:"true",GITHUB_EVENT_NAME:"workflow_dispatch",
        GITHUB_REF:"refs/heads/main",CF_ACCOUNT_ID:"d26430caa63ec55f6612e32f36aca5e9",
        COVE_PRODUCTION_D1_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989",
        COVE_PRODUCTION_LEGAL_AUDIT_ONLY:"1",
        COVE_CF_PRODUCTION_AUDIT_READ_TOKEN:"synthetic-fixture-token-never-sent",
        GITHUB_STEP_SUMMARY:""},
    });
    assert.equal(child.error,undefined);
    const report=JSON.parse(readFileSync(join(dir,
      "artifacts/production-rights-history/grant-event-replay.json"),"utf8"));
    const published=JSON.stringify(report)+child.stdout+child.stderr;
    for(const secret of ["private-grant","private-edition","private-evidence-marker",
      "private-auth-body","private-rate-limit-body","synthetic-fixture-token-never-sent"])
      assert.ok(!published.includes(secret),"private fixture data leaked: "+secret);
    assert.equal(report.authorizing,false);
    assert.equal(report.permitsPublication,false);
    assert.equal(report.releaseCertified,false);
    return {report,status:child.status};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test("actual protected CLI completes all fixed SELECTs after a bounded 429 retry",()=>{
  const {report,status}=runFixture("retry");
  assert.equal(status,0);
  assert.equal(report.complete,true);
  assert.equal(report.eventsReplayed,1);
  assert.equal(report.grantsCompared,1);
  assert.equal(report.rateLimitedResponses,1);
  assert.equal(report.rateLimitWaitMs,20000);
  assert.equal(report.primaryHttpAttempts,5);
  assert.equal(report.auditedStateEqualsCurrent,true);
  assert.equal(report.historicalRightsReconciled,false);
});
test("exhausted rate limit preserves a nonauthorizing incomplete checkpoint",()=>{
  const {report,status}=runFixture("rate-limit");
  assert.notEqual(status,0);
  assert.equal(report.complete,false);
  assert.equal(report.failureClass,"rate-limited");
  assert.equal(report.httpAttempts,3);
  assert.equal(report.eventsReplayed,0);
});
test("mid-replay timeout preserves aggregate progress without exception details",()=>{
  const {report,status}=runFixture("timeout");
  assert.notEqual(status,0);
  assert.equal(report.complete,false);
  assert.equal(report.failureClass,"transport-timeout");
  assert.equal(report.eventsReplayed,1);
  assert.equal(report.grantsCompared,0);
});
test("authentication errors are never retried and mutation metadata fails closed",()=>{
  for(const mode of ["forbidden","mutated"]){
    const {report,status}=runFixture(mode);
    assert.notEqual(status,0);
    assert.equal(report.complete,false);
    assert.equal(report.httpAttempts,mode==="forbidden"?2:1);
    assert.equal(report.failureClass,mode==="forbidden"?
      "authentication-denied":"protocol-or-transport-failed");
  }
});
