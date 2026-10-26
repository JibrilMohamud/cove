/* eslint-disable prettier/prettier -- Protected rights and purchase lease must share strong owner state. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

const dir=mkdtempSync(path.join(os.tmpdir(),"cove-protected-paid-"));
try{
  const load=async(src,out)=>{
    const artifact=path.join(dir,out+".mjs");
    await build({entryPoints:[src],outfile:artifact,
      bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
    return import(pathToFileURL(artifact).href);
  };
  const product=await load("src/storefront-strangler/commercial-legal-core.ts","product");
  const entitlement=await load("src/storefront-strangler/commercial-entitlement-core.ts","entitlement");
  const consumer=await load("src/storefront-strangler/legal-consumer-fence.server.ts","consumer");
  const db=new DatabaseSync(":memory:");
  const sql={exec(q,...args){
    // Cloudflare SQLite executes mutations eagerly. The Node fixture must
    // match that: returning a lazy toArray() would silently skip CREATEs
    // and positive/negative legal writes not read through a cursor.
    const st=db.prepare(q);
    const rows=/^\s*SELECT\b/i.test(q)?st.all(...args):(st.run(...args),[]);
    return {toArray:()=>rows};
  }};
  product.createCommercialAuthoritySchema(sql);
  entitlement.createPaidEntitlementSchema(sql);
  const input={
    entitlementId:"2be93243-1057-4fdc-a393-f8666bd97378",
    userId:"user_purchase_17",productId:"prd_commercial_a17",
    territory:"US",channel:"retail"
  };
  const doc={productId:input.productId,editionId:"ed_commercial_a17",
    territory:"US",channel:"retail",grantId:"right_valid_17",
    contractId:"rcontract_17",contractVersionId:"rcv_17",
    validUntil:new Date(Date.now()+900000).toISOString()};
  const env={
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64)
  };
  let ownerCalls=0;
  const binding={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(request){
      ownerCalls++;
      assert.equal(new URL(request.url).pathname,
        "/commercial/entitlement/authorize");
      assert.equal(request.headers.get("authorization"),"Bearer "+"a".repeat(64));
      const supplied=await request.json();
      const proof=entitlement.readPaidAccess(sql,supplied);
      return Response.json({schema:"cove.paid-access.v1",allowed:!!proof,proof});
    }};
  }};
  const owner={...env,LEGAL_AUTHORITY:binding};
  const check=(user=owner,who=input)=>consumer.requireStagePaidEntitlementAccess(user,who);
  await check({},"");
  assert.equal(ownerCalls,0,"Existing production route MUST NOT contact QA owner");
  assert.equal(entitlement.readPaidAccess(sql,input),null,
    "Empty strong product/entitlement fixture must return denied without throwing");
  await assert.rejects(check(),e=>e.status===451,
    "Even a known order cannot read before rights and entitlement proofs");
  assert.deepEqual(product.publishFreshCommercialProof(sql,doc,0),
    {applied:true,epoch:1});
  await assert.rejects(check(),e=>e.status===451,
    "Product-level paid rights cannot imply a purchase entitlement");
  assert.deepEqual(entitlement.publishFreshEntitlement(sql,{
    ...input,productEpoch:1,
    validUntil:new Date(Date.now()+90000).toISOString()
  },0),{applied:true,epoch:1});
  await check();
  assert.equal(ownerCalls,3,"One combined DO RPC per protected request");
  await assert.rejects(check(owner,{...input,userId:"user_other_18"}),
    e=>e.status===451,"Cannot borrow another buyer's purchase proof");
  product.denyCommercialProduct(sql,{
    productId:input.productId,operationId:"contract:17:suspended"
  });
  await assert.rejects(check(),e=>e.status===451,
    "Contract withdrawal invalidates a previously issued protected grant");
  assert.deepEqual(product.publishFreshCommercialProof(sql,{
    ...doc,validUntil:new Date(Date.now()+800000).toISOString()
  },2),{applied:true,epoch:3});
  await assert.rejects(check(),e=>e.status===451,
    "Restoring a license cannot revive a stale buyer entitlement epoch");
  assert.deepEqual(entitlement.publishFreshEntitlement(sql,{
    ...input,productEpoch:3,
    validUntil:new Date(Date.now()+90000).toISOString()
  },1),{applied:true,epoch:2});
  await check();
  entitlement.denyPaidEntitlement(sql,{
    ...input,operationId:"refund:purchase17:v1"
  });
  await assert.rejects(check(),e=>e.status===451,
    "Refund revocation denies buyer even when product remains authorized");
  await assert.rejects(check({...env,LEGAL_AUTHORITY:{
    getByName:()=>({async fetch(){throw Error("rpc_unavailable");}})
  }}),e=>e.status===503,"Outage must never fall back to primary or KV allow");
  await assert.rejects(check({...owner,COVE_SSR_STAGING:"0"}),e=>e.status===503);
  db.close();
  console.log("PASS: protected delivery 1 DO RPC, 1 SQLite snapshot, exact buyer and product epoch, contract withdrawal, refund, reinstatement and outage fail closed");
}finally{rmSync(dir,{force:true,recursive:true});}
