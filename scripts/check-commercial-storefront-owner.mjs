/* eslint-disable prettier/prettier -- Paid storefront rights, offer and withdrawal regression. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const dir=mkdtempSync(path.join(os.tmpdir(),"cove-commercial-owner-"));
try{
 const moduleFrom=async(file,out)=>{
   const dest=path.join(dir,out+".mjs");
   await build({entryPoints:[file],outfile:dest,bundle:true,format:"esm",
     platform:"node",target:"node22",logLevel:"silent"});
   return import(pathToFileURL(dest).href);
 };
 const free=await moduleFrom("src/storefront-strangler/legal-authority-core.ts","free");
 const rights=await moduleFrom("src/storefront-strangler/commercial-legal-core.ts","rights");
 const owner=await moduleFrom("src/storefront-strangler/commercial-storefront-authority.ts","paid");
 const client=await moduleFrom("src/storefront-strangler/legal-authority-read.server.ts","client");
 const db=new DatabaseSync(":memory:");
 const sql={exec(statement,...args){
   const q=db.prepare(statement);
   const rows=/^\s*SELECT\b/i.test(statement)?q.all(...args):(q.run(...args),[]);
   return {toArray:()=>rows};
 }};
 free.createAuthoritySchema(sql);
 free.createAuthorityProofSchema(sql);
 rights.createCommercialAuthoritySchema(sql);
 owner.createCommercialStorefrontSchema(sql);
 const now=Date.now();
 const productId="prd_paid_book_001",editionId="ed_paid_book_001";
 const commercial={productId,editionId,territory:"US",channel:"retail",
   grantId:"grant_paid_book_001",contractId:"contract_paid_book_001",
   contractVersionId:"contract_paid_book_version_001",
   validUntil:new Date(now+900000).toISOString()};
 const price=(amount)=>JSON.stringify({type:"retail",currency:"USD",amountMinor:amount});
 const proof={product_id:productId,edition_id:editionId,territory:"US",currency:"USD",
   rights_epoch:1,grant_id:commercial.grantId,contract_id:commercial.contractId,
   contract_version_id:commercial.contractVersionId,offer_json:price(599),
   valid_until:new Date(now+120000).toISOString(),product_public_id:"paid_book_public",
   edition_public_id:"paid_edition_public"};
 assert.deepEqual(owner.readCommercialStorefront(sql,[productId],"US","USD"),[],
   "No canonical legal owner proof means no paid homepage");
 assert.throws(()=>owner.publishCommercialStorefront(sql,proof),
   /commercial_storefront_owner_proof_changed/);
 assert.deepEqual(rights.publishFreshCommercialProof(sql,commercial,0),{applied:true,epoch:1});
 assert.deepEqual(owner.publishCommercialStorefront(sql,proof),{applied:true,epoch:1});
 assert.equal(owner.readCommercialStorefront(sql,[productId],"US","USD").length,1);
 assert.deepEqual(owner.readCommercialStorefront(sql,[productId],"CA","USD"),[]);
 assert.deepEqual(owner.readCommercialStorefront(sql,[productId],"US","CAD"),[]);
 assert.throws(()=>owner.publishCommercialStorefront(sql,{...proof,offer_json:price(799)}),
   /commercial_offer_change_requires_owner_denial/,
   "A paid offer cannot change without owner-first product withdrawal");
 assert.throws(()=>owner.publishCommercialStorefront(sql,{...proof,
   offer_json:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0})}),
   /invalid_paid_retail_offer/);
 const projection={candidates:{productIds:[productId],country:"US",currency:"USD"},
   displayBooks:[{productId,editionId,title:"Paid Book",authors:[],subjects:[],
     bookshelves:[],languages:["en"],sourceExternalId:null,formats:{},download_count:0}]};
 const secret="a".repeat(64);
 const stub={async fetch(req){
   assert.equal(new URL(req.url).pathname,"/storefront/authorize-batch");
   assert.equal(req.headers.get("authorization"),"Bearer "+secret);
   const {ids,territory,currency}=await req.json();
   return Response.json({schema:"cove.storefront-owner.v1",
     rows:owner.readCommercialStorefront(sql,ids,territory,currency)});
 }};
 const publicFreeId="prd_gutenberg_2701";
 const freeCommand={sourceId:"2701",territory:"US",revision:1,action:"allow"};
 free.applyAuthorityCommand(sql,freeCommand);
 free.storeAuthorizedPresentationProof(sql,freeCommand,"USD",{
   productId:publicFreeId,editionId:"ed_gutenberg_2701",
   productPublicId:"book_2701",editionPublicId:"edition_2701",
   offerJson:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0})
 });
 const mixed={...projection,
   candidates:{...projection.candidates,productIds:[publicFreeId,productId]},
   displayBooks:[{productId:publicFreeId,editionId:"ed_gutenberg_2701",
     title:"Free Book",authors:[],subjects:[],bookshelves:[],languages:["en"],
     sourceExternalId:"2701",formats:{},download_count:12},
     ...projection.displayBooks]
 };
 const mixedStub={async fetch(req){
   const {ids,territory,currency}=await req.json();
   return Response.json({schema:"cove.storefront-owner.v1",rows:[
     ...free.readAuthorizedPresentations(sql,ids.filter(id=>id.startsWith("prd_gutenberg_")),
       territory,currency),
     ...owner.readCommercialStorefront(sql,ids.filter(id=>!id.startsWith("prd_gutenberg_")),
       territory,currency)
   ]});
 }};
 const mixedPage=await client.authorizeHomepageWithUnifiedOwner(
   mixedStub,secret,mixed);
 assert.equal(mixedPage.count,2,"Single strong owner must serve paid and free shelves");
 assert.deepEqual(mixedPage.results.map(book=>book.productId),[publicFreeId,productId]);
 const page=await client.authorizeHomepageWithUnifiedOwner(stub,secret,projection);
 assert.equal(page.count,1);
 assert.deepEqual(page.results[0].offer,
   {type:"retail",currency:"USD",amountMinor:599});
 assert.deepEqual(rights.denyCommercialSubject(sql,{
   subjectKind:"contract",subjectId:commercial.contractId,
   operationId:"contract:paid_book_001:revoke"
 }),{applied:true,subjectKind:"contract",subjectId:commercial.contractId});
 assert.deepEqual(owner.readCommercialStorefront(sql,[productId],"US","USD"),[]);
 assert.equal((await client.authorizeHomepageWithUnifiedOwner(stub,secret,projection)).count,0);
 assert.equal((await client.authorizeHomepageWithUnifiedOwner(mixedStub,secret,mixed)).count,1,
   "Paid contract withdrawal does not revoke a distinct Gutenberg grant");
 assert.throws(()=>owner.publishCommercialStorefront(sql,proof),
   /commercial_storefront_owner_proof_changed/,
   "Stale D1-verified offer after withdrawal must not regrant");
 await assert.rejects(()=>client.authorizeHomepageWithUnifiedOwner(
   {async fetch(){throw Error("owner unavailable")}},secret,projection
 ),/owner unavailable/,"Owner outage cannot return untrusted cached retail offer");
 const badStub={async fetch(){return Response.json({schema:"cove.storefront-owner.v1",
   rows:[{...proof,offer_json:JSON.stringify({
     type:"public-domain",currency:"USD",amountMinor:0
   })}]});}};
 await assert.rejects(()=>client.authorizeHomepageWithUnifiedOwner(
   badStub,secret,projection
 ),/legal_owner_paid_proof_invalid/);
 db.close();
 console.log("PASS: mixed storefront owner paid price matches exact legal epoch, territory and contract, and immediately denies withdrawn paid shelf");
}finally{rmSync(dir,{recursive:true,force:true});}
