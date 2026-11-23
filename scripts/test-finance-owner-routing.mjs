/* eslint-disable prettier/prettier -- Public financial facades must cross a fixed owner port and bind exact receipts. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-finance-routing-"));
try{
 const file=join(folder,"client.mjs");
 await build({stdin:{contents:`export {createFinanceParty,reverseRoyaltiesForRefund} from "./src/features/fore/finance.server";
  export {bindPublicationOwner} from "./src/storefront-strangler/publication-owner-routing.server";`,
  resolveDir:resolve("."),loader:"ts"},outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const {createFinanceParty,reverseRoyaltiesForRefund,bindPublicationOwner}=await import(pathToFileURL(file).href);
 const raw={prepare(){throw Error("public_finance_sql_bypass");},batch(){throw Error("public_finance_batch_bypass");}};
 const seen=[];let forge=false,outage=false;
 const port={async fetch(request){
  if(outage)throw Error("owner_unavailable");
  assert.equal(new URL(request.url).pathname,"/finance/private-action");
  const body=await request.json();seen.push(body);
  assert.equal(request.headers.get("authorization"),"Bearer "+"a".repeat(64));
  return Response.json({schema:"cove.private-finance-qa.v1",ownerFirst:true,...body,
   actorUserId:forge?"other_staff":body.actorUserId,result:{id:"party_verified"}});
 }};
 const db=bindPublicationOwner(raw,{owner:port,secret:"a".repeat(64),territory:"US",currency:"USD"});
 const args={type:"publisher",displayName:"QA"},actor={userId:"staff_finance_qa"};
 await assert.rejects(createFinanceParty(raw,args,actor),/private financial owner/);
 await assert.rejects(createFinanceParty(db,args),/private financial owner/);
 await assert.rejects(reverseRoyaltiesForRefund(db,"refund_qa"),/private financial owner/);
 assert.deepEqual(await createFinanceParty(db,args,actor),{id:"party_verified"});
 await createFinanceParty(db,{displayName:"QA",type:"publisher"},actor);
 assert.equal(seen[0].operationId,seen[1].operationId,"Property order must not change retry identity");
 await createFinanceParty(db,args,{...actor,operationId:"intentional_second_party"});
 assert.notEqual(seen[0].operationId,seen[2].operationId);
 forge=true;await assert.rejects(createFinanceParty(db,args,actor),/canonical_command_receipt_mismatch/);
 forge=false;outage=true;await assert.rejects(createFinanceParty(db,args,actor),/owner_unavailable/);
 console.log("PASS: public financial APIs contain no local writer fallback; authenticated owner forwarding, stable retry IDs, exact actor receipts and outage rejection");
}finally{rmSync(folder,{recursive:true,force:true});}
