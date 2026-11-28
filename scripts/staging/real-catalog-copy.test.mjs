/* eslint-disable prettier/prettier -- Exercise the fixed snapshot SQL and admission boundary. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {source,target,plan,mustBeEmpty,insertSql,readSql,validateRows} from "./real-catalog-copy-plan.mjs";
import worker from "./real-catalog-copy.worker.mjs";
import {verifyReceipt} from "./real-catalog-copy-receipt.mjs";
import {createProviderBudget,ratePause} from "./real-catalog-copy-budget.mjs";
import {reconcilePage} from "./real-catalog-copy-resume.mjs";
import {pageLimit} from "./real-catalog-copy-plan.mjs";
const item=plan.find(x=>x.table==="products");
test("snapshot target is physically separate and private tables are not imported",()=>{
  assert.notEqual(source,target);
  assert.equal(new Set(plan.map(x=>x.table)).size,plan.length);
  assert.ok(plan.every(x=>!mustBeEmpty.includes(x.table)));
  for(const p of plan){assert.ok(p.keys.every(k=>p.columns.includes(k)));assert.match(insertSql(p),/^INSERT INTO "[a-z_]+"/);assert.match(readSql(p),/^SELECT /);}
  assert.match(readSql(item,["abc"]),/"id" > \?/);
  assert.match(readSql(plan.find(x=>x.table==="edition_taxonomy_nodes"),["a","b"]),/\("edition_id","taxonomy_node_id"\) > \(\?,\?\)/);
});
test("private grant or non-Gutenberg product cannot enter projection",()=>{
  const row=item.columns.map(c=>c==="source_name"?"upload":"x");
  assert.throws(()=>validateRows(item,[row]),/Non-Gutenberg/);
  const g=plan.find(x=>x.table==="rights_grants");
  assert.throws(()=>validateRows(g,[g.columns.map(()=> "private")]),/Private grant/);
});
const gate="a".repeat(64);let writes=0;
const env={GATE:gate,TARGET:target,RUN:"12345678-1",EXPIRES:String(Date.now()+60000),SNAPSHOT:{prepare(sql){assert.match(sql,/^INSERT INTO "products"/);writes++;return{bind:()=>({run:async()=>({success:true})})};}}};
const call=(body,credential=gate,overrides={})=>worker.fetch(new Request("https://example.invalid/copy",{method:"POST",headers:{...(credential?{authorization:"Bearer "+credential}:{})},body:JSON.stringify(body)}),{...env,...overrides});
test("probe and unauthorized or expired requests never write",async()=>{
  assert.equal((await call({operation:"probe"})).status,204);
  assert.equal((await call({operation:"probe"},"")).status,401);
  assert.equal((await call({operation:"probe"},"b".repeat(64))).status,401);
  assert.equal((await call({operation:"probe"},gate,{EXPIRES:"0"})).status,403);
  assert.equal((await call({operation:"probe"},gate,{TARGET:source})).status,403);
  assert.equal((await call({operation:"copy",table:"users",rows:[["private"]]})).status,400);
  assert.equal(writes,0);
});
test("only fixed projected table and bound JSON can write",async()=>{
  const row=item.columns.map(c=>c==="source_name"?"gutenberg":"x");
  assert.equal((await call({operation:"copy",table:"products",rows:[row],sql:"DROP TABLE products"})).status,400);
  assert.equal((await call({operation:"copy",table:"products",rows:[row]})).status,204);
  assert.equal(writes,1);
});

test("complete receipt requires actual protected run and cleanup, never a skipped PR job",()=>{
  const digest="a".repeat(64);
  const receipt={run_id:"12345678",run_attempt:"1",sha:"b".repeat(40),manifest_digest:"c".repeat(64),transfer_digest:digest,products:82247,editions:82247};
  const run={id:12345678,run_attempt:1,path:".github/workflows/provision-real-catalog-snapshot.yml",head_sha:receipt.sha,event:"workflow_dispatch",head_branch:"main",conclusion:"success"};
  const job={name:"populate-isolated-snapshot",conclusion:"success",steps:[{name:"Remove isolated importer even if interrupted",conclusion:"success"}]};
  assert.equal(verifyReceipt(receipt,run,[job],digest),true);
  assert.throws(()=>verifyReceipt(receipt,{...run,event:"pull_request"},[job],digest));
  assert.throws(()=>verifyReceipt(receipt,run,[{...job,conclusion:"skipped"}],digest));
  assert.throws(()=>verifyReceipt(receipt,run,[{...job,steps:[]}],digest));
  assert.throws(()=>verifyReceipt(receipt,run,[job],"d".repeat(64)));
});

test("shared provider budget serializes different credentials and respects full reset window",async()=>{
  let now=0;const times=[],waits=[],events=[];
  const statuses=[429,200,200,200];
  const request=createProviderBudget({
    clock:()=>now,wait:async ms=>{waits.push(ms);now+=ms;},
    onBackoff:event=>events.push(event),
    fetcher:async()=>{times.push(now);return new Response(null,{status:statuses.shift(),headers:times.length===1?{"retry-after":"300"}:{}});}
  });
  await Promise.all(["source","target","control"].map(x=>request("https://example.invalid",{}, {safeRead:true,label:x})));
  assert.deepEqual(times,[0,301000,301500,302000]);
  assert.equal(events[0].kind,"429");assert.equal(waits[0],301000);
});
test("missing Retry-After conservatively waits a full window",async()=>{
  let now=0;let attempts=0;const waits=[];
  const request=createProviderBudget({clock:()=>now,wait:async ms=>{now+=ms;waits.push(ms);},fetcher:async()=>new Response(null,{status:++attempts===1?429:200})});
  assert.equal((await request("https://example.invalid",{}, {safeRead:true})).status,200);
  assert.equal(waits[0],301000);
});
test("low quota stalls next call and 5xx mutation is never blindly replayed",async()=>{
  let now=0;let attempts=0;
  const request=createProviderBudget({clock:()=>now,wait:async ms=>{now+=ms;},fetcher:async()=>new Response(null,{status:++attempts===1?200:503,headers:attempts===1?{ratelimit:'"default";r=2;t=40'}:{}})});
  await request("https://example.invalid",{}, {safeRead:true});
  assert.equal((await request("https://example.invalid",{},{})).status,503);
  assert.equal(now,41000);assert.equal(attempts,2);
  assert.equal(ratePause(new Headers({"retry-after":"7"}),0).explicit,7000);
});
test("temporary read errors retry, forbidden access does not",async()=>{
  let now=0;let calls=0;
  const request=createProviderBudget({clock:()=>now,wait:async ms=>{now+=ms;},fetcher:async()=>new Response(null,{status:++calls===1?503:403})});
  assert.equal((await request("https://example.invalid",{}, {safeRead:true})).status,403);
  assert.equal(calls,2);assert.ok(now>=1000);
});
test("complete page is reused only after exact independent comparison",async()=>{
  const data=[["a",1],["b",2]];let writes=0;
  const result=await reconcilePage(data,{readTarget:async()=>structuredClone(data),write:async()=>{writes++;},checkExisting:true});
  assert.equal(result.reused,true);assert.equal(writes,0);
});
test("partial page repaired and reread; stale readback rejected",async()=>{
  const data=[["a",1],["b",2]];let stored=[["a",1]],writes=0,reads=0;
  const result=await reconcilePage(data,{readTarget:async()=>{reads++;return stored;},write:async rows=>{writes++;stored=structuredClone(rows);},checkExisting:true});
  assert.equal(result.reused,false);assert.equal(writes,1);assert.equal(reads,2);
  await assert.rejects(reconcilePage(data,{readTarget:async()=>[["a",9]],write:async()=>{},checkExisting:false}),/page parity failed/);
});
test("narrow pages widened while wide metadata stays bounded",()=>{
  assert.equal(pageLimit(item),2800);assert.match(readSql(item),/LIMIT 2800$/);
  const works=plan.find(x=>x.table==="works");
  assert.equal(pageLimit(works),700);assert.match(readSql(works),/LIMIT 700$/);
  assert.throws(()=>readSql(works,null,false,2800),/Invalid page limit/);
});
