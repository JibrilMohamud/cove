/* eslint-disable prettier/prettier -- Isolated real-handler failure injection; never live D1. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const root=mkdtempSync(path.join(tmpdir(),"cove-fore-real-handler-fault-"));
try{
  await build({
    entryPoints:{
      api:"src/features/fore/api.server.ts",
      attribution:"src/lib/persistence-backend-failure.ts",
    },
    outdir:root,bundle:true,format:"esm",platform:"neutral",
    alias:{jszip:"jszip/dist/jszip.min.js"},
    mainFields:["browser","module","main"],target:"es2022",
    conditions:["workerd","worker","browser","import","default"],
    external:["node:*","cloudflare:*"],
    outExtension:{".js":".mjs"},logLevel:"silent"
  });
  const {handleCoveApi}=await import(pathToFileURL(path.join(root,"api.mjs")).href);
  const {backendFailureSource,backendFailureStage}=await import(
    pathToFileURL(path.join(root,"attribution.mjs")).href);
  const SECRET="synthetic-private-failure-token-never-emit";
  const simulatedD1={
    prepare(_sql){throw new Error(SECRET);},
    batch(){return Promise.reject(new Error(SECRET));},
  };
  const env={
    DB:simulatedD1,FORE_ENVIRONMENT:"production",
    FORE_AUTH_MODE:"off",FORE_DEFAULT_TERRITORY:"US",
    // Deliberately absent: production credentials, Stripe, R2, DO and real rate-limiter.
  };
  const results=[];
  for(const route of ["/storefront/context","/catalog",
    "/storefront/bootstrap","/taxonomy","/storefront/page"]){
    const request=new Request("https://isolated-cove.test/api/fore"+route,{
      method:"GET",
    });
    const background=[];
    const response=await handleCoveApi(request,env,{
      waitUntil:p=>background.push(Promise.resolve(p).catch(()=>undefined)),
    });
    assert.ok(response instanceof Response,"Real API must return a Response");
    assert.equal(response.status,503,"Synthetic D1 failure must fail closed: "+route);
    const headers=new Headers(response.headers);
    // These two headers normally come from the actual persistence Worker
    // gateway, not handleCoveApi; adding them here tests its real parser.
    headers.set("x-cove-persistence","d1-r2");
    headers.set("x-cove-backend-cache","MISS");
    assert.equal(backendFailureSource(headers),"worker-api");
    const stage=backendFailureStage(headers);
    assert.ok(["context","context-market","catalog","markets","limit","page","multiple"].includes(stage),
      "Real Worker 503 did not retain a reviewed phase: "+route+" stage="+stage);
    if(route==="/storefront/context"){
      assert.equal(stage,"context-market",
        "Synthetic failing market SELECT must produce exact, safe context substage");
    }
    const timing=response.headers.get("server-timing")||"";
    assert.ok(timing.includes("cove_api;dur="));
    assert.ok(!timing.includes(SECRET));
    const body=await response.text();
    assert.ok(!body.includes(SECRET),"Synthetic upstream error leaked");
    await Promise.allSettled(background);
    results.push({route,stage,status:response.status});
  }
  console.log(JSON.stringify({event:"cove_real_fore_mock_d1_503_phase_contract",
    tests:results,syntheticD1:true,customerRequests:0,productionWrites:0,
    releaseCertified:false}));
}finally{rmSync(root,{recursive:true,force:true});}
