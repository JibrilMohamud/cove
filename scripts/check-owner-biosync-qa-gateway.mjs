/* eslint-disable prettier/prettier -- Security properties of the isolated QA-only HTTP facade. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const folder=mkdtempSync(join(tmpdir(),"cove-biosync-qa-gw-"));
try{
  const outfile=join(folder,"gateway.mjs");
  await build({entryPoints:["infra/biosync-owner-qa-gateway.worker.ts"],
    bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent",outfile});
  const {default:gateway}=await import(pathToFileURL(outfile).href);
  const clientSecret="a".repeat(64),ownerSecret="b".repeat(64);
  const data={editionId:"pg-19504",trackId:"02",
    jobId:"align-pg-19504-02-7fb5b7e4c4a400b1",mapSha256:"c".repeat(64)};
  const ack={schema:"cove.owner-biosync-checked-publication.v1",...data,committed:true,replay:false};
  const calls=[],ownerReadProbes=[];
  const owner={async fetch(req){
    if(req.method==="GET"){
      ownerReadProbes.push({url:req.url,method:req.method,authorization:req.headers.get("authorization")});
      return new Response(null,{status:405,headers:{"cache-control":"no-store"}});
    }
    calls.push({url:req.url,method:req.method,authorization:req.headers.get("authorization"),body:await req.json()});
    return Response.json(ack);
  }};
  const env=()=>({
    COVE_BIOSYNC_QA_GATEWAY_ENABLED:"1",
    COVE_BIOSYNC_QA_PRIMARY_ID:"4e17ba6f-444f-4245-801a-a7d4969045b0",
    COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT:String(Date.now()+300_000),
    COVE_BIOSYNC_QA_CLIENT_SECRET:clientSecret,
    COVE_RIGHTS_OWNER_SECRET:ownerSecret,
    LEGAL_AUTHORITY:owner
  });
  const qaHost="cove-biosync-gateway-qa-45104567891-1.cove-qa-reads.workers.dev";
  const req=(body=data,{secret=clientSecret,method="POST",path="/biosync/publish-checked",type="application/json",host=qaHost,scheme="https"}={})=>
    new Request(scheme+"://"+host+path,{
      method,headers:{"authorization":"Bearer "+secret,"content-type":type},
      ...(method==="POST"?{body:JSON.stringify(body)}:{})
    });
  const ok=await gateway.fetch(req(),env());
  assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),ack);
  assert.equal(ok.headers.get("cache-control"),"no-store");
  assert.deepEqual(calls,[{
    url:"https://legal-authority.internal/biosync/publish-checked",
    method:"POST",authorization:"Bearer "+ownerSecret,body:data
  }]);
  const probe=()=>req({}, {path:"/qa/owner-bound-ready"});
  const readiness=await gateway.fetch(probe(),env());
  assert.equal(readiness.status,200);
  assert.deepEqual(await readiness.json(),{
    schema:"cove.qa.biosync-owner-binding-readiness.v1"
  });
  assert.equal(readiness.headers.get("cache-control"),"no-store");
  assert.deepEqual(ownerReadProbes,[{
    url:"https://legal-authority.internal/biosync/publish-checked",
    method:"GET",authorization:"Bearer "+ownerSecret
  }]);
  assert.equal(calls.length,1,"A read-only owner binding probe must not commit a map");
  let denies=0;
  async function blocked(request,environment,status){
    const before=calls.length,probeBefore=ownerReadProbes.length;
    const response=await gateway.fetch(request,environment);
    assert.equal(response.status,status);
    assert.equal(calls.length,before,"Rejected request must not reach owner publication");
    assert.equal(ownerReadProbes.length,probeBefore,
      "Rejected request must not invoke private owner even by GET");
    denies++;
  }
  await blocked(req(data,{host:"api.covereads.com"}),env(),404);
  await blocked(req(data,{host:"cove-persistence-backend.cove-qa-reads.workers.dev"}),env(),404);
  await blocked(req(data,{host:"cove-biosync-gateway-qa-45104567891-1.preview.workers.dev"}),env(),404);
  await blocked(req(data,{host:"cove-biosync-gateway-qa-45104567891-1.cove-qa-reads.workers.dev:8443"}),env(),404);
  await blocked(req(data,{scheme:"http"}),env(),404);
  await blocked(req(data,{path:"/other"}),env(),404);
  await blocked(req(data,{path:"/qa/owner-bound-ready?sql=SELECT"}),env(),404);
  await blocked(req(data,{path:"/qa/owner-bound-ready"}),env(),400);
  await blocked(req({}, {path:"/qa/owner-bound-ready",secret:"bad"}),env(),401);
  await blocked(req({}, {path:"/qa/owner-bound-ready",method:"GET"}),env(),405);
  await blocked(req({}, {path:"/qa/owner-bound-ready",host:"api.covereads.com"}),env(),404);
  await blocked(req({}, {path:"/qa/owner-bound-ready"}),{...env(),DB:{}},503);
  await blocked(req({}, {path:"/qa/owner-bound-ready"}),
    {...env(),COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT:String(Date.now()-1)},503);
  await blocked(req(data,{path:"/biosync/publish-checked?sql=UPDATE"}),env(),404);
  await blocked(req(data,{method:"GET"}),env(),405);
  await blocked(req(data,{secret:"d".repeat(64)}),env(),401);
  await blocked(req(data,{type:"text/plain"}),env(),415);
  await blocked(req(),{...env(),COVE_BIOSYNC_QA_GATEWAY_ENABLED:"0"},503);
  await blocked(req(),{...env(),COVE_BIOSYNC_QA_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},503);
  await blocked(req(),{...env(),COVE_BIOSYNC_QA_PRIMARY_ID:"969f1ea0-5f57-4f3a-aa25-9c74e58f5af3"},503);
  await blocked(req(),{...env(),COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT:String(Date.now()-1000)},503);
  await blocked(req(),{...env(),COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT:String(Date.now()+60*60*1000)},503);
  await blocked(req(),{...env(),DB:{prepare(){throw Error("never")}}},503);
  await blocked(req(),{...env(),PRIMARY_DB:{prepare(){throw Error("never")}}},503);
  await blocked(req(),{...env(),UNEXPECTED_D1:{prepare(){throw Error("never")}}},503);
  await blocked(req(),{...env(),LEGAL_AUTHORITY:undefined},503);
  await blocked(req(),{...env(),COVE_RIGHTS_OWNER_SECRET:"wrong"},503);
  await blocked(req(data,{secret:"bad"}),env(),401);
  const badInput=await gateway.fetch(req({...data,sql:"UPDATE entitlements SET status='active'"}),env());
  assert.equal(badInput.status,503,"Raw SQL must never reach the owner");
  assert.equal(calls.length,1);
  for(const [response,label] of [
    [new Response(null,{status:503}),"outage"],
    [new Response(null,{status:404}),"binding missing"],
    [Response.json({schema:"cove.qa.biosync-owner-binding-readiness.v1"}),"forged ack"],
    [new Response(null,{status:405}),"forged no-store"]
  ]){
    const before=calls.length;
    const result=await gateway.fetch(probe(),{...env(),LEGAL_AUTHORITY:{
      async fetch(req){
        assert.equal(req.method,"GET");
        assert.equal(req.headers.get("authorization"),"Bearer "+ownerSecret);
        return response.clone();
      }
    }});
    assert.equal(result.status,503,label+" must fail closed");
    assert.equal(calls.length,before,label+" must not execute a publication");
  }
  const down=await gateway.fetch(req(),{...env(),LEGAL_AUTHORITY:{async fetch(){return new Response(null,{status:503})}}});
  assert.equal(down.status,503,"Owner outage must fail closed");
  const forged=await gateway.fetch(req(),{...env(),LEGAL_AUTHORITY:{async fetch(){return Response.json({...ack,committed:false})}}});
  assert.equal(forged.status,503,"A forged owner ACK must fail closed");
  console.log("PASS: isolated QA owner gateway authenticates, validates, bounds lease, refuses any direct D1 binding/production primary and fails closed on "+denies+" rejected cases, injection and owner outage.");
}finally{rmSync(folder,{recursive:true,force:true});}
