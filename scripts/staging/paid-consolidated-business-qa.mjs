/* eslint-disable prettier/prettier -- Protected isolated QA fixture and exact live binding evidence. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {QA_ACCOUNT,QA_PAID_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";

// Only new operational/presentation schema. Never copy or rewrite paid,
// identity, canonical rights, offer, payment, or entitlement rows.
const tables=["storefront_locales","storefront_market_locales","storefront_currency_options",
  "storefront_payment_methods","storefront_user_preferences","ui_translation_bundles",
  "ui_translation_messages","storefront_context_events","ops_http_requests",
  "ops_trace_spans","ops_metric_points","ops_error_events"];
const quote=n=>'"'+n.replaceAll('"','""')+'"';
export async function prepareConsolidatedBusinessFixture(qaSql){
  const source=new DatabaseSync(":memory:");
  try{
    for(const name of readdirSync("drizzle").filter(n=>n.endsWith(".sql")).sort())
      source.exec(readFileSync(join("drizzle",name),"utf8"));
    const market=(await qaSql("SELECT country_code,default_locale,default_currency,market_status FROM storefront_markets WHERE country_code='US'")).results;
    assert.deepEqual(market,[{country_code:"US",default_locale:"en-US",default_currency:"USD",market_status:"active"}]);
    const present=new Set((await qaSql("SELECT name FROM sqlite_master WHERE type IN ('table','index')")).results.map(r=>r.name));
    for(const table of tables){
      const ddl=source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      assert.ok(ddl?.startsWith("CREATE TABLE")&&ddl.length<16000,table);
      if(!present.has(table))await qaSql(ddl);
      const actual=(await qaSql("PRAGMA table_info("+quote(table)+")")).results.map(r=>r.name);
      const expected=source.prepare("PRAGMA table_info("+quote(table)+")").all().map(r=>r.name);
      assert.deepEqual(actual,expected,"Existing isolated fixture schema drift: "+table);
      for(const index of source.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table)){
        if(!present.has(index.name))await qaSql(index.sql);
      }
    }
    // Load only source-controlled locale/presentation seeds for the already
    // existing synthetic US market. No external or production row is read.
    const seeds=[
      ["storefront_locales","locale='en-US'"],
      ["storefront_market_locales","country_code='US' AND locale='en-US'"],
      ["storefront_currency_options","country_code='US' AND currency='USD'"],
      ["storefront_payment_methods","country_code='US'"],
      ["ui_translation_bundles","locale='en-US' AND status='active'"],
      ["ui_translation_messages","bundle_id IN (SELECT id FROM ui_translation_bundles WHERE locale='en-US' AND status='active')"],
    ];
    for(const [table,where] of seeds){
      const rows=source.prepare("SELECT * FROM "+quote(table)+" WHERE "+where).all();
      assert.ok(rows.length>0,"Source-controlled fixture missing "+table);
      const columns=Object.keys(rows[0]);
      const sql="INSERT OR IGNORE INTO "+quote(table)+"("+columns.map(quote).join(",")+") SELECT "+
        columns.map(c=>"json_extract(value, '$."+c+"')").join(",")+" FROM json_each(?)";
      let batch=[];
      for(const row of rows){
        if(batch.length&&JSON.stringify([...batch,row]).length>12000){
          await qaSql(sql,[JSON.stringify(batch)]);batch=[];
        }
        batch.push(row);
        assert.ok(JSON.stringify(batch).length<=12000);
      }
      if(batch.length)await qaSql(sql,[JSON.stringify(batch)]);
    }
    console.log("PASS: existing paid QA fixture has source-exact operational schema and synthetic US locale seeds");
  }finally{source.close();}
}

export function consolidatedPaidConfigs(owner,runId){
  assert.match(runId,/^\d{8,15}-\d{1,5}$/);
  assert.equal(owner.name,"cove-paid-legal-owner-"+runId);
  assert.equal(owner.workers_dev,false);
  assert.equal(owner.preview_urls,false);
  assert.deepEqual(owner.routes,[]);
  assert.equal(owner.triggers,undefined);
  assert.equal(owner.d1_databases?.length,1);
  assert.equal(owner.d1_databases[0].binding,"PRIMARY_DB");
  assert.equal(owner.d1_databases[0].database_id,QA_PAID_D1);
  assert.notEqual(QA_PAID_D1,PRODUCTION_D1);
  assert.equal(owner.vars.COVE_RIGHTS_OWNER_PRIMARY_ID,QA_PAID_D1);
  assert.equal(owner.vars.COVE_RIGHTS_OWNER_ENABLED,"1");
  assert.equal(owner.vars.STRIPE_LIVEMODE,"false");
  assert.equal(owner.durable_objects?.bindings?.length,1);
  assert.equal(owner.durable_objects.bindings[0].class_name,"CoveLegalAuthority");
  owner.main=".output/strangler/consolidated-owner-qa.mjs";
  owner.compatibility_flags=["nodejs_compat"];
  Object.assign(owner.vars,{
    COVE_CONSOLIDATED_OWNER_QA:"1",FORE_ENVIRONMENT:"staging",COVE_SSR_STAGING:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:QA_PAID_D1,COVE_PUBLICATION_COMMAND_TERRITORY:"US",
    COVE_PUBLICATION_COMMAND_CURRENCY:"USD",
  });
  return {
    name:"cove-paid-business-gateway-"+runId,
    main:".output/strangler/consolidated-gateway-qa.mjs",
    compatibility_date:owner.compatibility_date,workers_dev:true,preview_urls:false,routes:[],
    services:[{binding:"BUSINESS_OWNER",service:owner.name,entrypoint:"CoveBusinessEntrypoint"}],
    vars:{COVE_CONSOLIDATED_GATEWAY_QA:"1",FORE_ENVIRONMENT:"staging",COVE_SSR_STAGING:"1"},
  };
}
async function activeBindings(api,name){
  const path="/workers/scripts/"+name;
  const current=(await api("GET",path+"/deployments"))?.deployments?.[0];
  assert.equal(current?.versions?.length,1);
  assert.equal(current.versions[0].percentage,100);
  const version=current.versions[0].version_id;
  assert.match(version,/^[a-f0-9-]{36}$/);
  const meta=await api("GET",path+"/versions/"+version);
  assert.equal(meta.id,version);
  const bindings=meta.resources?.bindings;
  assert.ok(Array.isArray(bindings));
  return {version,bindings};
}
export async function proveHostedBusiness({api,qaSql,ownerName,businessName,businessOrigin,businessToken,phase,runId}){
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,QA_ACCOUNT);
  assert.ok(["A","restored-A"].includes(phase));
  assert.equal(ownerName,"cove-paid-legal-owner-"+runId);
  assert.equal(businessName,"cove-paid-business-gateway-"+runId);
  assert.equal(businessOrigin,"https://"+businessName+".cove-qa-reads.workers.dev");
  const owner=await activeBindings(api,ownerName),gateway=await activeBindings(api,businessName);
  const native=owner.bindings.filter(b=>b.type==="d1");
  assert.equal(native.length,1);assert.equal(native[0].name,"PRIMARY_DB");
  assert.equal(native[0].database_id,QA_PAID_D1);
  assert.equal(gateway.bindings.filter(b=>b.type==="d1").length,0);
  const service=gateway.bindings.filter(b=>b.type==="service");
  assert.equal(service.length,1);assert.equal(service[0].name,"BUSINESS_OWNER");
  assert.equal(service[0].service,ownerName);
  // A live health response through the named entrypoint independently
  // proves routing; the legal default entrypoint does not serve health.
  assert.equal((await api("GET","/workers/scripts/"+ownerName+"/subdomain")).enabled,false);
  const call=(route,token)=>fetch(businessOrigin+route,{
    headers:{"x-cove-backend-token":token,"x-cove-client-country":"US","accept-language":"en-US"},
    redirect:"error",signal:AbortSignal.timeout(15000)
  });
  let ready=false;
  const readiness=[];
  for(let attempt=0;attempt<24;attempt++){
    try{
      const denied=await call("/__cove/health","wrong-token-000000000000000000");
      const response=await call("/__cove/health",businessToken);
      readiness.push([denied.status,response.status]);
      assert.notEqual(denied.status,200,"Wrong backend credential reached owner");
      if(denied.status===401&&response.status===200){
        const value=await response.json();
        assert.equal(value.ok,true);assert.equal(value.database,true);
        ready=true;break;
      }
    }catch(error){
      if(error?.code==="ERR_ASSERTION")throw error;
      readiness.push(["network-unready"]);
    }
    await new Promise(resolve=>setTimeout(resolve,1200));
  }
  assert.ok(ready,"Hosted consolidated binding not ready: "+JSON.stringify(readiness));
  const count=async()=> (await qaSql("SELECT (SELECT count(*) FROM ops_http_requests WHERE route='/api/fore/storefront/context' AND status_code=200) audit,(SELECT count(*) FROM storefront_context_events WHERE rights_country='US' AND locale='en-US' AND currency='USD') contexts")).results[0];
  const before=await count();
  // Positive business requests are not retried: context persists real
  // operational rows. The eventual observer is read-only.
  const response=await call("/api/fore/storefront/context",businessToken);
  assert.equal(response.status,200,"Hosted native storefront context");
  const body=await response.json();
  assert.equal(body.rightsCountry,"US");assert.equal(body.locale,"en-US");assert.equal(body.currency,"USD");
  assert.ok(body.availableMarkets?.some(m=>m.countryCode==="US"));
  assert.ok(Object.keys(body.messages||{}).length>0);
  let after;
  for(let i=0;i<30;i++){
    after=await count();
    if(after.audit>before.audit&&after.contexts>before.contexts)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(after.audit>before.audit&&after.contexts>before.contexts,"Hosted owner operational writes must persist");
  mkdirSync("artifacts/owner-native-qa",{recursive:true});
  writeFileSync("artifacts/owner-native-qa/consolidated-business-"+phase+".json",JSON.stringify({
    schema:"cove.consolidated-hosted-business.v1",sourceSha:process.env.GITHUB_SHA,runId,phase,
    ownerVersion:owner.version,gatewayVersion:gateway.version,ownerD1Bindings:1,gatewayD1Bindings:0,
    readiness,contextStatus:200,auditDelta:after.audit-before.audit,contextDelta:after.contexts-before.contexts,
    hosted:true,productionAccess:false,releaseCertified:false
  },null,2)+"\n");
  console.log("PASS: hosted consolidated native HTTP, live one-owner binding and persisted context/audit rows ("+phase+")");
}
