/* eslint-disable prettier/prettier -- Adversarial tests for the private command gateway's exact route/receipt contract. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(join(tmpdir(),"cove-typed-owner-gateway-"));
try{
  const outfile=join(directory,"gateway.mjs");
  await build({entryPoints:["src/storefront-strangler/canonical-owner-command-gateway.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {dispatchCanonicalOwnerCommand:invoke}=await import(pathToFileURL(outfile).href);
  const secret="a".repeat(64),orderId="order_gateway_01",operationId="refund:gateway_01";
  const productId="prd_gateway_01",entitlementId="ent_gateway_01",userId="user_gateway_01";
  const tests=[
    ["commerce.revoke-order",{orderId,operationId},"/commercial/order/revoke",
      {schema:"cove.paid-order-revocation.v1",orderDenied:true,reconciled:true,orderId,operationId}],
    ["commerce.publish-order",{orderId,userId,territory:"US",channel:"retail"},
      "/commercial/entitlement/publish-order-verified",
      {applied:true,orderId,receipts:[{entitlementId,epoch:1}]}],
    ["commerce.publish-entitlement",{entitlementId,userId,productId,territory:"US",channel:"retail"},
      "/commercial/entitlement/publish-verified",{applied:true,epoch:1}],
    ["publication.activate",{publicationVersionId:"pubv_gateway_01",actorUserId:null,
      triggerType:"schedule",operationId:"activation:gateway_01",territory:"US",currency:"USD"},
      "/publication/activate-version",{schema:"cove.publication-activation.v1",ownerFirst:true,
        operationId:"activation:gateway_01",publicationVersionId:"pubv_gateway_01",state:"live",versionNumber:1}],
    ["publication.open-preorder",{publicationVersionId:"pubv_gateway_01",
      operationId:"preorder:gateway_01",territory:"US",currency:"USD"},
      "/publication/open-preorder",{schema:"cove.publication-preorder.v1",ownerFirst:true,
        operationId:"preorder:gateway_01",publicationVersionId:"pubv_gateway_01",state:"preorder",versionNumber:1}],
    ["publication.recover",{operationId:"recovery:gateway_01"},"/publication/recover-recorded",
      {schema:"cove.publication-recovery.v1",ownerFirst:true,
        operationId:"recovery:gateway_01",checked:2,recovered:1,blocked:1}],
    ["rights.suspend-grant",{action:"suspend-grant",targetId:"grant_gateway_01",operationId},
      "/commercial/suspend-grant",
      {suspended:true,ownerDenied:true,subject:"grant",subjectId:"grant_gateway_01"}],
    ["rights.suspend-contract",{action:"suspend-contract",targetId:"contract_gateway_01",operationId},
      "/commercial/suspend-contract",
      {suspended:true,ownerDenied:true,subject:"contract",subjectId:"contract_gateway_01"}],
    ["rights.quarantine-source",{action:"quarantine-source",sourceId:"pgca_123",
      operationId,message:"Evidence revoked"},"/quarantine",{quarantined:true,sourceId:"pgca_123"}],
    ["rights.revoke-source-evidence",{action:"revoke-source-evidence",sourceId:"123",
      evidenceId:"gre_gateway_01",territory:"US",operationId},
      "/evidence/revoke",{evidenceRevoked:true,sourceId:"123",
        evidenceId:"gre_gateway_01",territory:"US"}],
    ["rights.retract-sources",{action:"retract-sources",
      operations:[{sourceId:"123",operationId},{sourceId:"456",operationId:"refund:gateway_02"}]},
      "/source/retract-batch",{retracted:2,sourceIds:["123","456"]}],
    ["rights.withdraw-retail",{action:"withdraw-retail",productId,operationId},
      "/commercial/retail/withdraw",{withdrawn:true,ownerEpoch:2}],
    ["rights.publish-retail",{action:"publish-retail",productId,territory:"US",currency:"USD",operationId},
      "/commercial/retail/publish-verified",{published:true,ownerEpoch:2}],
    ["rights.pause-market",{action:"pause-market",territory:"US",operationId},
      "/market/withdraw",{marketWithdrawn:true,territory:"US"}],
    ["rights.revoke-entitlement",{action:"revoke-entitlement",entitlementId,operationId},
      "/commercial/entitlement/revoke",{revoked:true,epoch:2}],
    ["rights.withdraw-distribution",{action:"withdraw-distribution",
      publicationVersionId:"pubv_gateway_01",status:"recalled",allowExistingOwners:false,
      reasonCode:"legal_recall",reasonDetail:"Rights dispute",actorUserId:userId,operationId},
      "/commercial/distribution/withdraw",
      {withdrawn:true,ownerDenied:true,publicationVersionId:"pubv_gateway_01",status:"recalled",ownerEpoch:3}],
    ["commerce.post-refund-accounting",{orderId,refundId:"ref_gateway_01"},
      "/commercial/refund/post-accounting",
      {schema:"cove.owner-refund-accounting.v1",ownerDenied:true,posted:true,
        orderId,refundId:"ref_gateway_01",applied:true,royaltiesReconciled:true}]
  ];
  let calls=0;
  for(const [kind,body,path,receipt] of tests){
    const writer=kind.startsWith("rights.");
    const port={async fetch(request){
      calls++;
      const url=new URL(request.url);
      assert.equal(url.origin,writer?"https://legal-quarantine.internal":"https://legal-authority.internal");
      assert.equal(url.pathname,path);
      assert.equal(request.method,"POST");
      assert.equal(request.headers.get("authorization"),"Bearer "+secret);
      assert.equal(request.headers.get("content-type"),"application/json");
      assert.equal(request.headers.get("cache-control"),"no-store");
      assert.deepEqual(await request.json(),body);
      return Response.json(receipt);
    }};
    assert.deepEqual(await invoke(port,secret,kind,body),receipt);
  }
  assert.equal(calls,tests.length);
  const good=tests[0];
  const response=payload=>({fetch:async()=>Response.json(payload)});
  const invalid=[
    [good[0],{...good[1],sql:"UPDATE entitlements SET status='active'"}],
    [good[0],{...good[1],orderId:"../../other"}],
    [good[0],{...good[1],operationId:"; DROP TABLE entitlements"}],
    ["commerce.raw-sql",good[1]],
    ["publication.activate",{...tests[3][1],triggerType:"operator-bypass"}],
    ["publication.activate",{...tests[3][1],actorUserId:"someone",actorRole:"admin"}],
    ["rights.withdraw-distribution",{...tests[15][1],allowExistingOwners:true}],
    ["rights.suspend-grant",{...tests[6][1],targetId:""}],
    ["rights.retract-sources",{...tests[10][1],
      operations:[{sourceId:"123",operationId},{sourceId:"123",operationId:"replay:02"}]}],
    ["rights.publish-retail",{...tests[12][1],productId:"prd_gutenberg_123"}]
  ];
  for(const [kind,payload] of invalid){
    let called=false;
    await assert.rejects(()=>invoke({async fetch(){called=true;throw Error("unexpected");}},
      secret,kind,payload));
    assert.equal(called,false,"Invalid command must be rejected before any owner RPC");
  }
  for(const wrong of ["", "b".repeat(64),"a".repeat(63),"a".repeat(64)+"\n"]){
    if(wrong==="b".repeat(64))continue; // Any well-formed credential is valid transport data.
    await assert.rejects(()=>invoke(response(good[3]),wrong,good[0],good[1]));
  }
  const badReceipts=[
    {...good[3],orderId:"order_other_01"},
    {...good[3],reconciled:false},
    {applied:true},
    [],
    null
  ];
  for(const ack of badReceipts)await assert.rejects(
    ()=>invoke(response(ack),secret,good[0],good[1]),
    /canonical_command_receipt/
  );
  const refundCommand=tests.find(([kind])=>kind==="commerce.post-refund-accounting");
  assert.ok(refundCommand);
  const [refundKind,refundBody,,refundReceipt]=refundCommand;
  for(const invalidReceipt of [
    {...refundReceipt,royaltiesReconciled:false},
    {...refundReceipt,royaltiesReconciled:null},
    {...refundReceipt,refundId:"ref_wrong_owner_01"},
    {schema:"cove.owner-refund-accounting.v1",posted:true,ownerDenied:true}
  ])await assert.rejects(
    ()=>invoke(response(invalidReceipt),secret,refundKind,refundBody),
    /canonical_command_receipt_mismatch/,
    "Never acknowledge a refund whose royalty posting is missing or unscoped"
  );
  const failures=[
    {async fetch(){return new Response(null,{status:503});}},
    {async fetch(){return new Response("not json");}},
    {async fetch(){return new Response("{}".repeat(65537));}},
    {async fetch(){throw Error("owner_offline");}}
  ];
  for(const port of failures)await assert.rejects(()=>invoke(port,secret,good[0],good[1]));
  console.log("PASS: "+tests.length+" typed legal/commerce/publication routes, exact scope and receipt proof; SQL injection, route forgery, invalid actor, replay scope and owner outage fail closed");
}finally{rmSync(directory,{recursive:true,force:true});}
