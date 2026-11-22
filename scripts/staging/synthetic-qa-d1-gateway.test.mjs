/* eslint-disable prettier/prettier -- Exercise synthetic-only bearer D1 control-plane isolation. */
import assert from "node:assert/strict";
import {test} from "node:test";
import gateway from "./synthetic-qa-d1-gateway.worker.mjs";
const secret="a".repeat(64);
const env={COVE_QA_D1_GATE_ALLOWED:"paid",COVE_QA_D1_GATE:secret,
  COVE_QA_D1_GATE_EXPIRES_AT:String(Date.now()+12*60_000),
  QA_PRIMARY_DB:{prepare(sql){return {bind(...params){return {
    all:async()=>({results:[{sql,params}],meta:{changes:0}}),
    run:async()=>({results:[],meta:{changes:1}})
  }}}}},
  QA_SCHEMA_DB:{prepare(sql){return {bind(...params){return {all:async()=>({results:[{sql,params}]}),run:async()=>({meta:{changes:1}})}}}}}};
const req=(path,body,token=secret)=>new Request("https://temporary-qa.workers.dev"+path,{
  method:body?"POST":"GET",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
  ...(body?{body:JSON.stringify(body)}:{})
});
test("deny forged token and expired gateway before D1 access",async()=>{
  assert.equal((await gateway.fetch(req("/__health",null,"bad"),env)).status,401);
  assert.equal((await gateway.fetch(req("/__health"),{...env,COVE_QA_D1_GATE_EXPIRES_AT:String(Date.now()-1)})).status,503);
});
test("only private query endpoint and paid/schema fixtures can be used",async()=>{
  const good=await gateway.fetch(req("/__query",{database:"qa",sql:"SELECT id FROM orders",params:[]}),env);
  assert.equal(good.status,200);
  assert.equal((await good.json()).result[0].results[0].sql,"SELECT id FROM orders");
  const ddl=await gateway.fetch(req("/__query",{database:"qa",sql:"CREATE TABLE t(id TEXT)",params:[]}),env);
  assert.equal((await ddl.json()).result[0].meta.changes,1);
  const source=await gateway.fetch(req("/__query",{database:"schema",sql:"PRAGMA table_info(foo)",params:[]}),env);
  assert.equal(source.status,200);
  assert.equal((await gateway.fetch(req("/__query",{database:"schema",sql:"SELECT 1",params:[]}),{...env,COVE_QA_D1_GATE_ALLOWED:"legal"})).status,400);
  assert.equal((await gateway.fetch(req("/__query",{database:"prod",sql:"DELETE FROM orders",params:[]}),env)).status,400);
  assert.equal((await gateway.fetch(req("/__query",{database:"qa",sql:"ATTACH DATABASE 'x' AS production",params:[]}),env)).status,400);
  assert.equal((await gateway.fetch(req("/__query?inspect=true",{database:"qa",sql:"SELECT 1",params:[]}),env)).status,404);
});
