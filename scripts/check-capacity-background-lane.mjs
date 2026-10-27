/* eslint-disable prettier/prettier -- Synthetic-only Worker QA contract. */
import assert from "node:assert/strict";
import {build} from "esbuild";

const output=await build({
  entryPoints:["src/storefront-strangler/capacity-background.worker.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false
});
const mod=await import("data:text/javascript;base64,"+
  Buffer.from(output.outputFiles[0].text).toString("base64"));
const worker=mod.default;
const secret="a".repeat(64);
const calls=[];
const db=(kind)=>({
  prepare(sql){
    calls.push({kind,sql});
    return {
      bind(...args){
        return {
          async first(){return {ok:1};},
          async run(){return {success:true,meta:{rows_written:2}};},
          async all(){return {success:true,results:[{product_id:"perf-synth-123456"}],
            meta:{rows_read:1}};}
        };
      }
    };
  }
});
const original={
  CONTENT_DB:db("content"),DISCOVERY_DB:db("discovery"),
  COVE_BG_KEY:secret,COVE_BG_RUN_ID:"40440001111",
  COVE_BG_ENABLED:"1",
  COVE_BG_EXPIRES_AT:String(Date.now()+15*60_000)
};
const call=async(route="/health",body={},env=original,auth=secret,extra={})=>
  worker.fetch(new Request("https://example.invalid"+route,{
    method:"POST",headers:{"authorization":"Bearer "+auth,
      "content-type":"application/json",...extra},body:JSON.stringify(body)
  }),env);
assert.equal((await call("/health",{},original,"0".repeat(64))).status,401);
assert.equal(calls.length,0,"Unknown client must not reach either D1 binding");
assert.equal((await call("/tick",{sequence:0},{...original,COVE_BG_ENABLED:"0"})).status,503);
assert.equal((await call("/tick",{sequence:0},{...original,
  COVE_BG_EXPIRES_AT:String(Date.now()-1000)})).status,503);
assert.equal((await call("/health",{},original,secret,{cookie:"session=1"})).status,405);
assert.equal((await call("/unexpected")).status,404);
const ready=await call();
assert.equal(ready.status,200);
assert.equal((await ready.json()).ok,true);
assert.equal((await call("/tick",{sequence:2.5})).status,400);
assert.equal((await call("/tick",{sequence:100001})).status,400);
const tick=await call("/tick",{sequence:2});
assert.equal(tick.status,200);
const response=await tick.json();
assert.equal(response.sequence,2);
assert.equal(response.discoveryRows,1);
assert.equal(response.meta.length,2);
assert.equal(calls.filter(x=>x.kind==="content"&&x.sql.includes("INSERT INTO cove_arch_load")).length,1,
  "Background write must happen exactly once without implicit request retry");
assert.equal(calls.filter(x=>x.kind==="discovery"&&x.sql.includes("INDEXED BY idx_search_popular_stable")).length,1,
  "Isolated catalog query must be indexed");

const failDb={prepare(){throw Error("background down");}};
const denied=await call("/tick",{sequence:3},{...original,CONTENT_DB:failDb});
assert.equal(denied.status,503,"Broken background D1 must fail release traffic");
assert.equal((await denied.json()).code,"background_unavailable");
console.log("PASS: private capacity background Worker: auth, expiry, exact work, D1 failure and no replay");
