/* eslint-disable prettier/prettier -- Full staged owner purchase-to-refund trust-boundary regression. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const dir=mkdtempSync(path.join(os.tmpdir(),"cove-paid-end-to-end-"));
try {
  const load=async(source,name)=>{
    const file=path.join(dir,name+".mjs");
    await build({entryPoints:[source],outfile:file,bundle:true,
      format:"esm",platform:"node",target:"node22",logLevel:"silent"});
    return import(pathToFileURL(file).href);
  };
  const rights=await load("src/storefront-strangler/commercial-legal-core.ts","rights");
  const buyers=await load("src/storefront-strangler/commercial-entitlement-core.ts","buyers");
  const settlement=await load("src/storefront-strangler/paid-settlement-publication.server.ts","settlement");
  const protectedAccess=await load("src/storefront-strangler/legal-consumer-fence.server.ts","access");
  const canonical=new DatabaseSync(":memory:");
  const authority=new DatabaseSync(":memory:");
  const sql={exec(statement,...args){
    const query=authority.prepare(statement);
    const rows=/^\s*SELECT\b/i.test(statement)?query.all(...args):
      (query.run(...args),[]);
    return {toArray:()=>rows};
  }};
  rights.createCommercialAuthoritySchema(sql);
  buyers.createPaidEntitlementSchema(sql);
  canonical.exec(`CREATE TABLE commerce_orders(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,territory_code TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE commerce_order_items(
    id TEXT PRIMARY KEY,order_id TEXT NOT NULL,product_id TEXT NOT NULL,
    sales_channel TEXT NOT NULL,entitlement_status TEXT NOT NULL,
    preorder_id TEXT,rights_grant_id TEXT,rights_snapshot_json TEXT);
    CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,order_item_id TEXT NOT NULL,
    entitlement_type TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL)`);
  const ids={orderId:"order_paid_journey_17",userId:"buyer_paid_journey_17",
    productId:"prd_journey_paid_17",
    entitlementId:"179ecf1a-8f46-4d34-9db4-452e79d8be0f"};
  const commercial={productId:ids.productId,editionId:"ed_journey_paid_17",
    territory:"US",channel:"retail",grantId:"grant_journey_17",
    contractId:"contract_journey_17",contractVersionId:"contract_version_journey_17",
    validUntil:new Date(Date.now()+900000).toISOString()};
  const acquisition={grantId:commercial.grantId,editionId:commercial.editionId,
    contractId:commercial.contractId,contractVersionId:commercial.contractVersionId,
    territory:"US",salesChannel:"retail"};
  canonical.prepare("INSERT INTO commerce_orders VALUES(?,?,?,'paid')")
    .run(ids.orderId,ids.userId,"US");
  canonical.prepare(`INSERT INTO commerce_order_items(
    id,order_id,product_id,sales_channel,entitlement_status,
    preorder_id,rights_grant_id,rights_snapshot_json)
    VALUES(?,?,?,?,?,NULL,?,?)`)
    .run("item_paid_journey_17",ids.orderId,ids.productId,"retail",
      "granted",commercial.grantId,JSON.stringify(acquisition));
  canonical.prepare("INSERT INTO entitlements VALUES(?,?,?,?,?,?,?)")
    .run(ids.entitlementId,ids.userId,ids.productId,"item_paid_journey_17",
      "purchase","commerce","active");
  assert.deepEqual(rights.publishFreshCommercialProof(sql,commercial,0),
    {applied:true,epoch:1},"Owner product rights start only with verified paid legal scope");
  const database={prepare(statement){return {
    bind(...args){const query=canonical.prepare(statement);
      return {first:async()=>query.get(...args)||null,
        all:async()=>({results:query.all(...args)})};}
  }}};
  let calls=[],ownerOutage=false;
  const stub={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(request){
      if(ownerOutage)throw Error("unavailable");
      assert.equal(request.headers.get("authorization"),"Bearer "+"a".repeat(64));
      const endpoint=new URL(request.url).pathname;
      const payload=await request.json();
      calls.push(endpoint);
      if(endpoint==="/commercial/entitlement/authorize"){
        const proof=buyers.readPaidAccess(sql,payload);
        return Response.json({schema:"cove.paid-access.v1",allowed:!!proof,proof});
      }
      if(endpoint==="/commercial/entitlement/publish-verified"){
        // Model the real server's independent canonical identity/paid evidence
        // verification rather than accepting arbitrary caller-provided grants.
        const ent=canonical.prepare("SELECT * FROM entitlements WHERE id=? AND user_id=? AND product_id=?")
          .get(payload.entitlementId,payload.userId,payload.productId);
        const item=ent&&canonical.prepare("SELECT * FROM commerce_order_items WHERE id=?")
          .get(ent.order_item_id);
        const order=item&&canonical.prepare("SELECT * FROM commerce_orders WHERE id=?")
          .get(item.order_id);
        const legal=rights.readCommercialProofs(sql,[payload.productId],
          payload.territory,payload.channel);
        const purchased=item&&JSON.parse(item.rights_snapshot_json);
        if(!ent||ent.status!=="active"||ent.source!=="commerce"||
           ent.entitlement_type!=="purchase"||!item||!order||
           order.status!=="paid"||order.user_id!==payload.userId||
           item.entitlement_status!=="granted"||legal.length!==1||
           purchased.grantId!==legal[0].grant_id||
           purchased.contractId!==legal[0].contract_id||
           purchased.contractVersionId!==legal[0].contract_version_id)
          return new Response(null,{status:409});
        const current=buyers.captureEntitlementEpoch(sql,payload);
        try{
          authority.exec("BEGIN IMMEDIATE");
          const receipt=buyers.publishFreshEntitlement(sql,{
            ...payload,orderId:order.id,productEpoch:legal[0].epoch,
            validUntil:new Date(Date.now()+90000).toISOString()
          },current);
          authority.exec("COMMIT");
          return Response.json(receipt);
        }catch{
          authority.exec("ROLLBACK");
          return new Response(null,{status:409});
        }
      }
      return new Response(null,{status:404});
    }};
  }};
  const env={
    DB:database,LEGAL_AUTHORITY:stub,
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64)
  };
  const consumer=()=>protectedAccess.requireStagePaidEntitlementAccess(env,{
    userId:ids.userId,productId:ids.productId,
    entitlementId:ids.entitlementId,territory:"US",channel:"retail"
  });
  await assert.rejects(consumer(),e=>e.status===451,
    "A paid D1 ledger does not itself authorize protected EPUB or audio");
  await settlement.certifyStagePaidSettlement(env,ids.orderId,ids.userId);
  await consumer();
  await settlement.certifyStagePaidSettlement(env,ids.orderId,ids.userId);
  await consumer();
  assert.equal(buyers.readPaidAccess(sql,{
    ...ids,territory:"US",channel:"retail"
  })?.order_id,ids.orderId,"Buyer proof is bound to exactly one settled order");
  ownerOutage=true;
  await assert.rejects(consumer(),e=>e.status===503,
    "Owner outage cannot fall back to previously granted buyer rights");
  ownerOutage=false;
  rights.denyCommercialSubject(sql,{subjectKind:"contract",
    subjectId:commercial.contractId,operationId:"qa:journey:contract-withdraw"});
  await assert.rejects(consumer(),e=>e.status===451,
    "Contract-level withdrawal instantly prevents protected bytes");
  await assert.rejects(settlement.certifyStagePaidSettlement(env,ids.orderId,ids.userId),
    e=>e.status===503,"A signed webhook replay cannot revive an invalid commercial grant");
  buyers.denyPaidOrder(sql,{orderId:ids.orderId,operationId:"qa:journey:refund"});
  canonical.prepare("UPDATE commerce_orders SET status='refunded' WHERE id=?")
    .run(ids.orderId);
  canonical.prepare("UPDATE entitlements SET status='revoked' WHERE id=?")
    .run(ids.entitlementId);
  await assert.rejects(consumer(),e=>e.status===451,
    "Refund denies delivery independently of lagging D1 reconciliation");
  await assert.rejects(settlement.certifyStagePaidSettlement(env,ids.orderId,ids.userId),
    e=>e.status===409,"A refunded order can never republish a positive entitlement");
  assert.ok(calls.includes("/commercial/entitlement/publish-verified"));
  assert.ok(calls.includes("/commercial/entitlement/authorize"));
  authority.close();canonical.close();
  console.log("PASS: staged paid canonical settlement -> real SQLite owner buyer proof -> protected delivery -> contract withdrawal -> refund -> signed replay cannot restore access");
}finally{rmSync(dir,{recursive:true,force:true});}
