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
 const commands=await moduleFrom("src/storefront-strangler/publication-command-core.ts","commands");
 const client=await moduleFrom("src/storefront-strangler/legal-authority-read.server.ts","client");
 // A declaration of writer closure is not sufficient: the same staged
 // gateway must have the mandatory canonical legal write lock installed
 // before anonymous traffic can use owner-only read authorization.
 const bootstrap=await moduleFrom("src/storefront-strangler/bootstrap-optimized.server.ts","bootstrap");
 const bootstrapRequest=new Request("https://cove.test/api/fore/storefront/bootstrap",{
   headers:{"x-cove-client-country":"US","cf-connecting-ip":"203.0.113.1"}
 });
 const stagedGateway={
   DB:{prepare(){throw Error("should_not_reach_primary_d1")}},
   COVE_STOREFRONT_READ_LIMITER:{async limit(){return {success:true}}},
   PRESENTATION:{},
   COVE_STRANGLER_READ_MODEL:"2",
   COVE_SSR_STAGING:"1",
   COVE_STRANGLER_MODE:"production-acceptance",
   COVE_STRANGLER_DATABASE_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989",
   COVE_LEGAL_OWNER_STAGE_READ_ENABLED:"1",
   COVE_LEGAL_OWNER_WRITER_CLOSURE_AUDITED:"1",
   COVE_RIGHTS_OWNER_SECRET:"a".repeat(64),
   LEGAL_AUTHORITY:{getByName(){throw Error("owner_must_not_be_called")}}
 };
 for(const lock of [undefined,"0"]){
   await assert.rejects(
     bootstrap.serveLeanAnonymousBootstrap(bootstrapRequest,{
       ...stagedGateway,COVE_CANONICAL_LEGAL_WRITE_LOCK:lock
     }),
     /Legal owner read not certified for protected staging/,
     "Staged owner reads must fail closed without canonical writer-lock closure"
   );
 }
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
 // A retail withdrawal commits to the owner BEFORE its D1 offer update.
 // Replaying the old canonical active offer while D1 is unavailable must
 // NOT resurrect the exact old price; a newly verified changed offer may.
 const priceProduct="prd_repriced_book_002";
 const priceEdition="ed_repriced_book_002";
 const priceRights={...commercial,productId:priceProduct,editionId:priceEdition,
   grantId:"grant_repriced_book_002",contractId:"contract_repriced_book_002",
   contractVersionId:"contract_repriced_version_1"};
 const priceProof={...proof,product_id:priceProduct,edition_id:priceEdition,
   grant_id:priceRights.grantId,contract_id:priceRights.contractId,
   contract_version_id:priceRights.contractVersionId};
 assert.deepEqual(rights.publishFreshCommercialProof(sql,priceRights,0),
   {applied:true,epoch:1});
 assert.deepEqual(owner.publishCommercialStorefront(sql,priceProof),
   {applied:true,epoch:1});
 assert.deepEqual(rights.denyCommercialProduct(sql,{
   productId:priceProduct,operationId:"retail:qa-price-withdraw-002"
 }),{applied:true,epoch:2});
 assert.deepEqual(rights.publishFreshCommercialProof(sql,priceRights,2),
   {applied:true,epoch:3},
   "Retail repricing may retain valid contract and grant identities");
 assert.deepEqual(owner.readCommercialStorefront(sql,[priceProduct],"US","USD"),[]);
 assert.throws(()=>owner.publishCommercialStorefront(sql,{
   ...priceProof,rights_epoch:3
 }),/commercial_offer_reinstatement_requires_changed_evidence/,
   "An old D1 retail offer cannot be republished just because the owner epoch advanced");
 assert.deepEqual(owner.readCommercialStorefront(sql,[priceProduct],"US","USD"),[],
   "Stale price publication leaves the product withdrawn");
 assert.deepEqual(owner.publishCommercialStorefront(sql,{
   ...priceProof,rights_epoch:3,offer_json:price(699)
 }),{applied:true,epoch:3},
   "A changed canonical offer can be republished with the same legal scope");
 assert.equal(owner.readCommercialStorefront(sql,[priceProduct],"US","USD").length,1);

 // A completed, independently verified publication edit may retain the same
 // legal grant AND price. It is not an unreconciled retail withdrawal.
 const publicationProduct="prd_publication_same_price_003";
 const publicationRights={...commercial,productId:publicationProduct,
   editionId:"ed_publication_same_price_003",grantId:"grant_publication_same_price_003",
   contractId:"contract_publication_same_price_003",contractVersionId:"contract_version_same_price_003"};
 const publicationProof={...proof,product_id:publicationProduct,
   edition_id:publicationRights.editionId,grant_id:publicationRights.grantId,
   contract_id:publicationRights.contractId,contract_version_id:publicationRights.contractVersionId};
 rights.publishFreshCommercialProof(sql,publicationRights,0);
 owner.publishCommercialStorefront(sql,publicationProof);
 const publicationCommand={operationId:"publication:same-price:003",productId:publicationProduct,
   commandSha256:"d".repeat(64)};
 commands.beginPublicationCommand(sql,publicationCommand);
 assert.throws(()=>rights.publishFreshCommercialProof(sql,publicationRights,2),
   /commercial_publication_command_pending/);
 commands.commitPublicationCommand(sql,publicationCommand,
   {publicationVersionId:"pubv_same_price_003",state:"updated",versionNumber:2});
 rights.publishFreshCommercialProof(sql,publicationRights,2);
 assert.deepEqual(owner.publishCommercialStorefront(sql,{...publicationProof,rights_epoch:3}),
   {applied:true,epoch:3},"A completed owner publication can retain its verified offer");
 commands.markPublicationPublished(sql,publicationCommand,3);
 assert.equal(owner.readCommercialStorefront(sql,[publicationProduct],"US","USD").length,1);
 rights.denyCommercialProduct(sql,{productId:publicationProduct,operationId:"rights:terminal:003"});
 const stalePublication={...publicationCommand,operationId:"publication:after-terminal:003"};
 commands.beginPublicationCommand(sql,stalePublication);
 commands.commitPublicationCommand(sql,stalePublication,
   {publicationVersionId:"pubv_stale_003",state:"updated",versionNumber:3});
 assert.throws(()=>rights.publishFreshCommercialProof(sql,publicationRights,5),
   /commercial_reinstatement_requires_new_legal_evidence/,
   "A publication journal never bypasses terminal withdrawal of its legal evidence");

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
