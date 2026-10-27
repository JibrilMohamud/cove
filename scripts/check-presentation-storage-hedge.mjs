/* eslint-disable prettier/prettier -- Time-sensitive private presentation regression. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {setTimeout as sleep} from "node:timers/promises";

const dir=mkdtempSync(path.join(os.tmpdir(),"cove-presentation-hedge-"));
try{
  const outfile=path.join(dir,"hedge.mjs");
  await build({entryPoints:["src/storefront-strangler/presentation-hedge.server.ts"],
    outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {hedgedPrivatePresentation}=await import(pathToFileURL(outfile).href);
  const box=text=>({size:new TextEncoder().encode(text).byteLength,text:async()=>text});
  const probe=async({kvDelay=0,kvValue="kv",r2Delay=0,r2Value="r2"}={})=>{
    let kvCalls=0,r2Calls=0;
    const evidence=[];
    const p=hedgedPrivatePresentation({
      async get(){r2Calls++;await sleep(r2Delay);return r2Value===null?null:box(r2Value);}
    },{
      async get(){kvCalls++;await sleep(kvDelay);return kvValue;}
    },{hedgeAfterMs:20,onEvidence:e=>evidence.push(e)});
    const started=Date.now();
    let output,failed=false;
    try{const doc=await p.get("home/US.json");output=await doc.text();}
    catch{failed=true;}
    return {output,failed,elapsed:Date.now()-started,kvCalls,r2Calls,evidence};
  };
  let result=await probe({kvDelay:0,r2Delay:180});
  assert.equal(result.output,"kv");
  assert.equal(result.r2Calls,0,"A fast private KV hit MUST NOT trigger R2 read");
  result=await probe({kvDelay:190,r2Delay:5});
  assert.equal(result.output,"r2");
  assert.equal(result.r2Calls,1,"A slow KV request must be hedged with verified R2");
  assert.ok(result.elapsed<145,"A 190ms KV tail must not block on KV when R2 is fast");
  assert.equal(result.evidence[0].hedged,true);
  result=await probe({kvDelay:0,kvValue:null,r2Delay:2});
  assert.equal(result.output,"r2","Missing regional KV must fall back to durable R2");
  result=await probe({kvDelay:1,kvValue:"kv",r2Delay:10,r2Value:null});
  assert.equal(result.output,"kv","A healthy KV hit must not fail from unrelated R2 outage");
  result=await probe({kvDelay:1,kvValue:null,r2Delay:2,r2Value:null});
  assert.equal(result.failed,true,"Never synthesize a projection when both stores are unavailable");
  assert.equal(result.r2Calls,1);
  assert.throws(()=>hedgedPrivatePresentation({get:async()=>null},
    {get:async()=>null},{hedgeAfterMs:0}),/Invalid presentation hedge threshold/);
  console.log("PASS: private presentation hedge skips unnecessary R2, avoids stalled KV, handles misses, and fails closed");
}finally{rmSync(dir,{recursive:true,force:true});}
