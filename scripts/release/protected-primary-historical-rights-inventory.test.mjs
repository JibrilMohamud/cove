/* eslint-disable prettier/prettier -- Actual protected CLI protocol with networking disabled. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const runner=fileURLToPath(new URL("./protected-primary-historical-rights-inventory.mjs",import.meta.url));
const policy=new URL("./primary-historical-rights-inventory-policy.mjs",import.meta.url).href;
function fixture(mode){
  const dir=mkdtempSync(join(tmpdir(),"cove-history-cli-"));
  const preload=join(dir,"network-denied.mjs");
  writeFileSync(preload,`
    import assert from 'node:assert/strict';
    import {HISTORICAL_SQL} from ${JSON.stringify(policy)};
    const mode=${JSON.stringify(mode)};
    let calls=0,time=1000000;
    Date.now=()=>time;
    globalThis.setTimeout=(fn,ms)=>{time+=ms;queueMicrotask(fn);return 0;};
    const data={
      state:{product_total:2,active_products:1,inactive_products:1,grant_total:1,
        active_allow_grants:1,suspended_grants:0,active_uncovered:mode==='inconsistent'?1:0,
        inactive_without_grant:1,contracts:0,contract_versions:0,active_markets:1},
      evidence:{joined_grants:1,missing_evidence:0,unapproved_or_mismatched:0,
        legacy_evidence_hashes:1,other_evidence_types:0},
      cache:{joined_grants:1,missing_cache_or_source:0,active_uncleared_cache:0,
        active_unapproved_commercial_cache:0,disabled_source_grants:0,
        source_evidence_pointer_mismatch:0,legacy_cache_content_hashes:1},
      exposure:{retail_rows:1,scoped_grants:1,scoped_territories:1,
        explicit_deny_grants:0,copyright_notices:0},
    };
    // Never retain or call the original fetch; reject every unreviewed SQL.
    globalThis.fetch=async(url,options)=>{
      calls++;
      assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query');
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      assert.deepEqual(Object.keys(body),['sql']);
      const kind=Object.keys(HISTORICAL_SQL).find(k=>HISTORICAL_SQL[k]===body.sql);
      assert.ok(kind);
      if(mode==='rate-limit'||(mode==='retry'&&calls===2))
        return new Response('private-upstream-body',{status:429,headers:{'retry-after':'30'}});
      if(mode==='timeout'&&calls===3)throw Error('Timeout private-upstream-body');
      if(mode==='forbidden'&&calls===3)return new Response('private-upstream-body',{status:403});
      if(mode==='server-error'&&calls===3)return new Response('private-upstream-body',{status:503});
      const meta={changed_db:false,changes:0,rows_written:mode==='mutated'?1:0,
        served_by_primary:mode!=='replica'};
      if(mode==='unattested')delete meta.served_by_primary;
      return Response.json({success:true,result:[{success:true,results:[data[kind]],meta}]});
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
      "artifacts/production-rights-history/inventory.json"),"utf8"));
    const output=JSON.stringify(report)+child.stdout+child.stderr;
    for(const secret of ["private-upstream-body","synthetic-fixture-token-never-sent"])
      assert.ok(!output.includes(secret));
    for(const key of ["authorizing","permitsPublication","releaseCertified",
      "currentOwnerVerified","historicalRightsReconciled"])
      assert.equal(report[key],false,key);
    return {report,status:child.status};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test("all eight aggregate reads complete after bounded 429 with Retry-After",()=>{
  const {report,status}=fixture("retry");
  assert.equal(status,0);
  assert.equal(report.complete,true);
  assert.equal(report.sourceReadOnly,true);
  assert.equal(report.historicalInventoryConsistent,true);
  assert.equal(report.primaryReadRequests,9);
  assert.equal(report.rateLimitedResponses,1);
  assert.equal(report.rateLimitWaitMs,30000);
});
test("exhausted 429 keeps an incomplete nonauthorizing checkpoint",()=>{
  const {report,status}=fixture("rate-limit");
  assert.notEqual(status,0);
  assert.equal(report.complete,false);
  assert.equal(report.failureClass,"rate-limited");
  assert.equal(report.httpAttempts,3);
  assert.equal(report.aggregatesCompleted,0);
});
test("partial timeout, denied auth and 5xx stop immediately with safe progress",()=>{
  for(const mode of ["timeout","forbidden","server-error"]){
    const {report,status}=fixture(mode);
    assert.notEqual(status,0);
    assert.equal(report.complete,false);
    assert.equal(report.httpAttempts,3);
    assert.equal(report.aggregatesCompleted,2);
    assert.equal(report.failureClass,mode==="timeout"?"transport-timeout":
      mode==="forbidden"?"authentication-denied":"protocol-or-transport-failed");
  }
});
test("replica, write or absent primary attestation stops on the first query",()=>{
  for(const mode of ["replica","mutated","unattested"]){
    const {report,status}=fixture(mode);
    assert.notEqual(status,0);
    assert.equal(report.complete,false);
    assert.equal(report.httpAttempts,1);
    assert.equal(report.aggregatesCompleted,0);
  }
});
test("completed but structurally inconsistent inventory still fails and retains blockers",()=>{
  const {report,status}=fixture("inconsistent");
  assert.notEqual(status,0);
  assert.equal(report.complete,true);
  assert.equal(report.historicalInventoryConsistent,false);
  assert.ok(report.blockers.includes("historical_primary_active_grants_missing"));
});
