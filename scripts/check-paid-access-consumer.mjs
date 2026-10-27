/* eslint-disable prettier/prettier -- Protected rights and purchase lease must share strong owner state. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";

// Every paid audiobook byte/license and Biosync timing path must invoke
// the same buyer-specific owner check as protected EPUB redemption. A
// subscription cannot masquerade as a retail purchase proof.
const audio=readFileSync("src/features/fore/commercial-audio.server.ts","utf8");
assert.ok(audio.includes("async function requireCommercialAudioOwner("));
assert.ok(audio.includes('if (env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1") return;'));
assert.ok(audio.includes("await requireStagePaidEntitlementAccess(env, {"));
assert.ok(audio.includes('channel: "retail"'));
assert.match(audio,/Math\.min\(Date\.now\(\) \+ 7 \* 86400000, ent\.ends_at \? Date\.parse\(ent\.ends_at\) : Infinity\)/,
  "Signed offline audio leases must expire within seven days AND never outlive the purchase");
const issuance=audio.slice(audio.indexOf('match[2] === "offline-license" && !match[3]'),
  audio.indexOf("return null;\n}",audio.indexOf('match[2] === "offline-license" && !match[3]')));
assert.ok(issuance.indexOf("await requireCommercialAudioOwner(")>=0 &&
  issuance.indexOf("await signOfflineAudioLicense(")>issuance.indexOf("await requireCommercialAudioOwner(") &&
  issuance.indexOf("INSERT INTO audio_offline_licenses")>issuance.indexOf("await signOfflineAudioLicense("),
  "Offline audio must obtain fresh paid-owner approval before signing and publishing any 7-day license");
for(const endpoint of [
  'match[2] === "tracks"',
  'match[2] === "playback"',
  'match[2] === "biosync"',
  'match[2] === "offline-license" && match[3] === "verify"',
  'match[2] === "offline-license" && !match[3]',
  'match[2] === "complete"',
]){
  const start=audio.indexOf(endpoint);
  assert.ok(start>=0,"Protected audio endpoint missing: "+endpoint);
  const end=audio.indexOf("  if (match[2]",start+endpoint.length);
  const section=audio.slice(start,end<0?start+11500:end);
  assert.ok(/requireCommercialAudioOwner\(\s*env,/.test(section),
    "Protected audio endpoint missing owner authorization: "+endpoint);
  if(endpoint==='match[2] === "biosync"'){
    assert.ok(section.includes("await Promise.all([") &&
      section.includes("String(link.ebook_product_id)"),
      "Biosync must verify both audiobook and ebook buyer proofs");
  }
}
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
    orderId:"order_purchase_17",
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
  const verified=entitlement.readPaidAccess(sql,input);
  assert.equal(verified.order_id,input.orderId,"Proof is bound to the paid order");
  assert.equal(verified.territory,input.territory);
  assert.equal(verified.channel,input.channel);
  // A 200 response from a private binding is not sufficient if it carries
  // another customer's, market's or item's valid-looking purchase lease.
  for(const [field,value] of [
    ["user_id","user_purchase_18"],
    ["product_id","prd_commercial_b18"],
    ["entitlement_id","another_paid_entitlement_18"],
    ["order_id","bad"],
    ["territory","CA"],
    ["channel","subscription"],
    ["edition_id",""],
    ["contract_version_id",null]
  ]){
    const forged={...owner,LEGAL_AUTHORITY:{getByName:()=>({
      async fetch(){return Response.json({schema:"cove.paid-access.v1",
        allowed:true,proof:{...verified,[field]:value}});}
    })}};
    await assert.rejects(check(forged),e=>e.status===503,
      "Forged paid lease must fail closed: "+field);
  }
  const other={...input,
    productId:"prd_other_contract_19",
    entitlementId:"e3c726a0-9be3-43b6-b2c5-5b6dd88e22b5",
    orderId:"order_other_contract_19"
  };
  const secondDoc={...doc,productId:other.productId,editionId:"ed_other_contract_19",
    grantId:"grant_other_contract_19",contractId:"contract_shared_other_19",
    contractVersionId:"version_shared_other_19"};
  assert.deepEqual(product.publishFreshCommercialProof(sql,secondDoc,0),
    {applied:true,epoch:1});
  assert.deepEqual(entitlement.publishFreshEntitlement(sql,{
    ...other,productEpoch:1,validUntil:new Date(Date.now()+90000).toISOString()
  },0),{applied:true,epoch:1});
  await check(owner,other);
  product.denyCommercialSubject(sql,{subjectKind:"contract",
    subjectId:secondDoc.contractId,operationId:"contract:shared19:revoked"});
  await assert.rejects(check(owner,other),e=>e.status===451,
    "Subject-wide contract withdrawal invalidates existing buyer lease instantly");
  assert.throws(()=>product.publishFreshCommercialProof(sql,secondDoc,1),
    /commercial_subject_withdrawal_terminal/,
    "Rechecking a canonical D1 row must not reissue a revoked contract ID");
  await check(owner,input);
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_version_id=NULL WHERE product_id=?").run(input.productId);
  await assert.rejects(check(),e=>e.status===451,
    "An old contractless rights row must NOT authorize protected delivery");
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_version_id=? WHERE product_id=?").run(doc.contractVersionId,input.productId);
  await assert.rejects(check(owner,{...input,userId:"user_other_18"}),
    e=>e.status===451,"Cannot borrow another buyer's purchase proof");
  product.denyCommercialProduct(sql,{
    productId:input.productId,operationId:"retail:qa-temporary-product-hold-17"
  });
  await assert.rejects(check(),e=>e.status===451,
    "Owner-first retail hold temporarily invalidates a previously issued paid grant");
  assert.deepEqual(product.publishFreshCommercialProof(sql,{
    ...doc,validUntil:new Date(Date.now()+800000).toISOString()
  },2),{applied:true,epoch:3});
  await assert.rejects(check(),e=>e.status===451,
    "Retail reopening cannot revive a stale buyer entitlement epoch");
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
  assert.deepEqual(entitlement.denyPaidOrder(sql,{
    orderId:input.orderId,operationId:"order-refund:purchase17"
  }),{applied:true,orderId:input.orderId});
  await assert.rejects(check(),e=>e.status===451,
    "A single full-order denial vetoes a previously granted entitlement");
  await assert.rejects(check({...env,LEGAL_AUTHORITY:{
    getByName:()=>({async fetch(){throw Error("rpc_unavailable");}})
  }}),e=>e.status===503,"Outage must never fall back to primary or KV allow");
  await assert.rejects(check({...owner,COVE_SSR_STAGING:"0"}),e=>e.status===503);
  db.close();
  console.log("PASS: protected delivery 1 DO RPC, 1 SQLite snapshot, exact buyer and product epoch, contract withdrawal, refund, reinstatement and outage fail closed");
}finally{rmSync(dir,{force:true,recursive:true});}
