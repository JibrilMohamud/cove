/* eslint-disable prettier/prettier -- Public account facades forward fixed commands and cannot mutate local D1. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-account-routing-"));
try{
 const file=join(folder,"client.mjs");await build({stdin:{contents:`export {registerDevice,revokeDevice,processAccountDeletionQueue} from "./src/features/fore/account-management.server";
 export {bindPublicationOwner} from "./src/storefront-strangler/publication-owner-routing.server";`,resolveDir:resolve("."),loader:"ts"},outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const client=await import(pathToFileURL(file).href),raw={prepare(){throw Error("forbidden_local_sql");},batch(){throw Error("forbidden_local_batch");}};
 let forge=false,outage=false;const seen=[],port={async fetch(request){
  if(outage)throw Error("owner_outage");assert.equal(new URL(request.url).pathname,"/account/private-action");
  const cmd=await request.json();seen.push(cmd);
  const result=cmd.action==="register-device"?{id:"device_qa",name:cmd.device.name,platform:cmd.device.platform}:cmd.action==="revoke-device"?{revoked:true}:{processed:0,completed:0,blocked:0,retrying:0};
  return Response.json({schema:"cove.private-account-qa.v1",ownerFirst:true,action:cmd.action,userId:forge?"other_user":cmd.userId??null,result});
 }};
 const db=client.bindPublicationOwner(raw,{owner:port,secret:"a".repeat(64),territory:"US",currency:"USD"}),user="sb:00000000-0000-4000-8000-000000000001",device={deviceKey:"public_device_key_qa",name:"Reader",platform:"reader"};
 const req=new Request("https://cove.test/account/devices",{headers:{cookie:"private_session_never_forwarded"}});
 await assert.rejects(client.registerDevice(raw,user,req,device),/private account owner/);
 assert.equal((await client.registerDevice(db,user,req,device)).id,"device_qa");
 assert.equal((await client.revokeDevice(db,user,"device_qa",req)).revoked,true);
 assert.equal((await client.processAccountDeletionQueue({DB:db},5)).processed,0);
 assert.deepEqual(seen[2],{action:"erasure-tick",limit:5});
 assert.ok(!JSON.stringify(seen).includes("private_session_never_forwarded"));
 forge=true;await assert.rejects(client.registerDevice(db,user,req,device),/canonical_command_receipt_mismatch/);
 forge=false;outage=true;await assert.rejects(client.revokeDevice(db,user,"device_qa",req),/owner_outage/);
 console.log("PASS: account API/cron facades reject unbound D1, forward fixed commands and Supabase app IDs, bind receipts and do not forward cookies");
}finally{rmSync(folder,{recursive:true,force:true});}
