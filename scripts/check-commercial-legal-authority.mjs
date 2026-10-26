/* eslint-disable prettier/prettier -- Legal rights proof and revocation ordering regression. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cove-commercial-legal-"));
try {
  const outfile=path.join(dir,"commercial.mjs");
  await build({entryPoints:["src/storefront-strangler/commercial-legal-core.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const core=await import(pathToFileURL(outfile).href);
  const file=path.join(dir,"commercial.sqlite");
  let db=new DatabaseSync(file);
  const sql=()=>({exec(query,...args){
    const q=db.prepare(query);
    const result=/^\s*SELECT\b/i.test(query)?q.all(...args):(q.run(...args),[]);
    return {toArray:()=>result};
  }});
  core.createCommercialAuthoritySchema(sql());
  const id="prd_commercial_a17";
  const proof={productId:id,editionId:"ed_commercial_a17",territory:"US",
    channel:"retail",grantId:"right_valid_17",contractId:"rcontract_17",
    contractVersionId:"rcv_17",validUntil:new Date(Date.now()+120000).toISOString()};
  const read=(country="US",channel="retail",now=new Date().toISOString())=>
    core.readCommercialProofs(sql(),[id],country,channel,now);
  assert.deepEqual(read(),[],"Missing strongly consistent proof must deny");
  assert.throws(()=>core.validateCommercialProof({...proof,productId:"prd_gutenberg_2701"}),
    /invalid_commercial_proof/,"Gutenberg must not enter paid proof scope");
  assert.throws(()=>core.validateCommercialProof({...proof,grantId:""}),
    /invalid_commercial_proof/,"A paid proof must identify a canonical grant");
  assert.throws(()=>core.validateCommercialProof({...proof,contractVersionId:"rcv_17",contractId:null}),
    /invalid_commercial_proof/,"Versioned contract must have exact parent");
  assert.throws(()=>core.validateCommercialProof({...proof,validUntil:new Date(Date.now()+48*3600000).toISOString()}),
    /invalid_commercial_proof/,"Long-lived cached allowances are forbidden");
  assert.equal(core.captureCommercialEpoch(sql(),{productId:id}),0);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),proof,0),{applied:true,epoch:1});
  assert.equal(read().length,1);
  assert.equal(read()[0].grant_id,proof.grantId);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,validUntil:new Date(Date.now()+180000).toISOString()
  },1),{applied:true,epoch:1},
  "Refreshing the same verified offer must NOT churn every buyer entitlement");
  assert.throws(()=>core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_different_18"
  },1),/commercial_rights_change_requires_prior_denial/,
  "Grant substitution requires an acknowledged owner DENY first");
  assert.equal(read()[0].grant_id,proof.grantId);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,territory:"CA"
  },1),{applied:true,epoch:1},
  "Adding a separately verified country must not invalidate other market epochs");

  assert.equal(read("CA").length,1,
    "Canada is authorized ONLY because a separate CA-specific fresh proof was explicitly published");
  assert.deepEqual(read("AU"),[],"No permission may be inferred for an unapproved country");
  assert.deepEqual(read("US","library"),[],"Retail purchase grant cannot authorize a library loan");
  assert.deepEqual(read("US","retail",new Date(Date.now()+150000).toISOString()),[],
    "Expired proof must deny even if an invalidation job never runs");
  const stale=core.captureCommercialEpoch(sql(),{productId:id});
  const denied=core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  });
  assert.deepEqual(denied,{applied:true,epoch:2});
  assert.deepEqual(read(),[],"Committed withdrawal immediately disables old proof");
  assert.deepEqual(core.publishFreshCommercialProof(sql(),proof,stale),
    {applied:false,epoch:2},"Slow primary D1 allow cannot resurrect withdrawal");
  assert.deepEqual(read(),[]);
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  }),{applied:true,epoch:2},"Same event replay cannot increment epoch");
  assert.throws(()=>core.denyCommercialProduct(sql(),{
    productId:"prd_commercial_b18",operationId:"contract:17:revoked"
  }),/commercial_denial_scope_collision/,"Event receipt scope is immutable");
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_fresh_18"
  },2),{applied:true,epoch:3});
  assert.equal(read()[0].grant_id,"right_fresh_18");
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  }),{applied:false,epoch:2},
    "A stale denial replay after fresh approval cannot masquerade as current");
  db.close();
  db=new DatabaseSync(file);
  assert.equal(read().length,1,"Owner proof survives SQLite Durable Object restart");
  const before=core.captureCommercialEpoch(sql(),{productId:id});
  db.exec("BEGIN");
  try{
    core.denyCommercialProduct(sql(),{productId:id,operationId:"contract:17:rollback"});
    db.exec("ROLLBACK");
  }catch(e){db.exec("ROLLBACK");throw e;}
  assert.equal(core.captureCommercialEpoch(sql(),{productId:id}),before,
    "Transaction rollback cannot create a ghost legal-denial receipt");
  assert.equal(read().length,1);
  assert.throws(()=>core.readCommercialProofs(sql(),[id,id],"US","retail"),
    /invalid_commercial_batch/);
  assert.throws(()=>core.readCommercialProofs(sql(),[id],"U$","retail"),
    /invalid_commercial_batch/);
  assert.deepEqual(core.readCommercialProofs(sql(),[],"US","retail"),[]);
  db.close();
  console.log("PASS: independent paid product/territory/channel proof; grant and contract scope; one-SQL batch; durable revoke, ABA, replay and expiration; no Gutenberg equivalence");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
