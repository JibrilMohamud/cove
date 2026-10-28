/* eslint-disable prettier/prettier -- Functional owner-first admin RPC safety tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cove-owner-admin-"));
try{
  const out=path.join(dir,"legal-admin.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-admin-owner-commands.server.ts"],
    outfile:out,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const {executeStageCanonicalAdminCommand:run,executeStageRightsEditorSuspension:editor}=await import(pathToFileURL(out).href);
  const secret="a".repeat(64),messages=[];
  let status=200,override=null,unavailable=false;
  const responses={
    "/commercial/suspend-grant":{suspended:true,subject:"grant",subjectId:"right_123",ownerDenied:true},
    "/quarantine":{quarantined:true,sourceId:"2701"},
    "/evidence/revoke":{evidenceRevoked:true,sourceId:"2702",evidenceId:"gre_2702_us",territory:"US"},
    "/source/retract-batch":{retracted:2,sourceIds:["2703","2704"]},
    "/commercial/suspend-contract":{suspended:true,subject:"contract",subjectId:"rcontract_123",ownerDenied:true},
    "/commercial/retail/withdraw":{withdrawn:true,ownerEpoch:4},
    "/commercial/retail/publish-verified":{published:true,ownerEpoch:5},
    "/market/withdraw":{marketWithdrawn:true,territory:"US"},
    "/commercial/entitlement/revoke":{revoked:true,epoch:6},
  };
  const env={
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_QUARANTINE_WRITER_STAGE:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_LEGAL_QUARANTINE_SECRET:secret,
    LEGAL_QUARANTINE_WRITER:{
      async fetch(request){
        if(unavailable)throw Error("private_writer_down");
        assert.equal(request.method,"POST");
        assert.equal(request.headers.get("authorization"),"Bearer "+secret);
        assert.equal(request.headers.get("content-type"),"application/json");
        assert.equal(new URL(request.url).host,"legal-quarantine.internal");
        const payload=await request.json();
        const route=new URL(request.url).pathname;
        assert.ok(route in responses,route);
        messages.push({route,payload});
        return Response.json(override??responses[route],{status});
      }
    }
  };
  const operations=[
    {action:"suspend-grant",targetId:"right_123",operationId:"suspend:grant:1"},
    {action:"quarantine-source",sourceId:"2701",operationId:"source:1",message:"Confirmed unlicensed source"},
    {action:"revoke-source-evidence",sourceId:"2702",evidenceId:"gre_2702_us",territory:"US",operationId:"evidence:1"},
    {action:"retract-sources",operations:[{sourceId:"2703",operationId:"retract:3"},{sourceId:"2704",operationId:"retract:4"}]},
    {action:"suspend-contract",targetId:"rcontract_123",operationId:"suspend:contract:1"},
    {action:"withdraw-retail",productId:"prd_commercial_123",operationId:"retail:1"},
    {action:"publish-retail",productId:"prd_commercial_123",territory:"US",currency:"USD",operationId:"retail:2"},
    {action:"pause-market",territory:"US",operationId:"market:1"},
    {action:"revoke-entitlement",entitlementId:"entitle_123",operationId:"entitlement:1"},
  ];
  for(const x of operations){
    const result=await run(env,x);
    assert.equal(result.action,x.action);
    assert.equal(result.ownerFirst,true);
    assert.deepEqual(messages.at(-1).payload,x,"No user fields may be injected by the API adapter");
  }
  assert.equal(messages.length,operations.length);
  const rightsGrant=await editor(env,"grant",{ownerAction:"suspend",id:"right_123",status:"suspended",operationId:"editor:grant:1"});
  assert.equal(rightsGrant.ownerFirst,true);
  assert.equal(messages.at(-1).route,"/commercial/suspend-grant");
  const rightsContract=await editor(env,"contract",{ownerAction:"suspend",id:"rcontract_123",status:"suspended",operationId:"editor:contract:1"});
  assert.equal(rightsContract.ownerFirst,true);
  assert.equal(messages.at(-1).route,"/commercial/suspend-contract");
  await assert.rejects(()=>editor(env,"grant",{ownerAction:"suspend",id:"right_123",status:"active",operationId:"edit:invalid"}));
  await assert.rejects(()=>editor(env,"contract",{ownerAction:"suspend",id:"rcontract_123",status:"suspended",name:"unverified",operationId:"edit:invalid"}));
  const called=messages.length;
  for(const e of [
    {...env,COVE_SSR_STAGING:"0"},
    {...env,COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},
    {...env,COVE_LEGAL_QUARANTINE_WRITER_STAGE:"0"},
    {...env,COVE_LEGAL_WRITER_PRIMARY_ID:"production-db"},
    {...env,COVE_LEGAL_QUARANTINE_SECRET:""},
    {...env,LEGAL_QUARANTINE_WRITER:undefined},
  ])await assert.rejects(()=>run(e,operations[0]),/Owner-first canonical writer is not configured/);
  assert.equal(messages.length,called,"Misconfigured stage must never call a writer");
  for(const invalid of [
    {...operations[0],targetId:"other/grant"},
    {...operations[1],sourceId:"2701;DROP TABLE rights_grants"},
    {...operations[1],message:"X".repeat(501)},
    {...operations[2],evidenceId:"wrong evidence"},
    {...operations[2],territory:"*"},
    {...operations[3],operations:[{sourceId:"2703",operationId:"x"},{sourceId:"2703",operationId:"y"}]},
    {...operations[3],operations:Array.from({length:26},(_,i)=>({sourceId:String(2000+i),operationId:"x:"+i}))},
    {...operations[0],operationId:""},
    {...operations[2],productId:"prd_gutenberg_123"},
    {...operations[2],extra:"raw SQL"},
    {...operations[3],currency:"usd"},
    {...operations[4],territory:"*"},
    {action:"execute-sql",statement:"UPDATE rights_grants SET status='active'"},
  ])await assert.rejects(()=>run(env,invalid));
  assert.equal(messages.length,called,"Invalid scope must never reach private writer");
  status=503;
  await assert.rejects(()=>run(env,operations[0]),/was not acknowledged/);
  status=200;
  unavailable=true;
  await assert.rejects(()=>run(env,operations[0]),/was not acknowledged/);
  unavailable=false;
  override={suspended:true,subject:"contract",subjectId:"right_123",ownerDenied:true};
  await assert.rejects(()=>run(env,operations[0]),/does not match the request/);
  override={withdrawn:true,ownerEpoch:-1};
  await assert.rejects(()=>run(env,operations[2]),/does not match the request/);
  override={quarantined:true,sourceId:"2702"};
  await assert.rejects(()=>run(env,operations[1]),/does not match the request/);
  override={evidenceRevoked:true,sourceId:"2702",evidenceId:"gre_wrong",territory:"US"};
  await assert.rejects(()=>run(env,operations[2]),/does not match the request/);
  override={retracted:2,sourceIds:["2703","other"]};
  await assert.rejects(()=>run(env,operations[3]),/does not match the request/);
  override=null;
  console.log("PASS: admin owner-first source quarantine, territory-scoped evidence and atomic batch retraction; rights-editor suspension, retail, market and paid-entitlement revocation; exact receipts, production disabled, no raw-D1 fallback");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
