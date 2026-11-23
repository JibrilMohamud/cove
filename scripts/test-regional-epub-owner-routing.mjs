/* eslint-disable prettier/prettier -- Fixed private repair commands cannot select SQL, R2 keys or an arbitrary source. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-regional-owner-route-"));
try{
 const file=join(folder,"caller.mjs");await build({stdin:{contents:`export {repairRegionalEpubAssets} from "./src/features/fore/regional-epub-asset-repair.server";
 export {ensurePublishingLifecycle} from "./src/features/fore/publishing.server";
 export {bindPublicationOwner} from "./src/storefront-strangler/publication-owner-routing.server";`,resolveDir:resolve("."),loader:"ts"},outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const client=await import(pathToFileURL(file).href);let forged=false,offline=false;const seen=[];
 const raw={prepare(){throw Error("Shared repair attempted D1 access");},batch(){throw Error("Shared repair attempted D1 mutation");}};
 const db=client.bindPublicationOwner(raw,{secret:"a".repeat(64),territory:"AU",currency:"AUD",owner:{async fetch(request){
  if(offline)throw Error("private_owner_outage");assert.equal(new URL(request.url).pathname,"/catalog/repair-regional-assets");
  const input=await request.json();seen.push(input);return Response.json({schema:"cove.private-regional-epub-repair.v1",ownerFirst:true,after:forged?"wrong":input.after,limit:input.limit,
   result:{scanned:1,repaired:1,missingOrMismatched:0,conflicts:0,nextAfter:"pgau_123",maybeMore:false}});
 }}});
 const bucket={head(){throw Error("Caller-owned R2 must not be trusted");},get(){throw Error("Caller-owned R2 must not be used");}};
 await assert.rejects(client.repairRegionalEpubAssets({DB:raw,BUCKET:bucket}),/private canonical owner/);
 assert.equal((await client.repairRegionalEpubAssets({DB:db,BUCKET:bucket},{after:"",limit:2})).repaired,1);
 assert.deepEqual(seen,[{after:"",limit:2}]);
 await assert.rejects(client.repairRegionalEpubAssets({DB:db},{after:"';DROP"}),/Invalid regional asset repair cursor/);
 forged=true;await assert.rejects(client.repairRegionalEpubAssets({DB:db}),/canonical_command_receipt_mismatch/);
 forged=false;offline=true;await assert.rejects(client.repairRegionalEpubAssets({DB:db}),/private_owner_outage/);
 let reads=0;const readOnly={prepare(sql){assert.match(sql,/^SELECT /);reads++;return {bind(){return this;},async first(){return {id:"lifecycle_existing",state:"live"};}};},batch(){throw Error("Public lifecycle lookup attempted creation");}};
 assert.equal((await client.ensurePublishingLifecycle(readOnly,"edition_qa")).id,"lifecycle_existing");assert.equal(reads,1);
 await assert.rejects(client.ensurePublishingLifecycle({prepare(){return {bind(){return this;},async first(){return null;}};}},"edition_missing"),/creation requires its private owner/);
 console.log("PASS: public regional repair uses only owner cursor/limit and exact receipts; caller R2 ignored, outage denied, and shared lifecycle lookup cannot create records");
}finally{rmSync(folder,{recursive:true,force:true});}
