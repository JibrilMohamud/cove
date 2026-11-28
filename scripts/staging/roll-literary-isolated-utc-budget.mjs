/* eslint-disable prettier/prettier -- fixed read-only production receipt contract */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";

const account="d26430caa63ec55f6612e32f36aca5e9";
const isolated="400c3af3-5d40-41fd-83cc-98228e40ddac";
export const activationRelease="2740748a28f6d7e81d4d4e7334a465d5315d7c65";
const hour=3600000;
const endpoint="https://api.cloudflare.com/client/v4/accounts/"+account+"/d1/database/"+isolated+"/query";
export async function observeBudget(env,{transport=fetch,now=Date.now()}={}){
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.ok(["schedule","workflow_dispatch"].includes(env.GITHUB_EVENT_NAME));
  assert.ok(!env.CLOUDFLARE_API_TOKEN,"legacy mutation credential forbidden");
  const token=env.COVE_BIOSYNC_PROD_D1_READ_TOKEN;
  assert.ok(typeof token==="string"&&token.length>=24,"scoped D1 read required");
  async function read(sql,params=[]){
    assert.match(sql,/^SELECT\b/);
    const r=await transport(endpoint,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({sql,params}),redirect:"error",signal:AbortSignal.timeout(30000)});
    assert.ok(r.ok,"budget_observation_http_"+r.status);
    const j=await r.json();
    assert.ok(j.success===true&&j.result?.length===1&&j.result[0].success===true&&Array.isArray(j.result[0].results),"budget_observation_invalid_response");
    return j.result[0].results;
  }
  const today=new Date(now).toISOString().slice(0,10);
  const start=Date.parse(today+"T00:00:00Z"),yesterday=new Date(start-24*hour).toISOString().slice(0,10);
  const [identity,days,ticks]=await Promise.all([
    read("SELECT domain,schema_version,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','products','payment_orders')) contaminated FROM literary_budget_domain_identity WHERE id=1"),
    read("SELECT day,status FROM literary_budget_cutover WHERE day IN (?,?) ORDER BY day",[yesterday,today]),
    read("SELECT release_sha,scheduled_ms,cron,day,state FROM literary_owner_budget_tick_receipt WHERE id=1")
  ]);
  assert.deepEqual(identity,[{domain:"cove-isolated-literary-budget",schema_version:1,contaminated:0}]);
  assert.ok(days.some(x=>x.day===yesterday&&x.status==="active"),"budget_previous_day_not_active");
  assert.equal(ticks.length,1,"budget_native_receipt_missing");
  const tick=ticks[0];
  assert.equal(tick.release_sha,activationRelease,"budget_native_release_drift");
  assert.equal(tick.cron,"25 * * * *","budget_native_hourly_receipt_missing");
  assert.ok(Number.isSafeInteger(tick.scheduled_ms)&&tick.scheduled_ms<=now&&now-tick.scheduled_ms<=2*hour,"budget_native_receipt_stale");
  assert.equal(tick.day,new Date(tick.scheduled_ms).toISOString().slice(0,10),"budget_native_receipt_day_drift");
  assert.ok(["active","already_active"].includes(tick.state),"budget_native_receipt_state");
  if(now-start>=55*60000){
    assert.ok(days.some(x=>x.day===today&&x.status==="active"),"budget_current_day_not_active");
    assert.equal(tick.day,today,"budget_current_day_receipt_missing");
  }
  return {schema:"cove.native-budget-readonly-observation.v1",day:today,receipt:tick,providerMutation:false,releaseCertified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await observeBudget(process.env)));}
  catch(error){const m=String(error?.message||"");console.error(/^budget_[a-z0-9_]+$/.test(m)?m:"budget_observation_failed_closed");process.exitCode=1;}
}
