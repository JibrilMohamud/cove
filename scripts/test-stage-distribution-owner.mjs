/* eslint-disable prettier/prettier -- Exact negative-owner ordering and adversarial QA-only command tests. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const dir=mkdtempSync(join(tmpdir(),"cove-distribution-writer-"));
try {
  const file=join(dir,"writer.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-quarantine-qa.writer.ts"],
    outfile:file,bundle:true,format:"esm",platform:"node",target:"node22",
    logLevel:"silent"});
  const {default:worker}=await import(pathToFileURL(file).href);
  const writerSecret="a".repeat(64),ownerSecret="b".repeat(64);
  const id="pv_qa_1234",productId="prd_commercial_1234";
  const state={control:"distributable",grants:2,events:new Set(),epoch:0,mutations:0};
  let ownerEnabled=true,ownerReceiptValid=true,batchFails=false,wrongPublication=false;
  const trace=[];
  const db={
    prepare(sql){
      let args=[];
      const statement={
        bind(...a){args=a;return statement;},
        async first(){
          if(sql.includes("JOIN publishing_publications")){
            trace.push("read:version");
            return wrongPublication?{id,product_id:"prd_gutenberg_1234"}:
              {id,product_id:productId};
          }
          if(sql.includes("SELECT distribution_status")){
            trace.push("read:prior");
            return {distribution_status:state.control};
          }
          throw Error("unexpected_primary_read");
        },
        async run(){throw Error("No direct raw mutation outside fenced batch");}
      };
      statement._sql=sql;statement._args=()=>args;return statement;
    },
    async batch(statements){
      trace.push("batch");
      if(batchFails)throw Error("primary_d1_unavailable");
      assert.equal(statements.length,3);
      assert.equal(statements[0]._args()[0],id);
      assert.equal(statements[1]._args()[1],id);
      assert.equal(statements[2]._args()[2],id);
      assert.equal(statements[2]._args()[0].endsWith("Z"),true);
      for(const s of statements){
        assert.ok(/^(?:INSERT|UPDATE) /.test(s._sql));
      }
      state.control=state.control==="recalled"?"recalled":statements[0]._args()[1];
      const event=statements[1]._args()[0];
      if(!state.events.has(event))state.events.add(event);
      state.grants=0;state.mutations++;
      return [{success:true},{success:true},{success:true}];
    }
  };
  const owner={
    async fetch(req){
      trace.push("owner");
      assert.equal(new URL(req.url).pathname,"/commercial/deny-next");
      assert.equal(req.headers.get("authorization"),"Bearer "+ownerSecret);
      assert.equal(req.headers.get("content-type"),"application/json");
      assert.equal(req.method,"POST");
      const body=await req.json();
      assert.equal(body.productId,productId);
      assert.match(body.operationId,/^distribution:dist:[a-z0-9]+$/);
      if(!ownerEnabled)return new Response(null,{status:503});
      state.epoch++;
      return Response.json(ownerReceiptValid?
        {applied:true,epoch:state.epoch}:{applied:true,epoch:-1});
    }
  };
  const env={
    PRIMARY_DB:db,LEGAL_PRIVATE:owner,
    COVE_LEGAL_WRITER_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_LEGAL_WRITER_EXPIRES_AT:String(Date.now()+600000),
    COVE_LEGAL_WRITER_SECRET:writerSecret,COVE_RIGHTS_OWNER_SECRET:ownerSecret
  };
  const command=(operationId="dist:one",status="blocked")=>({
    action:"withdraw-distribution",publicationVersionId:id,status,
    allowExistingOwners:false,reasonCode:"LICENSE_RECALLED",reasonDetail:"Rightsholder withdrawal",
    actorUserId:"staff_123",operationId
  });
  const call=async(payload=command(),headers={})=>worker.fetch(
    new Request("https://private-qa.invalid/commercial/distribution/withdraw",{
      method:"POST",
      headers:{"content-type":"application/json","authorization":"Bearer "+writerSecret,...headers},
      body:JSON.stringify(payload)}),env);
  const denied=await call(command(),"authorization" in {}?{}:{authorization:"Bearer wrong"});
  assert.equal(denied.status,401);
  assert.deepEqual(trace,[]);
  for(const patch of [
    {COVE_LEGAL_WRITER_ENABLED:"0"},{COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_LEGAL_WRITER_EXPIRES_AT:"0"},{COVE_LEGAL_WRITER_SECRET:"wrong"},
    {COVE_RIGHTS_OWNER_SECRET:"wrong"}
  ]){
    const result=await worker.fetch(new Request("https://private-qa.invalid/commercial/distribution/withdraw",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+writerSecret},
      body:JSON.stringify(command())
    }),{...env,...patch});
    assert.equal(result.status,503);
  }
  assert.deepEqual(trace,[]);
  for(const invalid of [
    {...command(),status:"distributable"},{...command(),status:"owner_only"},
    {...command(),allowExistingOwners:true},
    {...command(),reasonCode:""},
    {...command(),actorUserId:"anonymous"},
    {...command(),publicationVersionId:"pv_123;DROP TABLE"},
    {...command(),extra:"injected"},
    {...command(),reasonDetail:"x".repeat(2001)}
  ]){
    const res=await call(invalid);
    assert.equal(res.status,400,"invalid request must not reach D1/owner");
  }
  assert.deepEqual(trace,[]);
  wrongPublication=true;
  assert.equal((await call()).status,503);
  assert.deepEqual(trace,["read:version"]);
  trace.length=0;wrongPublication=false;
  ownerEnabled=false;
  assert.equal((await call()).status,503);
  assert.deepEqual(trace,["read:version","owner"]);
  assert.equal(state.mutations,0);
  trace.length=0;ownerEnabled=true;ownerReceiptValid=false;
  assert.equal((await call()).status,503);
  assert.deepEqual(trace,["read:version","owner"]);
  assert.equal(state.mutations,0);
  trace.length=0;ownerReceiptValid=true;batchFails=true;
  assert.equal((await call()).status,503);
  assert.deepEqual(trace,["read:version","owner","read:prior","batch"]);
  assert.equal(state.mutations,0,
    "Owner denial persists even when primary D1 transaction fails; no primary write commits");
  trace.length=0;batchFails=false;
  const good=await call();
  assert.equal(good.status,200);
  assert.deepEqual(trace,["read:version","owner","read:prior","batch"]);
  const first=await good.json();
  assert.equal(first.ownerDenied,true);assert.equal(first.withdrawn,true);
  assert.equal(first.publicationVersionId,id);assert.equal(first.status,"blocked");
  assert.ok(Number.isSafeInteger(first.ownerEpoch));
  assert.equal(state.grants,0);assert.equal(state.events.size,1);
  trace.length=0;
  const replay=await call();
  assert.equal(replay.status,200);
  assert.equal(state.events.size,1,"immutable operation must not duplicate audit events");
  const recalled=await call(command("dist:two","recalled"));
  assert.equal(recalled.status,200);
  assert.equal(state.control,"recalled");
  await call(command("dist:one","blocked"));
  assert.equal(state.control,"recalled","stale blocked event never downgrades a recall");
  assert.equal(state.events.size,2);
  console.log("PASS: synthetic distribution withdrawal validates exact scope, keeps production off, denies owner outages/invalid receipts, tombstones before atomic D1 mutation, preserves recall monotonicity and event idempotence");
}finally {rmSync(dir,{recursive:true,force:true});}
