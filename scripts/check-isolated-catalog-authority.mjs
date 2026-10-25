/* eslint-disable prettier/prettier -- Explicit fresh-legal-boundary assertions. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cove-catalog-authority-"));
try {
 fs.cpSync("drizzle",path.join(dir,"drizzle"),{recursive:true});
 await build({
   entryPoints: {
     verifier:"src/storefront-strangler/catalog-index-verify.server.ts",
     api:"src/features/fore/api.server.ts",
   },
   outdir:dir,bundle:true,platform:"node",format:"esm",logLevel:"silent"
 });
 const { verifyIsolatedCatalogCandidates:verify, verifyIsolatedCatalogBooks:verifyBooks } =
   await import(path.join(dir,"verifier.js"));
 const { handleCoveApi }=await import(path.join(dir,"api.js"));
 const env={...localBindings(dir),FORE_ENVIRONMENT:"development"};
 const init=await handleCoveApi(new Request("https://test/api/fore/storefront/bootstrap"),env);
 assert.equal(init.status,200,await init.text());
 const candidate=await env.DB.prepare(`SELECT p.id product_id
   FROM products p JOIN editions e ON e.id=p.edition_id
   JOIN catalog_search_documents d ON d.product_id=p.id
   WHERE p.source_name='gutenberg' AND p.storefront_status='active'
   AND e.release_status='available' AND d.suppressed=0 LIMIT 1`).first();
 assert.ok(candidate?.product_id,"Fixture requires one active Gutenberg product");
 const response={schema:"cove.catalog.candidates.v1",authoritative:false,ids:[candidate.product_id]};
 const query={async fetch(){return Response.json(response)}};
 const probe={PRIMARY_DB:env.DB,CATALOG_QUERY:query,COVE_CATALOG_INDEX_VERIFY_ENABLED:"1"};
 const allowed=await verify(probe,"Moby","US");
 assert.deepEqual(allowed.productIds,[candidate.product_id]);
 const edition=await env.DB.prepare("SELECT edition_id FROM products WHERE id=?")
   .bind(candidate.product_id).first();
 const queryWithGraph={async fetch(request){
   if(new URL(request.url).pathname==="/query") return Response.json(response);
   if(new URL(request.url).pathname==="/graph")
     return Response.json({schema:"cove.catalog.graph.v1",authoritative:false,
       books:[{productId:candidate.product_id,editionId:edition.edition_id,
         title:"Fixture Title",authors:["Fixture Author"],subjects:["Subject"],
         shelves:[],coverUrl:"https://example.org/cover.jpg"}]});
   return new Response(null,{status:404});
 }};
 const graphProbe={...probe,CATALOG_QUERY:queryWithGraph};
 const allowedBooks=await verifyBooks(graphProbe,"Moby","US");
 assert.equal(allowedBooks.books.length,1);
 assert.equal(allowedBooks.books[0].authors[0],"Fixture Author");
 assert.ok(allowedBooks.books[0].offer,"Offer must come from live primary");
 await env.DB.prepare(`UPDATE rights_grants SET status='revoked' WHERE edition_id=
   (SELECT edition_id FROM products WHERE id=?) AND status='active' AND decision='allow'`)
    .bind(candidate.product_id).run();
 const withdrawn=await verify(probe,"Moby","US");
 assert.deepEqual(withdrawn.productIds,[],"stale isolated candidate cannot survive live primary withdrawal");
 const goneBooks=await verifyBooks(graphProbe,"Moby","US");
 assert.deepEqual(goneBooks.books,[],"Advisory graph must disappear on live primary revocation");
 await assert.rejects(()=>verifyBooks({...graphProbe,CATALOG_QUERY:{
   async fetch(request){
     if(new URL(request.url).pathname==="/query")return Response.json(response);
     return Response.json({schema:"cove.catalog.graph.v1",authoritative:true,books:[]});
   }
 }},"Moby","US"),/untrusted_graph/);

 await assert.rejects(()=>verify({...probe,COVE_CATALOG_INDEX_VERIFY_ENABLED:"0"},"Moby","US"),/disabled/);
 await assert.rejects(()=>verify({...probe,CATALOG_QUERY:{async fetch(){return Response.json({...response,authoritative:true})}}},"Moby","US"),/untrusted/);
 console.log("PASS: independent catalog candidates, fresh primary legal authority, revoked item filtered, invalid response fails closed");
} finally {fs.rmSync(dir,{recursive:true,force:true});}
