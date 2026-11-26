/* eslint-disable prettier/prettier -- Exercise the fixed snapshot SQL and admission boundary. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {source,target,plan,mustBeEmpty,insertSql,readSql,validateRows} from "./real-catalog-copy-plan.mjs";
import worker from "./real-catalog-copy.worker.mjs";
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
