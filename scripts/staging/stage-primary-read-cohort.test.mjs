/* eslint-disable prettier/prettier -- Exercise pending-only cohorts without provider or credentials. */
import assert from "node:assert/strict";
import test from "node:test";
import {build} from "esbuild";
const built=await build({entryPoints:["src/storefront-strangler/stage-primary-read-cohort.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent"});
const {FreshPrimaryCohorts,stagePrimaryCohortReader,CoveStagePrimaryReadCohort}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));
const input={ids:["prd_test_1"],territory:"US",currency:"USD"};
const evidence=(rows=[])=>({rows,metrics:{servedByPrimary:true}});
test("only already admitted identical requests share a statement, never late arrivals or settled results",async()=>{
  const scheduled=[],readers=[];
  const c=new FreshPrimaryCohorts(x=>new Promise(resolve=>readers.push({x,resolve})),fn=>scheduled.push(fn));
  const a=c.submit(input),b=c.submit(input);
  assert.equal(readers.length,0);assert.equal(scheduled.length,1);
  scheduled.shift()();
  assert.equal(readers.length,1);
  const late=c.submit(input);
  assert.equal(scheduled.length,1);
  readers[0].resolve(evidence([{product_id:"prd_test_1"}]));
  assert.equal((await a).rows.length,1);assert.equal((await b).rows.length,1);
  scheduled.shift()();assert.equal(readers.length,2);
  readers[1].resolve(evidence());assert.deepEqual((await late).rows,[]);
  const later=c.submit(input);scheduled.shift()();assert.equal(readers.length,3);
  readers[2].resolve(evidence());await later;
});
test("market, currency and exact ordered IDs cannot cross a cohort; replica and provider errors deny",async()=>{
  const scheduled=[],calls=[];
  const c=new FreshPrimaryCohorts(async x=>{calls.push(x);if(x.territory==="CA")throw Error("provider failure");return {rows:[],metrics:{servedByPrimary:x.currency==="USD"}};},fn=>scheduled.push(fn));
  const work=[c.submit(input),c.submit({...input,territory:"CA"}),c.submit({...input,currency:"EUR"}),c.submit({...input,ids:["prd_test_2","prd_test_1"]})];
  const result=Promise.allSettled(work);
  for(const fn of scheduled)fn();
  assert.deepEqual((await result).map(x=>x.status),["fulfilled","rejected","rejected","fulfilled"]);
  assert.equal(calls.length,4);
});
test("flag is impossible in production, disabled and unauthorized DO calls cannot query D1",async()=>{
  assert.equal(stagePrimaryCohortReader({}),undefined);
  const env={COVE_STAGE_PRIMARY_COHORT:"1",COVE_SSR_STAGING:"1",COVE_STRANGLER_MODE:"isolated-evaluation",COVE_STRANGLER_DATABASE_ID:"e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",COVE_STRANGLER_READ_MODEL:"2",COVE_SSR_STAGING_GATE_KEY:"a".repeat(64),STAGE_PRIMARY_COHORT:{getByName(){throw Error("not called");}}};
  assert.throws(()=>stagePrimaryCohortReader({...env,COVE_STRANGLER_DATABASE_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"}));
  assert.throws(()=>stagePrimaryCohortReader({...env,COVE_SSR_STAGING:"0"}));
  const doInstance=new CoveStagePrimaryReadCohort({},env);
  const request=new Request("https://cohort.internal/primary-cohort",{method:"POST",body:JSON.stringify(input)});
  assert.equal((await doInstance.fetch(request)).status,401);
});
