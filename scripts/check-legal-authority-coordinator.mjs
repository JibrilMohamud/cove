/* eslint-disable prettier/prettier -- Simulates crash/timeout points across two distinct stores. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cove-deny-before-primary-"));
try{
  const file=path.join(folder,"writer.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority-coordinator.ts"],
    outfile:file,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {denyBeforePrimaryMutation,publishAfterPrimaryApproval}=await import(pathToFileURL(file).href);
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...args){
    const stmt=db.prepare(statement);
    const rows=/^\s*SELECT\b/i.test(statement)?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const corefile=path.join(folder,"core.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority-core.ts"],
    outfile:corefile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {applyAuthorityCommand,readAuthority,createAuthoritySchema}=await import(pathToFileURL(corefile).href);
  createAuthoritySchema(sql);
  const secret="a".repeat(64);
  let primaryActive=true;
  let primaryCalls=0;
  let permitPositive=false;
  const authority={async fetch(req){
    if(req.headers.get("authorization")!=="Bearer "+secret) return new Response(null,{status:401});
    const cmd=await req.json();
    if(new URL(req.url).pathname==="/publish-allow"&&!permitPositive)
      return new Response(null,{status:409});
    const result=applyAuthorityCommand(sql,cmd);
    return Response.json(result,{status:result.applied?200:409});
  }};
  const input=(revision,action)=>({sourceId:"2701",territory:"US",revision,action});
  const mutation=async()=>{
    primaryCalls++;
    primaryActive=false;
    return "withdrawn";
  };
  await assert.rejects(()=>denyBeforePrimaryMutation({
    async fetch(){throw Error("link-down");}
  },secret,input(1,"deny"),mutation),/link-down/);
  assert.equal(primaryCalls,0,"No primary legal mutation before owner ACK");
  assert.equal(primaryActive,true);
  assert.equal(await denyBeforePrimaryMutation(authority,secret,input(2,"deny"),mutation),"withdrawn");
  assert.equal(primaryCalls,1);
  assert.deepEqual(readAuthority(sql,"2701","US"),{allowed:false,revision:2});
  await assert.rejects(()=>denyBeforePrimaryMutation(authority,secret,input(3,"deny"),
    async()=>{throw Error("primary crashed after durable denial");}),/primary crashed/);
  assert.equal(readAuthority(sql,"2701","US").allowed,false,
    "Primary failure must not roll back acknowledged denial");
  await assert.rejects(()=>publishAfterPrimaryApproval(authority,secret,input(4,"allow"),"USD",
    async()=>{permitPositive=false;return "canonical proof written";}),/authority_fence_unavailable/);
  assert.equal(readAuthority(sql,"2701","US").allowed,false,
    "A committed primary grant is not automatically a serving allowance");
  const positive=await publishAfterPrimaryApproval(authority,secret,input(5,"allow"),"USD",
    async()=>{primaryActive=true;permitPositive=true;return "approved";});
  assert.equal(positive,"approved");
  assert.equal(readAuthority(sql,"2701","US").allowed,true);
  const before=primaryCalls;
  await assert.rejects(()=>denyBeforePrimaryMutation(authority,secret,input(4,"deny"),mutation),
    /authority_fence_unavailable/);
  assert.equal(primaryCalls,before,
    "Stale deny cannot trigger a legal DB write based on a false ACK");
  await denyBeforePrimaryMutation(authority,secret,input(6,"deny"),mutation);
  assert.equal(readAuthority(sql,"2701","US").allowed,false);
  await assert.rejects(()=>publishAfterPrimaryApproval(authority,secret,input(5,"allow"),"USD",
    async()=>{permitPositive=true;return "stale";}),/authority_fence_unavailable/);
  assert.equal(readAuthority(sql,"2701","US").allowed,false);
  db.close();
  console.log("PASS: durable denial precedes primary writes, failure stays denied, positive publication last, stale/failed ACK rejects");
}finally{fs.rmSync(folder,{recursive:true,force:true});}
