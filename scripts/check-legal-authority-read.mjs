/* eslint-disable prettier/prettier -- Cross-route authorization regression fixtures. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(path.join(os.tmpdir(),"cove-legal-routes-"));
try {
  const runtime=async(entry,name)=>{
    const outfile=path.join(folder,name+".mjs");
    await build({entryPoints:[entry],outfile,bundle:true,format:"esm",
      platform:"node",target:"node22",external:["cloudflare:*"],logLevel:"silent"});
    return import(pathToFileURL(outfile).href);
  };
  const core=await runtime("src/storefront-strangler/legal-authority-core.ts","core");
  const client=await runtime("src/storefront-strangler/legal-authority-read.server.ts","client");
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...args){
    const stmt=db.prepare(statement);
    return {toArray:()=>/^s*SELECT/i.test(statement)?stmt.all(...args):
      (stmt.run(...args),[])};
  }};
  core.createAuthoritySchema(sql);
  core.createAuthorityProofSchema(sql);
  const command=(rev,action)=>({sourceId:"2701",territory:"US",revision:rev,action});
  const proof={productId:"prd_gutenberg_2701",editionId:"ed_gutenberg_2701",
    productPublicId:"book2701",editionPublicId:"edition2701",
    offerJson:JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0})};
  const secret="b".repeat(64);
  const page={candidates:{productIds:[proof.productId],country:"US",currency:"USD"},
    displayBooks:[{productId:proof.productId,editionId:proof.editionId,
      title:"Safe Book",authors:[],subjects:[],bookshelves:[],languages:["en"],
      sourceExternalId:"2701",formats:{},download_count:1}]};
  const stub={async fetch(req){
    if(req.headers.get("authorization")!=="Bearer "+secret)
      return new Response(null,{status:401});
    const {ids,territory,currency}=await req.json();
    return Response.json({schema:"cove.legal-authorized.v1",
      rows:core.readAuthorizedPresentations(sql,ids,territory,currency)});
  }};
  assert.equal((await client.authorizeHomepageWithLegalOwner(stub,secret,page)).count,0,
    "Unknown legal state must never create a homepage listing");
  core.applyAuthorityCommand(sql,command(1,"allow"));
  assert.equal((await client.authorizeHomepageWithLegalOwner(stub,secret,page)).count,0,
    "Legal state alone without canonical offer proof cannot grant access");
  core.storeAuthorizedPresentationProof(sql,command(1,"allow"),"USD",proof);
  const first=await client.authorizeHomepageWithLegalOwner(stub,secret,page);
  assert.equal(first.count,1);
  assert.deepEqual(first.results[0].offer,{type:"public-domain",currency:"USD",amountMinor:0});
  const blocked=core.persistSourceWithdrawal(sql,
    {sourceId:"2701",territory:"*",operationId:"cross-service-legal-withdrawal"});
  assert.equal(blocked.applied,true);
  const later=await client.authorizeHomepageWithLegalOwner(stub,secret,page);
  assert.equal(later.count,0,"The same owner must block the homepage after withdrawal");
  assert.deepEqual(core.readAuthorizedPresentations(sql,[proof.productId],"US","USD"),[],
    "Book detail, checkout and protected delivery must independently see denial");
  assert.equal(core.readAuthority(sql,"2701","US").allowed,false);
  assert.equal((await client.authorizeHomepageWithLegalOwner({
    async fetch(){throw Error("owner-down");}},secret,page).count,1);
} catch(error) {
  // Not used: all failures should be asserted below, never swallowed.
  throw error;
}finally {rmSync(folder,{recursive:true,force:true});}
