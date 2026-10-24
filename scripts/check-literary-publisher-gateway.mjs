import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir=mkdtempSync(path.join(os.tmpdir(),"cove-literary-publisher-"));
try{
  await build({entryPoints:["src/literary-inference-publisher.worker.ts"],
    bundle:true,format:"esm",platform:"node",outfile:path.join(dir,"publisher.mjs"),
    logLevel:"silent"});
  const {handleLiteraryPublication}=await import(path.join(dir,"publisher.mjs"));
  const sha=x=>createHash("sha256").update(x).digest("hex");
  const tokenA="a".repeat(48),tokenB="b".repeat(48),jobId="c".repeat(64);
  const env={
    FORE_LITERARY_INFERENCE_PUBLISH_ENABLED:"1",
    FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256:sha(tokenA),
    FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256:sha(tokenB),
    DB:{prepare(){throw Error("unexpected primary D1 access")}},
  };
  let published=0,probes=0;
  const publish=async(_env,id)=>{published++;assert.equal(id,jobId);return {published:"p_qa"}};
  const admission=async()=>{probes++;return {allowed:true,reason:"healthy",probeMs:1}};
  const req=(token=tokenA,backend=tokenB,body={jobId},url="https://not-public.invalid/v1/operator/publish")=>
    new Request(url,{
      method:"POST",headers:{
        "x-cove-literary-publish-token":token,
        "x-cove-literary-backend-token":backend,
        "content-type":"application/json",
      },
      body:JSON.stringify(body),
    });
  assert.equal((await handleLiteraryPublication(req(),{
    ...env,FORE_LITERARY_INFERENCE_PUBLISH_ENABLED:"0",
  },publish,admission)).status,403);
  assert.equal((await handleLiteraryPublication(req("incorrect",tokenB),env,publish,admission)).status,401);
  assert.equal((await handleLiteraryPublication(req(tokenA,tokenA),env,publish,admission)).status,401);
  assert.equal((await handleLiteraryPublication(req(tokenA,tokenB,{jobId:"not-sha"}),env,publish,admission)).status,400);
  assert.equal((await handleLiteraryPublication(req(tokenA,tokenB,{jobId,extra:"spoof"}),env,publish,admission)).status,400);
  assert.equal((await handleLiteraryPublication(req(tokenA,tokenB,{jobId},
    "https://not-public.invalid/"),env,publish,admission)).status,404);
  assert.equal(published,0);
  assert.equal(probes,0,"Untrusted and disabled requests must never touch D1");
  const deferred=await handleLiteraryPublication(req(),env,publish,async()=>{
    probes++;return {allowed:false,reason:"primary_busy",probeMs:180};
  });
  assert.equal(deferred.status,503);
  assert.equal(published,0);
  const response=await handleLiteraryPublication(req(),env,publish,admission);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(await response.json(),{published:"p_qa"});
  assert.equal(published,1);
  const configuration=readFileSync("wrangler.literary-inference-publisher.example.toml","utf8");
  assert.match(configuration,/workers_dev = false/);
  assert.match(configuration,/preview_urls = false/);
  assert.match(configuration,/FORE_LITERARY_INFERENCE_PUBLISH_ENABLED = "0"/);
  assert.match(configuration,/crons = \[\]/);
  console.log("LITERARY_PUBLISHER_GATEWAY_PASS dual hash-based scoped tokens, disabled-by-default, nonpublic, D1 admission and atomic publisher delegation.");
}finally{rmSync(dir,{recursive:true,force:true});}
