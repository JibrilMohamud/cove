/* eslint-disable prettier/prettier -- native production topology test, no remote calls */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
const dir=mkdtempSync(join(tmpdir(),"cove-prod-enrollment-"));
await build({entryPoints:["src/storefront-strangler/production-persistence-enrollment.ts"],
  outfile:join(dir,"policy.mjs"),bundle:true,format:"esm",platform:"node"});
const p=await import(pathToFileURL(join(dir,"policy.mjs")).href);
const config=path=>JSON.parse(readFileSync(path,"utf8"));
const owner=config("wrangler.consolidated-owner.production-candidate.jsonc");
const gateway=config("wrangler.consolidated-gateway.production-candidate.jsonc");
const db=()=>({prepare(){},batch(){}});
const env={
  COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED:"1",FORE_ENVIRONMENT:"production",FORE_AUTH_MODE:"supabase",
  COVE_RIGHTS_OWNER_ENABLED:"0",COVE_RIGHTS_OWNER_PRIMARY_ID:p.PRODUCTION_PRIMARY,
  COVE_LEGAL_WRITER_PRIMARY_ID:p.PRODUCTION_PRIMARY,FORE_BACKEND_TOKEN_SHA256:"a".repeat(64),
  COVE_RIGHTS_OWNER_SECRET:"b".repeat(64),PRIMARY_DB:db(),LITERARY_CONTENT_DB:db(),
  LEGAL_AUTHORITY:{getByName(){}}
};
test("production binding roles, same namespace, no automatic activation",()=>{
  assert.equal(owner.name,"cove-legal-authority-production");
  assert.deepEqual(owner.durable_objects.bindings,[{name:"LEGAL_AUTHORITY",class_name:"CoveLegalAuthority"}]);
  assert.deepEqual(owner.migrations,[{tag:"legal-authority-production-locked-v1",new_sqlite_classes:["CoveLegalAuthority"]}]);
  assert.equal(owner.workers_dev,false);assert.equal(owner.preview_urls,false);
  assert.deepEqual(owner.routes,[]);
  assert.equal(owner.d1_databases.filter(x=>x.database_id===p.PRODUCTION_PRIMARY).length,1);
  assert.equal(owner.d1_databases.find(x=>x.binding==="LITERARY_CONTENT_DB").database_id,"400c3af3-5d40-41fd-83cc-98228e40ddac");
  assert.equal(owner.vars.COVE_RIGHTS_OWNER_ENABLED,"0");
  for(const name of ["OWNER","CRON","BIOSYNC"])assert.equal(owner.vars["COVE_PRODUCTION_PERSISTENCE_"+name+"_ENABLED"],"0");
  assert.equal(gateway.name,"cove-persistence-backend");
  assert.equal(gateway.d1_databases,undefined);assert.equal(gateway.durable_objects,undefined);
  assert.equal(gateway.r2_buckets,undefined);assert.equal(gateway.triggers,undefined);
  assert.deepEqual(gateway.services,[{binding:"BUSINESS_OWNER",service:owner.name,entrypoint:"CoveBusinessEntrypoint"}]);
  assert.equal(gateway.vars.COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED,"0");
  assert.equal(owner.triggers,undefined);
  assert.deepEqual(p.PRODUCTION_SCHEDULES,JSON.parse(readFileSync("wrangler.backend.production.toml","utf8").match(/^crons = (\[[^\n]+\])$/m)[1]));
});
test("production enrollment never accepts QA, positive grants, a competing database or plaintext backend token",()=>{
  assert.equal(p.productionPersistenceEnrolled(env),true);
  for(const x of [
    {COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED:"0"},{FORE_ENVIRONMENT:"staging"},
    {COVE_SSR_STAGING:"1"},{COVE_RIGHTS_OWNER_ENABLED:"1"},
    {COVE_RIGHTS_OWNER_PRIMARY_ID:"969f1ea0-5f57-4f3a-aa25-9c74e58f5af3"},
    {COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+60000)},
    {FORE_BACKEND_TOKEN:"plaintext"},{FORE_AUTH_MODE:"development"},
    {FORE_BACKEND_TOKEN_SHA256:"b".repeat(64)},{DB:db()},{EXTRA:db()},
    {LITERARY_CONTENT_DB:env.PRIMARY_DB},{COVE_QA_OWNER_UNBOUND_READ_ENABLED:"1"},
    {COVE_PUBLICATION_COMMANDS_ENABLED:"1"},{COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1"}
  ])assert.equal(p.productionPersistenceEnrolled({...env,...x}),false,JSON.stringify(Object.keys(x)));
});
test("only exact nonauthorizing operations; storefront, delivery and payments denied",()=>{
  const req=(path,method="GET")=>new Request("https://fixture.invalid"+path,{method});
  assert.equal(p.maintenanceBusinessRoute(req("/__cove/health")),true);
  for(const path of ["/api/fore/health/live","/api/fore/health/ready","/api/fore/service-status"]){
    assert.equal(p.maintenanceBusinessRoute(req(path)),true,path);
    assert.equal(p.maintenanceBusinessRoute(req(path,"POST")),false,path);
    assert.equal(p.maintenanceBusinessRoute(req(path+"?x=1")),false,path);
  }
  assert.equal(p.maintenanceBusinessRoute(req("/api/fore/reader/settings","POST")),true);
  for(const path of ["/api/fore/catalog","/api/fore/storefront/context","/api/fore/commerce/checkout","/api/fore/library","/api/fore/reader/content","/api/fore/reader/settings?x=1","/__cove/health/","/api/fore/admin/rights","/api/fore/reader%2fsettings"])
    assert.equal(p.maintenanceBusinessRoute(req(path)),false,path);
  assert.equal(p.maintenanceBusinessRoute(req("/api/fore/reader/settings","DELETE")),false);
});
test("BioSync distinct credential and fixed request shape",async()=>{
  const key="synthetic-biosync-client-credential";
  const digest=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key))).toString("hex");
  assert.equal(await p.checkToken(key,digest),true);
  assert.equal(await p.checkToken(key+"x",digest),false);
  assert.equal(p.productionBiosyncEnrolled({...env,COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED:"1",
    COVE_BIOSYNC_CLIENT_TOKEN_SHA256:digest,BUCKET:{get(){}}}),true);
  assert.equal(p.productionBiosyncEnrolled({...env,COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED:"1",
    COVE_BIOSYNC_CLIENT_TOKEN_SHA256:env.FORE_BACKEND_TOKEN_SHA256,BUCKET:{get(){}}}),false);
  const req=new Request("https://fixture.invalid"+p.BIOSYNC_PATH,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:"{}"});
  assert.equal(p.productionBiosyncRequest(req),true);
  assert.equal(p.productionBiosyncRequest(new Request(req.url)),false);
  assert.equal(p.productionOwnerInternalRequest(req,env.COVE_RIGHTS_OWNER_SECRET),false);
});
process.on("exit",()=>rmSync(dir,{recursive:true,force:true}));

test("consolidated transition preserves named BioSync and literary budget without enrolling both modes",()=>{
  const configured={...env,COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED:"1",
    COVE_BIOSYNC_CLIENT_TOKEN_SHA256:"c".repeat(64),BUCKET:{get(){}}};
  assert.equal(p.productionNamedBiosyncEnrolled(configured),true);
  assert.equal(p.productionLiteraryBudgetEnrolled(configured),true);
  assert.equal(p.productionLiteraryBudgetEnrolled(env),true);
  assert.equal(p.productionNamedBiosyncEnrolled(env),false);
  for(const patch of [{COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED:"1"},
    {COVE_RIGHTS_OWNER_ENABLED:"1"},{COVE_SSR_STAGING:"1"},{DB:db()},
    {LITERARY_CONTENT_DB:env.PRIMARY_DB},{COVE_QA_SCHEDULE_OWNER_ENABLED:"1"}]){
    assert.equal(p.productionNamedBiosyncEnrolled({...configured,...patch}),false);
    assert.equal(p.productionLiteraryBudgetEnrolled({...configured,...patch}),false);
  }
});
