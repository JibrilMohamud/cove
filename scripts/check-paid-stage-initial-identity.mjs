/* eslint-disable prettier/prettier -- Exact isolated paid QA identity boundary regression. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {QA_PAID_D1,PRODUCTION_D1} from "./staging/paid-qa-cloudflare-credentials.mjs";

// Exercise the real deployed-stage Worker entrypoint, not a reimplemented
// regex or a mock authorization function. No Cloudflare or Stripe resources.
const dir=mkdtempSync(path.join(os.tmpdir(),"cove-paid-stage-identity-"));
try{
  const outfile=path.join(dir,"stage.mjs");
  await build({entryPoints:["src/storefront-strangler/paid-settlement-stage-qa.worker.ts"],
    outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {default:worker}=await import(pathToFileURL(outfile).href);
  let dbReads=0,ownerCalls=0;
  const run="40764579032-2";
  const initialOrder="order_initial_qa_"+run;
  const initialBuyer="user_initial_qa_"+run;
  const env={
    COVE_PAID_STAGE_QA_ENABLED:"1",
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_PAID_STAGE_QA_GATE:"a".repeat(64),
    COVE_RIGHTS_OWNER_SECRET:"b".repeat(64),
    COVE_PAID_STAGE_QA_EXPIRES_AT:String(Date.now()+60000),
    COVE_PAID_INITIAL_ORDER:initialOrder,COVE_PAID_INITIAL_BUYER:initialBuyer,
    LEGAL_PRIVATE:{async fetch(){ownerCalls++;throw Error("unpaid buyer must not invoke owner");}},
    PRIMARY_DB:{prepare(sql){
      assert.match(sql,/SELECT e.id FROM entitlements e/);
      return {bind(...params){
        assert.deepEqual(params.slice(0,2),[initialOrder,initialBuyer]);
        return {async all(){dbReads++;return {results:[]};}};
      }};
    }}
  };
  const probe=async(orderId,userId,scope=env)=>{
    const request=new Request("https://private.stage.invalid/authorize-initial",{
      method:"POST",headers:{"content-type":"application/json",
        authorization:"Bearer "+scope.COVE_PAID_STAGE_QA_GATE},
      body:JSON.stringify({orderId,userId})
    });
    return (await worker.fetch(request,scope)).status;
  };
  assert.equal(await probe(initialOrder,initialBuyer),451,
    "Fresh attempt-scoped unpaid buyer must be denied as unpaid, not rejected as an invalid fixture");
  assert.equal(dbReads,1,"Valid prepayment denial must read the canonical entitlement");
  assert.equal(await probe("order_initial_qa_40764579032", "user_initial_qa_40764579032"),400,
    "Old non-attempt fixture identities must not be accepted");
  assert.equal(await probe("order_initial_qa_40764579032-1",initialBuyer),400,
    "Another run attempt cannot borrow the current buyer scope");
  assert.equal(await probe(initialOrder,"user_initial_qa_40764579032-3"),400,
    "A mismatched buyer must not reach entitlement authorization");
  assert.equal(await probe(initialOrder,initialBuyer,{...env,COVE_PAID_INITIAL_BUYER:"user_initial_qa_40764579032-3"}),400,
    "A mixed deployment config must reject the buyer");
  assert.equal(dbReads,1,"Only the exact scoped unpaid buyer may reach D1");
  assert.equal(ownerCalls,0,"No unpaid or malformed buyer should reach the owner");
  // Real deployed settlement stage has its own pre-tender and positive owner
  // guards. Both must admit the dedicated *separate-account* QA primary,
  // while the customer production D1 and unknown IDs remain fail-closed.
  // A denied preflight is a successful safety probe: only owner verification
  // may run; neither a Stripe tender nor a database mutation is attempted.
  const paidOrder="order_paid_qa_20261027",paidBuyer="user_paid_qa_20261027";
  async function paidGateProbe(primaryId,route){
    let verified=0,canonicalReads=0;
    const scope={...env,COVE_LEGAL_WRITER_PRIMARY_ID:primaryId,
      PRIMARY_DB:{prepare(sql){
        canonicalReads++;
        assert.match(sql,/SELECT id,user_id,territory_code,status FROM commerce_orders/);
        return {bind(...params){return {async first(){
          assert.deepEqual(params,route==="/certify-paid"?[paidOrder,paidBuyer]:[paidOrder]);
          return null;
        }};}};
      }},
      LEGAL_PRIVATE:{async fetch(request){
        verified++;
        assert.equal(new URL(request.url).pathname,"/commercial/order/verify");
        assert.equal(request.headers.get("authorization"),"Bearer "+env.COVE_RIGHTS_OWNER_SECRET);
        assert.equal((await request.json()).orderId,paidOrder);
        return Response.json({schema:"cove.paid-order-permission.v1",orderId:paidOrder,allowed:false});
      }}
    };
    const req=new Request("https://private.stage.invalid"+route,{
      method:"POST",headers:{"content-type":"application/json",
        authorization:"Bearer "+scope.COVE_PAID_STAGE_QA_GATE},
      body:JSON.stringify({orderId:paidOrder,userId:paidBuyer})
    });
    const response=await worker.fetch(req,scope);
    return {status:response.status,verified,canonicalReads};
  }
  for(const route of ["/preflight-paid","/certify-paid"]){
    const current=await paidGateProbe(QA_PAID_D1,route);
    assert.equal(current.status,409,"Dedicated QA primary must pass stage preflight and reach the canonical safety denial");
    assert.equal(current.verified,route==="/preflight-paid"?1:0,
      "Owner verification precedes any canonical paid preflight DB access");
    assert.equal(current.canonicalReads,route==="/certify-paid"?1:0,
      "Paid settlement must first check the real order, not trust caller payment claims");
    for(const id of [PRODUCTION_D1,"00000000-0000-4000-8000-000000000000"]){
      assert.deepEqual(await paidGateProbe(id,route),{status:503,verified:0,canonicalReads:0},
        "Customer or unreviewed D1 must never enter synthetic settlement");
    }
  }
  // Audit ALL owner-first consumer command boundaries for a shared immutable
  // synthetic D1 predicate. The previous independent hardcoded arrays let
  // checkout preflight succeed but made Stripe/webhook/refunds fail later.
  const lockedModules=["src/storefront-strangler/legal-consumer-fence.server.ts","src/storefront-strangler/owner-paid-settlement.server.ts","src/storefront-strangler/owner-refund-accounting.server.ts","src/storefront-strangler/owner-refund-provider.server.ts","src/storefront-strangler/owner-refund-reservation.server.ts","src/storefront-strangler/owner-stripe-payment-status.server.ts","src/storefront-strangler/owner-stripe-webhook.server.ts","src/storefront-strangler/paid-order-revocation.server.ts","src/storefront-strangler/paid-settlement-publication.server.ts"];
  for(const pathName of lockedModules){
    const code=readFileSync(pathName,"utf8");
    assert.ok(code.includes('import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";'),
      "Owner-first consumer must use the shared audited QA primary allowlist: "+pathName);
    assert.ok(code.includes("!isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)"),
      "Owner-first consumer must reject any unreviewed primary: "+pathName);
    assert.doesNotMatch(code,/const QA_(?:PRIMARY|DB)_IDS=new Set|5e3a6b69|7c7ab994|969f1ea0/,
      "No private payment service may keep a diverging hardcoded QA D1 list: "+pathName);
  }
  const listFile=path.join(dir,"reviewed-paid-qa-primary.mjs");
  await build({entryPoints:["src/storefront-strangler/reviewed-paid-qa-primary.ts"],
    outfile:listFile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent"});
  const {isReviewedPaidQaPrimary}=await import(pathToFileURL(listFile).href);
  for(const id of ["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",QA_PAID_D1])
    assert.equal(isReviewedPaidQaPrimary(id),true,"Only reviewed synthetic primaries allowed");
  for(const id of [PRODUCTION_D1,"00000000-0000-4000-8000-000000000000",null,undefined,""])
    assert.equal(isReviewedPaidQaPrimary(id),false,"No customer/unknown primary permitted");
  console.log("PASS: all nine owner-first settlement, webhook, consumer and refund gates share one exact QA-only D1 predicate");
  console.log("PASS: dedicated separate-account paid QA primary reaches both safe owner stages; production and unknown D1 deny before all effects");
  console.log("PASS: real paid QA Worker rejects cross-run/buyer identities and denies attempt-scoped unpaid delivery");
}finally{rmSync(dir,{recursive:true,force:true});}
