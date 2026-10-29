/* eslint-disable prettier/prettier -- Adversarial replay/scope tests for exact owner-fenced Stripe refund provider observations. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

const dir=mkdtempSync(join(tmpdir(),"cove-refund-provider-owner-"));
try{
  const outfile=join(dir,"executor.mjs");
  await build({entryPoints:["src/storefront-strangler/refund-provider-owner-executor.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {executeOwnerRefundProvider:exec}=await import(pathToFileURL(outfile).href);
  const orderId="order_ref_provider_01",refundId="ref_provider_01",providerRefundId="re_proof_123456789";
  const request={orderId,refundId,providerRefundId,status:"succeeded"};
  const fixture=({denied=true,priorProvider=null,priorStatus="pending",postedAt=null,writeFailure=false,wrongOrder=false}={})=>{
    let writes=0;
    const row={id:refundId,order_id:wrongOrder?"order_someone_else":orderId,
      provider_refund_id:priorProvider,status:priorStatus,succeeded_at:postedAt};
    const db={prepare(sql){return{bind(...args){return{
      async first(){return {...row};},
      async run(){
        if(writeFailure)throw Error("canonical_d1_unavailable");
        assert.match(sql,/WHERE id=\? AND order_id=\?/);
        assert.equal(args[3],refundId);
        assert.equal(args[4],orderId);
        assert.ok(!row.provider_refund_id||row.provider_refund_id===args[0]);
        row.provider_refund_id=args[0];
        row.status=args[1];writes++;
        return {success:true,meta:{changes:1}};
      }}}}}};
    const ownerSql={exec(sql,...args){
      assert.match(sql,/cove_paid_refunded_orders/);
      assert.deepEqual(args,[orderId]);
      return {toArray:()=>denied?[{ok:1}]:[]};
    }};
    return{db,ownerSql,row,counts:()=>writes};
  };
  const live=fixture(),ack=await exec(live.db,live.ownerSql,request);
  assert.deepEqual(ack,{schema:"cove.owner-refund-provider.v1",ownerDenied:true,recorded:true,
    orderId,refundId,providerRefundId,status:"succeeded"});
  assert.equal(live.counts(),1);
  assert.deepEqual(await exec(live.db,live.ownerSql,request),ack);
  assert.equal(live.counts(),1,"Exact same provider receipt must be replay-safe");
  for(const bad of [
    {...request,orderId:"order_other_scope"},
    {...request,providerRefundId:"re_changed_provider_id"},
    {...request,status:"succeeded",arbitrarySql:"UPDATE commerce_orders"},
    {...request,status:"authorized"},
    {...request,refundId:"../ref"},
    {...request,providerRefundId:"internal_fake"},
  ]){
    await assert.rejects(()=>exec(live.db,live.ownerSql,bad));
    assert.equal(live.counts(),1);
  }
  for(const f of [
    fixture({denied:false}),fixture({wrongOrder:true}),
    fixture({priorProvider:"re_other_provider"})
  ])await assert.rejects(()=>exec(f.db,f.ownerSql,request));
  const failed=fixture({writeFailure:true});
  await assert.rejects(()=>exec(failed.db,failed.ownerSql,request),/canonical_d1_unavailable/);
  assert.equal(failed.counts(),0);
  const completed=fixture({priorProvider:providerRefundId,priorStatus:"succeeded",postedAt:"2026-10-29T00:00:00Z"});
  const replay=await exec(completed.db,completed.ownerSql,{...request,status:"pending"});
  assert.equal(replay.status,"succeeded");
  assert.equal(completed.counts(),0,"Posted refund must not regress under stale provider webhook");
  const noDowngrade=fixture({priorProvider:providerRefundId,priorStatus:"succeeded"});
  assert.equal((await exec(noDowngrade.db,noDowngrade.ownerSql,{...request,status:"pending"})).status,"succeeded");
  assert.equal(noDowngrade.counts(),0);
  const commerce=readFileSync("src/features/fore/commerce.server.ts","utf8");
  assert.ok(commerce.includes("await recordStageOwnerRefundProvider("));
  assert.match(commerce,/if \(env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED === "1"\)/);
  assert.match(commerce,/await stageRevokeRefundEntitlements\(env, String\(r\.order_id\), String\(r\.id\)\);/);
  console.log("PASS: refund provider owner command rejects scope/provider collisions and forged SQL, serializes durable-denied writes, remains replay-safe and never regresses posted refunds");
}finally{rmSync(dir,{recursive:true,force:true});}
